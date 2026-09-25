import { AppError } from "./errors.js";

const DEFAULT_OPENROUTER_MODEL = "~typesafe/jev-latest";
const DEFAULT_LOCAL_MODEL = "kev-latest";
const MAX_RESPONSE_BYTES = 256 * 1024;
const OPENROUTER_TIMEOUT_MS = 15_000;
const LOCAL_TIMEOUT_MS = 120_000;
const MAX_LOCAL_TIMEOUT_MS = 120_000;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function resolveDecisionProvider(env = process.env) {
  const rawEndpoint = env.JEV_SOCIAL_SYSTEM_ONE_URL?.trim();
  if (!rawEndpoint) {
    return {
      kind: "openrouter",
      model: cleanModel(env.OPENROUTER_JEV_MODEL, DEFAULT_OPENROUTER_MODEL),
    };
  }

  return {
    kind: "local",
    endpoint: normalizeLoopbackEndpoint(rawEndpoint),
    model: cleanModel(env.JEV_SOCIAL_SYSTEM_ONE_MODEL, DEFAULT_LOCAL_MODEL),
    timeoutMs: cleanTimeout(env.JEV_SOCIAL_SYSTEM_ONE_TIMEOUT_MS, LOCAL_TIMEOUT_MS),
  };
}

export async function requestDecision({
  provider = { kind: "openrouter", model: DEFAULT_OPENROUTER_MODEL },
  apiKey,
  request,
  fetchImpl = fetch,
  signal,
  timeoutMs,
}) {
  const local = provider?.kind === "local";
  const endpoint = local
    ? normalizeLoopbackEndpoint(provider.endpoint)
    : "https://openrouter.ai/api/alpha/decisions";
  if (!local && !apiKey?.trim()) throw new Error("OPENROUTER_API_KEY is missing");

  const headers = { "Content-Type": "application/json" };
  if (local) headers["X-Title"] = "jev-social-local";
  else {
    headers.Authorization = `Bearer ${apiKey.trim()}`;
    headers["X-Title"] = "jev-social";
  }

  const providerTimeoutMs = local ? provider.timeoutMs ?? LOCAL_TIMEOUT_MS : OPENROUTER_TIMEOUT_MS;
  const maximumTimeoutMs = local ? MAX_LOCAL_TIMEOUT_MS : OPENROUTER_TIMEOUT_MS;
  const boundedTimeoutMs = Math.min(maximumTimeoutMs, cleanTimeout(timeoutMs, providerTimeoutMs));
  const timedSignal = createTimedSignal(signal, boundedTimeoutMs);
  let response;
  let raw;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      redirect: "error",
      signal: timedSignal.signal,
    });
    raw = await readBoundedText(response);
  } finally {
    timedSignal.cleanup();
  }
  let payload;
  try {
    payload = JSON.parse(raw || "{}");
  } catch {
    throw new Error(`${local ? "Local System One" : "OpenRouter"} returned invalid JSON`);
  }
  if (!response.ok) {
    throw new Error(`${local ? "Local System One" : "OpenRouter"} returned HTTP ${response.status}`);
  }
  return payload;
}

function normalizeLoopbackEndpoint(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw invalidProvider();
  }
  const normalizedPath = url.pathname.replace(/\/+$/u, "") || "/";
  if (
    url.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    normalizedPath !== "/v1/systemone"
  ) {
    throw invalidProvider();
  }
  url.pathname = "/v1/systemone";
  return url.href;
}

function invalidProvider() {
  return new AppError(
    "Invalid local System One endpoint. Use http://127.0.0.1:<port>/v1/systemone.",
    { code: "INVALID_DECISION_PROVIDER" },
  );
}

function cleanModel(value, fallback) {
  const model = String(value || fallback).trim();
  if (!model || model.length > 160 || !/^[A-Za-z0-9._~:@/-]+$/u.test(model)) {
    throw new AppError("Invalid decision model name.", { code: "INVALID_DECISION_PROVIDER" });
  }
  return model;
}

function cleanTimeout(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_LOCAL_TIMEOUT_MS) {
    throw new AppError(`Invalid local decision timeout. Use 1-${MAX_LOCAL_TIMEOUT_MS} milliseconds.`, {
      code: "INVALID_DECISION_PROVIDER",
    });
  }
  return timeout;
}

function createTimedSignal(signal, timeoutMs) {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forwardAbort);
    },
  };
}

async function readBoundedText(response) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error("Decision provider returned an oversized response");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error("Decision provider returned an oversized response");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
