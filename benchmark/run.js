#!/usr/bin/env node

import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { sourceUrl } from "../src/actions.js";
import { getPrivateRunMedia, runSearch } from "../src/app.js";
import { readConfig, resolveApiKey } from "../src/config.js";
import { loadLocalEnv } from "../src/env.js";
import { listRuns, readRun } from "../src/runs.js";
import { probeSocai } from "../src/socai.js";
import {
  BENCHMARK_CONDITIONS,
  BENCHMARK_PLATFORMS,
  BENCHMARK_PROFILE_MODES,
  validateBenchmarkRow,
} from "./schema.js";

const TASK_FIELDS = new Set(["task_id", "platform", "goal", "result_limit", "max_steps"]);
const MAX_TASK_BYTES = 16 * 1024;
const MEDIA_EXTENSIONS = new Set([
  ".avif", ".gif", ".jpeg", ".jpg", ".m4v", ".mov", ".mp4", ".png", ".webm", ".webp",
]);
const FLOATING_MODEL = /(?:^~|(?:^|[/_.-])latest(?=$|[:/_.-]))/i;

const HELP = `jev-social benchmark runner

Usage:
  node benchmark/run.js --task <file> --jev-model <id> --socai-version <semver> \\
    --socai-commit <sha> --profile-mode <existing|isolated> --region <id> \\
    --condition <cold|warm>

The command writes exactly one validated, privacy-safe NDJSON row to stdout.
Progress stages go to stderr. Runtime failures are retained as failed or partial
rows instead of being silently dropped.
`;

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const requiredString = (value, name, { max = 512, pattern } = {}) => {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > max || /[\u0000-\u001f\u007f]/.test(cleaned)) {
    throw new TypeError(`${name} has an invalid format`);
  }
  if (pattern && !pattern.test(cleaned)) throw new TypeError(`${name} has an invalid format`);
  return cleaned;
};

const requiredInteger = (value, name, min, max) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
};

const pinnedModel = (value) => {
  const model = requiredString(value, "jev_model", { max: 128 });
  if (FLOATING_MODEL.test(model)) {
    throw new TypeError("jev_model must be an immutable model identifier, not a latest alias");
  }
  return model;
};

export function validateBenchmarkTask(value) {
  if (!isRecord(value)) throw new TypeError("benchmark task must be an object");
  for (const key of Object.keys(value)) {
    if (!TASK_FIELDS.has(key)) throw new TypeError(`${key}: unknown field`);
  }
  for (const key of TASK_FIELDS) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${key}: field is required`);
  }
  const taskId = requiredString(value.task_id, "task_id", {
    max: 36,
    pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  }).toLowerCase();
  if (!BENCHMARK_PLATFORMS.includes(value.platform)) {
    throw new TypeError(`platform must be one of: ${BENCHMARK_PLATFORMS.join(", ")}`);
  }
  return {
    task_id: taskId,
    platform: value.platform,
    goal: requiredString(value.goal, "goal"),
    result_limit: requiredInteger(value.result_limit, "result_limit", 1, 100),
    max_steps: requiredInteger(value.max_steps, "max_steps", 1, 30),
  };
}

const numericDuration = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;

const publicItems = (run) => Array.isArray(run?.result?.items) ? run.result.items : [];

const commentCount = (items) => items.reduce((total, item) => {
  const comments = Array.isArray(item?.top_comments)
    ? item.top_comments
    : Array.isArray(item?.comments)
      ? item.comments
      : [];
  return total + comments.length;
}, 0);

const runtimeCode = (run, error) => {
  if (typeof error?.code === "string") return error.code;
  if (typeof error?.name === "string" && /abort|interrupt/i.test(error.name)) return error.name;
  const failed = [...(run?.actions || [])].reverse().find((entry) => entry?.status === "failed");
  return typeof failed?.observation?.code === "string" ? failed.observation.code : "";
};

const terminalState = (run, error, records) => {
  const status = run?.status;
  const text = String(run?.stopReason || "").toLowerCase();
  const code = runtimeCode(run, error).toUpperCase();
  let stopReason;

  if (!error && status === "completed" && records > 0) stopReason = "goal_satisfied";
  else if (status === "step_limit") stopReason = "step_limit";
  else if (status === "interrupted" || /ABORT|INTERRUPT/.test(code)) {
    stopReason = "interrupted";
  }
  else if (
    status === "decision_failed"
    || /JEV|DECISION|CLASSIFICATION|ONBOARDING|UNSUPPORTED_TASK|LOW_ACTION|MODEL_PIN/.test(code)
  ) {
    stopReason = "decision_failed";
  } else if (/login_required|\blogin\b|sign.?in/.test(text)) {
    stopReason = "login_required";
  } else if (/challenge_required|captcha|challenge/.test(text)) {
    stopReason = "challenge_required";
  } else if (/rate_limited|rate.?limit/.test(text)) {
    stopReason = "rate_limited";
  } else if (run?.reportStatus === "failed" || /REPORT/.test(code)) {
    stopReason = "report_failed";
  } else if (/VIDEO_CAPABILITY|MEDIA/.test(code)) {
    stopReason = "media_unavailable";
  } else if (/^(?:BROWSER_|REMOTE_SESSION_)/.test(code)) {
    stopReason = "browser_unavailable";
  } else if (/SOCAI_VERSION_|CAPABILITY|NOT_FOUND/.test(code)) {
    stopReason = "capability_unavailable";
  } else if (
    /TIMEOUT|SOCAI_FAILED|SOCAI_OUTPUT_TOO_LARGE|(?:EMPTY|INVALID)_SOCAI_OUTPUT|CLI/.test(code)
  ) {
    stopReason = "cli_failed";
  } else if (/NETWORK|FETCH/.test(code)) {
    stopReason = "network_error";
  } else if (records === 0 && run) {
    stopReason = "empty_results";
  } else {
    stopReason = "unknown";
  }

  const failureCategory = {
    step_limit: "step_limit",
    login_required: "access_gate",
    challenge_required: "access_gate",
    rate_limited: "access_gate",
    empty_results: "empty_results",
    capability_unavailable: "unavailable",
    browser_unavailable: "unavailable",
    media_unavailable: "unavailable",
    decision_failed: "execution_error",
    cli_failed: "execution_error",
    network_error: "execution_error",
    report_failed: "execution_error",
    interrupted: "interrupted",
    unknown: "unknown",
  }[stopReason];

  return {
    outcome: stopReason === "goal_satisfied" ? "success" : records > 0 ? "partial" : "failed",
    stopReason,
    failureCategory: stopReason === "goal_satisfied" ? null : failureCategory,
  };
};

const decisionTimings = (run, expectedModel, error) => {
  const decisions = [
    run?.classification && {
      model: run?.classification.model,
      modelVerified: run?.classification.modelVerified,
      elapsedMs: run?.classification.elapsedMs,
    },
    ...(Array.isArray(run?.actions)
      ? run.actions.map((entry) => ({
          model: entry?.model,
          modelVerified: entry?.modelVerified,
          elapsedMs: entry?.jevElapsedMs,
        }))
      : []),
    ...(Array.isArray(run?.decisionFailures)
      ? run.decisionFailures.map((entry) => ({ ...entry, failed: true }))
      : []),
    ...(!run?.decisionFailures?.length && Number.isSafeInteger(error?.details?.elapsedMs)
      ? [{
          model: error.details.model,
          modelVerified: error.details.modelVerified,
          elapsedMs: error.details.elapsedMs,
          failed: true,
        }]
      : []),
  ]
    .filter((entry) => entry && Number.isSafeInteger(entry.elapsedMs))
    .map((entry) => ({
      model: entry.model,
      modelVerified: entry.modelVerified,
      failed: Boolean(entry.failed),
      elapsedMs: numericDuration(entry.elapsedMs),
    }));
  for (const decision of decisions) {
    if (decision.model && decision.model !== expectedModel) {
      const mismatch = new TypeError("resolved decision model does not match the declared benchmark pin");
      mismatch.code = "MODEL_PIN_MISMATCH";
      throw mismatch;
    }
    if (!decision.failed && decision.modelVerified === false) {
      const unverified = new TypeError("decision provider did not report the resolved model");
      unverified.code = "MODEL_PIN_UNVERIFIED";
      throw unverified;
    }
  }
  return decisions.map(({ elapsedMs }) => elapsedMs);
};

const retainMeasuredRunForPinFailure = (run, expectedModel) => {
  if (!run) return undefined;
  const normalizeDecision = (entry, elapsedKey) => {
    if (!entry || !Number.isSafeInteger(entry[elapsedKey])) return entry;
    return { ...entry, model: expectedModel, modelVerified: true };
  };
  return {
    ...run,
    classification: normalizeDecision(run.classification, "elapsedMs"),
    actions: Array.isArray(run.actions)
      ? run.actions.map((entry) => normalizeDecision(entry, "jevElapsedMs"))
      : run.actions,
    decisionFailures: Array.isArray(run.decisionFailures)
      ? run.decisionFailures.map((entry) => normalizeDecision(entry, "elapsedMs"))
      : run.decisionFailures,
  };
};

export function buildBenchmarkRow({
  task: taskInput,
  metadata,
  run,
  error,
  startedAt,
  endedAt,
  totalMs,
  runId = crypto.randomUUID(),
  media = { count: 0, bytes: 0 },
}) {
  const task = validateBenchmarkTask(taskInput);
  const model = pinnedModel(metadata?.jev_model);
  const items = publicItems(run);
  const terminal = terminalState(run, error, items.length);
  const jevSteps = decisionTimings(run, model, error);
  const actions = Array.isArray(run?.actions) ? run.actions : [];
  const socaiBrowserMs = actions.reduce(
    (sum, entry) => sum + numericDuration(entry?.elapsedMs),
    0,
  );
  const mediaMs = actions.reduce(
    (sum, entry) => sum + (entry?.action?.downloadMedia ? numericDuration(entry?.elapsedMs) : 0),
    0,
  );

  return validateBenchmarkRow({
    schema_version: 1,
    run_id: runId,
    task_id: task.task_id,
    started_at: startedAt,
    ended_at: endedAt,
    platform: task.platform,
    outcome: terminal.outcome,
    jev_model: model,
    socai_version: metadata?.socai_version,
    socai_commit: metadata?.socai_commit,
    result_limit: task.result_limit,
    max_steps: task.max_steps,
    profile_mode: metadata?.profile_mode,
    region: metadata?.region,
    condition: metadata?.condition,
    jev_step_latency_ms: jevSteps,
    timing_ms: {
      jev_total: jevSteps.reduce((sum, duration) => sum + duration, 0),
      socai_browser: socaiBrowserMs,
      media: mediaMs,
      total: Math.round(totalMs),
    },
    evidence: {
      records: items.length,
      comments: commentCount(items),
      downloaded_media_count: Number.isSafeInteger(media?.count) ? media.count : 0,
      downloaded_media_bytes: Number.isSafeInteger(media?.bytes) ? media.bytes : 0,
    },
    stop_reason: terminal.stopReason,
    failure_category: terminal.failureCategory,
  });
}

const collectLocalPaths = (value, output = []) => {
  if (Array.isArray(value)) {
    for (const child of value) collectLocalPaths(child, output);
    return output;
  }
  if (!isRecord(value)) return output;
  for (const [key, child] of Object.entries(value)) {
    if (/(?:^|_)local_path$/i.test(key) && typeof child === "string") output.push(child);
    else collectLocalPaths(child, output);
  }
  return output;
};

const allowedMediaRoots = async (env) => {
  const candidates = [
    env.SOCAI_RUNS_DIR,
    env.SOCAI_HOME && path.join(env.SOCAI_HOME, "runs"),
    path.join(env.HOME || os.homedir(), ".socai", "runs"),
  ].filter(Boolean);
  return Promise.all(candidates.map(async (candidate) =>
    realpath(candidate).catch(() => path.resolve(candidate)),
  ));
};

async function collectVerifiedMedia(items, { env = process.env } = {}) {
  const roots = await allowedMediaRoots(env);
  const files = new Map();
  for (const candidate of collectLocalPaths(items)) {
    try {
      const resolved = await realpath(candidate);
      if (!roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) continue;
      if (!MEDIA_EXTENSIONS.has(path.extname(resolved).toLowerCase())) continue;
      const metadata = await stat(resolved);
      if (!metadata.isFile() || metadata.size <= 0) continue;
      files.set(`${metadata.dev}:${metadata.ino}`, metadata.size);
    } catch {
      // Missing, unreadable, and out-of-scope media remain zero-coverage evidence.
    }
  }
  return {
    count: files.size,
    bytes: [...files.values()].reduce((sum, size) => sum + size, 0),
  };
}

const evidenceSource = (item, platform) => sourceUrl(
  item?.url || item?.web_url || item?.share_url || item?.locator,
  platform,
);

export async function collectDownloadedMedia(run, items, { env = process.env } = {}) {
  if (run?.platform !== "tiktok" || !Array.isArray(items)) return { count: 0, bytes: 0 };
  const targets = new Set((run.actions || [])
    .filter((entry) => entry?.action?.downloadMedia === true)
    .map((entry) => sourceUrl(entry.action.target, "tiktok"))
    .filter(Boolean));
  if (!targets.size) return { count: 0, bytes: 0 };
  return collectVerifiedMedia(
    items.filter((item) => targets.has(evidenceSource(item, "tiktok"))),
    { env },
  );
}

const parseArgs = (args) => {
  const result = {};
  const names = new Map([
    ["--task", "task"],
    ["--jev-model", "jev_model"],
    ["--socai-version", "socai_version"],
    ["--socai-commit", "socai_commit"],
    ["--profile-mode", "profile_mode"],
    ["--region", "region"],
    ["--condition", "condition"],
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--help" || token === "-h") return { help: true };
    const name = names.get(token);
    if (!name) throw new TypeError(`unknown option: ${token}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new TypeError(`${token} requires a value`);
    if (Object.hasOwn(result, name)) throw new TypeError(`${token} may be provided only once`);
    result[name] = value;
    index += 1;
  }
  for (const name of names.values()) {
    if (!result[name]) throw new TypeError(`--${name.replaceAll("_", "-")} is required`);
  }
  if (!BENCHMARK_PROFILE_MODES.includes(result.profile_mode)) {
    throw new TypeError("--profile-mode must be existing or isolated");
  }
  if (!BENCHMARK_CONDITIONS.includes(result.condition)) {
    throw new TypeError("--condition must be cold or warm");
  }
  return result;
};

const loadTaskFile = async (filename) => {
  try {
    const metadata = await stat(filename);
    if (!metadata.isFile() || metadata.size > MAX_TASK_BYTES) throw new Error();
    return validateBenchmarkTask(JSON.parse(await readFile(filename, "utf8")));
  } catch {
    throw new TypeError("could not read a valid benchmark task file");
  }
};

const codedError = (code) => Object.assign(new Error(code), { code });

const defaultDependencies = () => ({
  env: process.env,
  loadLocalEnv,
  loadTaskFile,
  readConfig,
  createStateDir: (prefix) => mkdtemp(prefix),
  removeStateDir: (directory) => rm(directory, { recursive: true, force: true }),
  probeSocai,
  runSearch,
  listRuns,
  readRun,
  getPrivateRunMedia,
  collectDownloadedMedia,
});

export async function executeBenchmark(
  args,
  { signal, onStage = () => {}, dependencies = {} } = {},
) {
  const runtime = { ...defaultDependencies(), ...dependencies };
  const baseEnv = { ...runtime.env };
  await runtime.loadLocalEnv(baseEnv);
  const task = validateBenchmarkTask(await runtime.loadTaskFile(args.task));
  const validationTimestamp = new Date().toISOString();
  const validatedMetadata = buildBenchmarkRow({
    task,
    metadata: args,
    error: { code: "BENCHMARK_METADATA_VALIDATION" },
    startedAt: validationTimestamp,
    endedAt: validationTimestamp,
    totalMs: 0,
  });
  const metadata = {
    jev_model: validatedMetadata.jev_model,
    socai_version: validatedMetadata.socai_version,
    socai_commit: validatedMetadata.socai_commit,
    profile_mode: validatedMetadata.profile_mode,
    region: validatedMetadata.region,
    condition: validatedMetadata.condition,
  };
  const originalConfig = await runtime.readConfig(baseEnv);
  const isolatedHome = await runtime.createStateDir(path.join(os.tmpdir(), "jev-social-benchmark-"));
  const env = {
    ...baseEnv,
    JEV_SOCIAL_HOME: isolatedHome,
    OPENROUTER_REPORT_MODEL: "off",
    ...(originalConfig.socaiBin && !baseEnv.SOCAI_BIN
      ? { SOCAI_BIN: originalConfig.socaiBin }
      : {}),
    ...(resolveApiKey(originalConfig, baseEnv) && !baseEnv.OPENROUTER_API_KEY
      ? { OPENROUTER_API_KEY: resolveApiKey(originalConfig, baseEnv) }
      : {}),
  };
  if (env.JEV_SOCIAL_SYSTEM_ONE_URL?.trim()) {
    env.JEV_SOCIAL_SYSTEM_ONE_MODEL = metadata.jev_model;
  } else {
    env.OPENROUTER_JEV_MODEL = metadata.jev_model;
  }

  const startedWallMs = Date.now();
  const startedMonoMs = performance.now();
  let run;
  let error;
  let media = { count: 0, bytes: 0 };
  let lastStage;
  const emitStage = (stage) => {
    const label = String(stage || "");
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(label) || label === lastStage) return;
    lastStage = label;
    onStage(label);
  };

  try {
    try {
      const probe = await runtime.probeSocai({}, env, signal);
      if (!probe.version) throw codedError("SOCAI_VERSION_UNVERIFIABLE");
      if (probe.version !== metadata.socai_version) throw codedError("SOCAI_VERSION_MISMATCH");
      run = await runtime.runSearch(
        {
          query: task.goal,
          platform: task.platform,
          limit: task.result_limit,
          maxSteps: task.max_steps,
        },
        {
          env,
          signal,
          reportChunkDelayMs: 0,
          onEvent(event) {
            emitStage(event.stage);
          },
        },
      );
    } catch (caught) {
      error = caught;
      try {
        const [latest] = await runtime.listRuns(env);
        if (latest) run = await runtime.readRun(latest.id, env);
      } catch {
        emitStage("recovery_failed");
      }
    }
    try {
      const privateItems = run ? runtime.getPrivateRunMedia(run)?.downloadItems : undefined;
      if (privateItems) media = await runtime.collectDownloadedMedia(run, privateItems, { env });
    } catch {
      error ||= codedError("BENCHMARK_MEDIA_COLLECTION_FAILED");
      emitStage("media_verification_failed");
    }

    const totalMs = Math.max(0, Math.round(performance.now() - startedMonoMs));
    const rowInput = {
      task,
      metadata,
      run,
      error,
      startedAt: new Date(startedWallMs).toISOString(),
      endedAt: new Date(Date.now()).toISOString(),
      totalMs,
      media,
    };
    try {
      return buildBenchmarkRow(rowInput);
    } catch (rowError) {
      emitStage("row_invalid");
      const pinFailure = /^MODEL_PIN_(?:MISMATCH|UNVERIFIED)$/.test(String(rowError?.code || ""));
      return buildBenchmarkRow({
        ...rowInput,
        run: pinFailure ? retainMeasuredRunForPinFailure(run, metadata.jev_model) : undefined,
        media: pinFailure ? media : { count: 0, bytes: 0 },
        error: codedError(rowError?.code || "BENCHMARK_ROW_INVALID"),
      });
    }
  } finally {
    try {
      await runtime.removeStateDir(isolatedHome);
    } catch {
      emitStage("cleanup_failed");
    }
  }
}

export async function runBenchmarkCli(
  argv,
  {
    stdout = process.stdout,
    stderr = process.stderr,
    signal,
    dependencies,
  } = {},
) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      stdout.write(HELP);
      return { exitCode: 0 };
    }
    const row = await executeBenchmark(args, {
      signal,
      dependencies,
      onStage: (stage) => stderr.write(`[benchmark] ${stage}\n`),
    });
    stdout.write(`${JSON.stringify(row)}\n`);
    return { exitCode: 0, row };
  } catch {
    stderr.write("[benchmark] invalid_input\n");
    return { exitCode: 1 };
  }
}

async function main() {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const result = await runBenchmarkCli(process.argv.slice(2), { signal: controller.signal });
    process.exitCode = result.exitCode;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
