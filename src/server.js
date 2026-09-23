import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, realpath, stat } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSearch } from "./app.js";
import { getConfigPath, readConfig, resolveApiKey } from "./config.js";
import { errorPayload } from "./errors.js";
import { loadLocalEnv } from "./env.js";
import { saveOnboarding } from "./onboard.js";
import { listRuns, markInterruptedRuns, readRun } from "./runs.js";
import { probeSocai } from "./socai.js";

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const MEDIA_TTL_MS = 60 * 60_000;
const STATIC_FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/evidence-preview.js": ["evidence-preview.js", "text/javascript; charset=utf-8"],
  "/run-route.js": ["run-route.js", "text/javascript; charset=utf-8"],
  "/prompts.js": ["prompts.js", "text/javascript; charset=utf-8"],
  "/status.js": ["status.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
  "/report-download.js": ["report-download.js", "text/javascript; charset=utf-8"],
  "/platforms/instagram.png": ["platforms/instagram.png", "image/png"],
  "/platforms/tiktok.png": ["platforms/tiktok.png", "image/png"],
  "/platforms/linkedin.svg": ["platforms/linkedin.svg", "image/svg+xml"],
};

export async function startServer({ port = 8766, open = true, env = process.env } = {}) {
  await loadLocalEnv(env);
  await markInterruptedRuns(env);
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort < 0 || numericPort > 65_535) {
    throw new Error("port must be an integer between 0 and 65535");
  }

  const mediaRegistry = new Map();
  const server = http.createServer((request, response) => {
    void handleRequest(request, response, env, mediaRegistry);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(numericPort, "127.0.0.1", resolve);
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : numericPort;
  const url = `http://127.0.0.1:${actualPort}`;
  console.log(`jev-social preview: ${url}`);
  if (open) openBrowser(url);
  return { server, url, accessUrl: url };
}

async function handleRequest(request, response, env, mediaRegistry) {
  try {
    if (!validHost(request.headers.host)) {
      return sendJson(response, 403, { error: { code: "INVALID_HOST", message: "Invalid Host header." } });
    }
    const url = new URL(request.url, "http://127.0.0.1");
    const mediaMatch = request.method === "GET" && url.pathname.match(/^\/media\/([A-Za-z0-9_-]+)$/);
    if (mediaMatch) {
      const media = mediaFromRegistry(mediaRegistry, mediaMatch[1]);
      return media
        ? await serveMedia(request, response, media)
        : sendJson(response, 404, { error: { code: "MEDIA_NOT_FOUND", message: "Media not found." } });
    }
    if (request.method === "GET" && url.pathname === "/favicon.ico") {
      response.writeHead(204, { "Cache-Control": "public, max-age=86400" });
      return response.end();
    }
    if (request.method === "GET" && STATIC_FILES[url.pathname]) {
      const [filename, contentType] = STATIC_FILES[url.pathname];
      const content = await readFile(path.join(PUBLIC_DIR, filename));
      response.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "default-src 'self'; img-src 'self' https: data:; media-src 'self' https: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      });
      return response.end(content);
    }
    if (request.method === "GET" && url.pathname === "/api/status") {
      let config;
      try {
        config = await readConfig(env);
      } catch {
        return sendJson(response, 200, {
          jevConfigured: false,
          jevModel: env.OPENROUTER_JEV_MODEL || "~typesafe/jev-latest",
          socai: { installed: false, version: null, capabilities: { instagram: false, tiktok: false, linkedin: false } },
          configError: "Configuration could not be read.",
        });
      }
      const socai = await probeSocai(config, env);
      return sendJson(response, 200, {
        jevConfigured: Boolean(resolveApiKey(config, env)),
        jevModel: env.OPENROUTER_JEV_MODEL || "~typesafe/jev-latest",
        socai: {
          installed: socai.installed,
          version: socai.version ?? null,
          capabilities: socai.capabilities,
          ...(socai.error ? { error: socai.error } : {}),
        },
      });
    }
    if (request.method === "POST" && url.pathname === "/api/onboard") {
      assertSameOrigin(request);
      const body = await readJson(request);
      validateOnboardBody(body);
      const result = await saveOnboarding({
        apiKey: body.apiKey,
        socaiBin: body.socaiBin,
        installCli: body.installCli ?? false,
        verify: body.verify !== false,
        persistApiKey: Boolean(body.apiKey?.trim()),
        env,
        onMessage: (message) => console.log(`[onboard] ${message}`),
      });
      return sendJson(response, 200, result);
    }
    if (request.method === "POST" && url.pathname === "/api/search") {
      assertSameOrigin(request);
      const body = await readJson(request);
      validateSearchBody(body);
      const run = await runSearch(
        { query: body.query, platform: body.platform, limit: body.limit, maxSteps: body.maxSteps },
        { env },
      );
      await registerRunMedia(run, mediaRegistry, env);
      return sendJson(response, 200, run);
    }
    if (request.method === "POST" && url.pathname === "/api/search-stream") {
      assertSameOrigin(request);
      const body = await readJson(request);
      validateSearchBody(body);
      return streamSearch(request, response, body, env, mediaRegistry);
    }
    if (request.method === "GET" && url.pathname === "/api/runs") {
      return sendJson(response, 200, { runs: await listRuns(env) });
    }
    const runMatch = request.method === "GET" && url.pathname.match(/^\/api\/runs\/([A-Za-z0-9_.-]+)$/);
    if (runMatch) {
      const run = await readRun(runMatch[1], env);
      if (run) await registerRunMedia(run, mediaRegistry, env);
      return run
        ? sendJson(response, 200, run)
        : sendJson(response, 404, { error: { code: "RUN_NOT_FOUND", message: "Run not found." } });
    }
    return sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Not found." } });
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    if (status >= 500) console.error(error);
    return sendJson(response, status, errorPayload(error));
  }
}

async function streamSearch(request, response, body, env, mediaRegistry) {
  response.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Accel-Buffering": "no",
  });
  const write = (value) => {
    if (!response.destroyed && !response.writableEnded) response.write(`${JSON.stringify(value)}\n`);
  };
  const controller = new AbortController();
  const abort = () => controller.abort();
  const abortIfOpen = () => {
    if (!response.writableEnded) abort();
  };
  request.once("aborted", abort);
  response.once("close", abortIfOpen);
  try {
    const run = await runSearch(
      { query: body.query, platform: body.platform, limit: body.limit, maxSteps: body.maxSteps },
      { env, onEvent: write, signal: controller.signal },
    );
    await registerRunMedia(run, mediaRegistry, env);
    write({ stage: "result", run });
  } catch (error) {
    write({ stage: "error", ...errorPayload(error) });
  } finally {
    request.removeListener("aborted", abort);
    response.removeListener("close", abortIfOpen);
    response.end();
  }
}

async function registerRunMedia(run, registry, env) {
  pruneMediaRegistry(registry);
  const roots = await allowedMediaRoots(env);
  const visit = async (value) => {
    if (Array.isArray(value)) {
      await Promise.all(value.map(visit));
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key.endsWith("local_path") && typeof child === "string") {
        const media = await verifiedMedia(child, roots);
        if (media) {
          let entry = [...registry.entries()].find(([, existing]) =>
            existing.path === media.path && existing.dev === media.dev && existing.ino === media.ino,
          );
          if (!entry) {
            const id = crypto.randomBytes(18).toString("base64url");
            entry = [id, { ...media, expiresAt: Date.now() + MEDIA_TTL_MS }];
            registry.set(...entry);
          } else {
            entry[1].expiresAt = Date.now() + MEDIA_TTL_MS;
          }
          const browserKey = key === "local_path" ? "browser_url" : key.replace(/_local_path$/, "_browser_url");
          value[browserKey] = `/media/${entry[0]}`;
        }
      } else {
        await visit(child);
      }
    }
  };
  await visit(run?.result);
}

async function allowedMediaRoots(env) {
  const candidates = [
    env.SOCAI_RUNS_DIR,
    env.SOCAI_HOME && path.join(env.SOCAI_HOME, "runs"),
    path.join(env.HOME || os.homedir(), ".socai", "runs"),
  ].filter(Boolean);
  return Promise.all(candidates.map(async (candidate) => realpath(candidate).catch(() => path.resolve(candidate))));
}

async function verifiedMedia(candidate, roots) {
  try {
    const resolved = await realpath(candidate);
    if (!roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) return null;
    const metadata = await stat(resolved);
    if (!metadata.isFile() || metadata.size <= 0) return null;
    return { path: resolved, size: metadata.size, dev: metadata.dev, ino: metadata.ino, type: mediaType(resolved) };
  } catch {
    return null;
  }
}

function mediaFromRegistry(registry, id) {
  const media = registry.get(id);
  if (!media) return null;
  if (media.expiresAt <= Date.now()) {
    registry.delete(id);
    return null;
  }
  return media;
}

function pruneMediaRegistry(registry) {
  const now = Date.now();
  for (const [id, media] of registry) if (media.expiresAt <= now) registry.delete(id);
}

async function serveMedia(request, response, media) {
  let handle;
  try {
    handle = await open(media.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.dev !== media.dev || metadata.ino !== media.ino || metadata.size !== media.size) {
      await handle.close();
      return sendJson(response, 410, { error: { code: "MEDIA_CHANGED", message: "Media changed after capture." } });
    }
  } catch {
    await handle?.close().catch(() => {});
    return sendJson(response, 410, { error: { code: "MEDIA_UNAVAILABLE", message: "Media is no longer available." } });
  }
  const range = request.headers.range;
  if (!range) {
    response.writeHead(200, {
      "Content-Type": media.type,
      "Content-Length": media.size,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    });
    return pipeFileHandle(handle, response);
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    response.writeHead(416, { "Content-Range": `bytes */${media.size}` });
    await handle.close();
    return response.end();
  }
  const start = match[1] ? Number(match[1]) : Math.max(0, media.size - Number(match[2] || 0));
  const end = match[2] && match[1] ? Math.min(Number(match[2]), media.size - 1) : media.size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || start >= media.size) {
    response.writeHead(416, { "Content-Range": `bytes */${media.size}` });
    await handle.close();
    return response.end();
  }
  response.writeHead(206, {
    "Content-Type": media.type,
    "Content-Length": end - start + 1,
    "Content-Range": `bytes ${start}-${end}/${media.size}`,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
  });
  return pipeFileHandle(handle, response, { start, end });
}

function pipeFileHandle(handle, response, options = {}) {
  const stream = handle.createReadStream({ ...options, autoClose: true });
  stream.on("error", () => {
    if (!response.destroyed) response.destroy();
  });
  response.on("close", () => stream.destroy());
  stream.pipe(response);
  return stream;
}

function mediaType(filename) {
  const extension = path.extname(filename).toLowerCase();
  return ({
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".m4a": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
  })[extension] || "application/octet-stream";
}

function validHost(host = "") {
  const hostname = host.split(":")[0].replace(/^\[|\]$/g, "");
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function assertSameOrigin(request) {
  const origin = request.headers.origin;
  const expected = `http://${request.headers.host}`;
  try {
    if (!origin || new URL(origin).origin !== expected) throw new Error("mismatch");
  } catch {
    throw httpError(403, "INVALID_ORIGIN", "Cross-origin request rejected.");
  }
}

async function readJson(request) {
  const contentType = request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw httpError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json.");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) {
      throw httpError(413, "BODY_TOO_LARGE", "Request body is too large.");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw httpError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
}

function validateOnboardBody(body) {
  assertObject(body);
  optionalType(body, "apiKey", "string");
  optionalType(body, "socaiBin", "string");
  optionalType(body, "installCli", "boolean");
  optionalType(body, "verify", "boolean");
}

function validateSearchBody(body) {
  assertObject(body);
  if (typeof body.query !== "string") throw httpError(400, "INVALID_BODY", "query must be a string.");
  optionalType(body, "platform", "string");
  optionalType(body, "limit", "number");
  optionalType(body, "maxSteps", "number");
}

function assertObject(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpError(400, "INVALID_BODY", "Request body must be a JSON object.");
  }
}

function optionalType(body, key, type) {
  if (body[key] !== undefined && typeof body[key] !== type) {
    throw httpError(400, "INVALID_BODY", `${key} must be a ${type}.`);
  }
}

function httpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function sendJson(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function openBrowser(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", (error) => console.warn(`Could not open browser automatically: ${error.message}`));
  child.unref();
}
