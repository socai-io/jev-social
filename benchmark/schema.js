const TOP_LEVEL_FIELDS = new Set([
  "schema_version",
  "run_id",
  "task_id",
  "started_at",
  "ended_at",
  "platform",
  "outcome",
  "jev_model",
  "socai_version",
  "socai_commit",
  "result_limit",
  "max_steps",
  "profile_mode",
  "region",
  "condition",
  "jev_step_latency_ms",
  "timing_ms",
  "evidence",
  "stop_reason",
  "failure_category",
]);

const TIMING_FIELDS = new Set(["jev_total", "socai_browser", "media", "total"]);
const EVIDENCE_FIELDS = new Set([
  "records",
  "comments",
  "downloaded_media_count",
  "downloaded_media_bytes",
]);

const DENYLISTED_FIELDS = new Set([
  "cookie",
  "authorization",
  "api_key",
  "token",
  "websocket_url",
  "cdp_endpoint",
  "account_id",
  "username",
  "local_path",
  "post_text",
]);

export const BENCHMARK_PLATFORMS = Object.freeze(["instagram", "tiktok", "linkedin"]);
export const BENCHMARK_OUTCOMES = Object.freeze(["success", "partial", "failed"]);
export const BENCHMARK_PROFILE_MODES = Object.freeze(["existing", "isolated"]);
export const BENCHMARK_CONDITIONS = Object.freeze(["cold", "warm"]);
export const BENCHMARK_STOP_REASONS = Object.freeze([
  "goal_satisfied",
  "step_limit",
  "login_required",
  "challenge_required",
  "rate_limited",
  "empty_results",
  "capability_unavailable",
  "browser_unavailable",
  "media_unavailable",
  "decision_failed",
  "cli_failed",
  "network_error",
  "report_failed",
  "interrupted",
  "unknown",
]);
export const BENCHMARK_FAILURE_CATEGORIES = Object.freeze([
  "access_gate",
  "unavailable",
  "execution_error",
  "interrupted",
  "step_limit",
  "empty_results",
  "unknown",
]);

const FAILURE_CATEGORY_BY_STOP_REASON = Object.freeze({
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
});

export class BenchmarkRowValidationError extends TypeError {
  constructor(path, message) {
    super(`${path}: ${message}`);
    this.name = "BenchmarkRowValidationError";
    this.path = path;
  }
}

const fail = (path, message) => {
  throw new BenchmarkRowValidationError(path, message);
};

const isRecord = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const rejectDenylistedFields = (value, path = "row") => {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectDenylistedFields(item, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;

  for (const [key, nested] of Object.entries(value)) {
    const nestedPath = `${path}.${key}`;
    if (DENYLISTED_FIELDS.has(key.toLowerCase())) fail(nestedPath, "field is not publishable");
    rejectDenylistedFields(nested, nestedPath);
  }
};

const strictRecord = (value, allowed, path) => {
  if (!isRecord(value)) fail(path, "must be an object");
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(path === "row" ? key : `${path}.${key}`, "unknown field");
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) {
      fail(path === "row" ? key : `${path}.${key}`, "field is required");
    }
  }
};

const cleanString = (value, path, { max = 200, pattern } = {}) => {
  if (typeof value !== "string") fail(path, "must be a string");
  const cleaned = value.trim();
  if (!cleaned) fail(path, "must not be empty");
  if (cleaned.length > max) fail(path, `must be at most ${max} characters`);
  if (/[\u0000-\u001f\u007f]/.test(cleaned)) fail(path, "must not contain control characters");
  if (pattern && !pattern.test(cleaned)) fail(path, "has an invalid format");
  return cleaned;
};

const enumValue = (value, choices, path) => {
  if (!choices.includes(value)) fail(path, `must be one of: ${choices.join(", ")}`);
  return value;
};

const integer = (value, path, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail(path, `must be an integer from ${min} to ${max}`);
  }
  return value;
};

const timestamp = (value, path) => {
  const cleaned = cleanString(value, path, { max: 30 });
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(cleaned)) {
    fail(path, "must be an ISO 8601 UTC timestamp");
  }
  const date = new Date(cleaned);
  if (!Number.isFinite(date.getTime())) fail(path, "must be a valid timestamp");
  const canonical = cleaned.includes(".") ? cleaned : cleaned.replace(/Z$/, ".000Z");
  if (date.toISOString() !== canonical) fail(path, "must be a real calendar timestamp");
  return date.toISOString();
};

const opaqueId = (value, path) => {
  const cleaned = cleanString(value, path, {
    max: 36,
    pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  });
  return cleaned.toLowerCase();
};

const normalizeTiming = (value) => {
  strictRecord(value, TIMING_FIELDS, "timing_ms");
  return {
    jev_total: integer(value.jev_total, "timing_ms.jev_total"),
    socai_browser: integer(value.socai_browser, "timing_ms.socai_browser"),
    media: integer(value.media, "timing_ms.media"),
    total: integer(value.total, "timing_ms.total"),
  };
};

const normalizeEvidence = (value) => {
  strictRecord(value, EVIDENCE_FIELDS, "evidence");
  return {
    records: integer(value.records, "evidence.records"),
    comments: integer(value.comments, "evidence.comments"),
    downloaded_media_count: integer(
      value.downloaded_media_count,
      "evidence.downloaded_media_count",
    ),
    downloaded_media_bytes: integer(
      value.downloaded_media_bytes,
      "evidence.downloaded_media_bytes",
    ),
  };
};

export const validateBenchmarkRow = (value) => {
  rejectDenylistedFields(value);
  strictRecord(value, TOP_LEVEL_FIELDS, "row");

  const startedAt = timestamp(value.started_at, "started_at");
  const endedAt = timestamp(value.ended_at, "ended_at");
  const startedMs = Date.parse(startedAt);
  const endedMs = Date.parse(endedAt);
  if (endedMs < startedMs) fail("ended_at", "must not be earlier than started_at");

  if (!Array.isArray(value.jev_step_latency_ms)) {
    fail("jev_step_latency_ms", "must be an array");
  }
  const maxSteps = integer(value.max_steps, "max_steps", { min: 1, max: 30 });
  const jevStepLatency = value.jev_step_latency_ms.map((duration, index) =>
    integer(duration, `jev_step_latency_ms[${index}]`),
  );
  if (jevStepLatency.length > maxSteps + 1) {
    fail("jev_step_latency_ms", "must not contain more entries than route plus max_steps");
  }
  const timing = normalizeTiming(value.timing_ms);
  const evidence = normalizeEvidence(value.evidence);
  const platform = enumValue(value.platform, BENCHMARK_PLATFORMS, "platform");

  const measuredJevTotal = jevStepLatency.reduce((total, duration) => total + duration, 0);
  if (measuredJevTotal !== timing.jev_total) {
    fail("timing_ms.jev_total", "must equal the sum of jev_step_latency_ms");
  }
  for (const component of ["jev_total", "socai_browser", "media"]) {
    if (timing[component] > timing.total) {
      fail(`timing_ms.${component}`, "must not exceed timing_ms.total");
    }
  }
  if (timing.jev_total + timing.socai_browser > timing.total + 1_000) {
    fail("timing_ms.total", "must cover sequential Jev and browser time within 1000 ms");
  }
  if (Math.abs(endedMs - startedMs - timing.total) > 1_000) {
    fail("timing_ms.total", "must be within 1000 ms of the wall-clock duration");
  }

  const hasDownloadedMedia = evidence.downloaded_media_count > 0;
  const hasDownloadedMediaBytes = evidence.downloaded_media_bytes > 0;
  if (hasDownloadedMedia !== hasDownloadedMediaBytes) {
    fail(
      "evidence.downloaded_media_bytes",
      "downloaded media count and byte total must both be zero or both be positive",
    );
  }
  if (hasDownloadedMedia && platform !== "tiktok") {
    fail("evidence.downloaded_media_count", "downloaded media is supported only for TikTok");
  }
  if (evidence.downloaded_media_count > evidence.records) {
    fail("evidence.downloaded_media_count", "must not exceed evidence.records");
  }

  const outcome = enumValue(value.outcome, BENCHMARK_OUTCOMES, "outcome");
  const stopReason = enumValue(value.stop_reason, BENCHMARK_STOP_REASONS, "stop_reason");
  let failureCategory = null;
  if (value.failure_category !== null) {
    failureCategory = enumValue(
      value.failure_category,
      BENCHMARK_FAILURE_CATEGORIES,
      "failure_category",
    );
  }
  if (outcome === "success" && (failureCategory !== null || stopReason !== "goal_satisfied")) {
    fail("failure_category", "successful rows must end with goal_satisfied and no failure");
  }
  if (outcome === "success" && evidence.records === 0) {
    fail("evidence.records", "successful rows require captured evidence");
  }
  if (outcome === "success" && jevStepLatency.length === 0) {
    fail("jev_step_latency_ms", "successful rows require at least one Jev decision");
  }
  if (outcome !== "success" && failureCategory === null) {
    fail("failure_category", "partial and failed rows require a failure category");
  }
  if (outcome !== "success" && stopReason === "goal_satisfied") {
    fail("stop_reason", "partial and failed rows cannot report goal_satisfied");
  }
  if (
    outcome !== "success" &&
    failureCategory !== FAILURE_CATEGORY_BY_STOP_REASON[stopReason]
  ) {
    fail("failure_category", `must be ${FAILURE_CATEGORY_BY_STOP_REASON[stopReason]} for ${stopReason}`);
  }
  if (
    stopReason === "empty_results" &&
    (evidence.records !== 0 ||
      evidence.comments !== 0 ||
      evidence.downloaded_media_count !== 0 ||
      evidence.downloaded_media_bytes !== 0)
  ) {
    fail("evidence", "empty_results rows cannot contain captured evidence");
  }

  const socaiVersion = cleanString(value.socai_version, "socai_version", {
    max: 64,
    pattern: /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
  }).replace(/^v/, "");
  const socaiCommit = cleanString(value.socai_commit, "socai_commit", {
    max: 40,
    pattern: /^[a-f0-9]{7,40}$/i,
  }).toLowerCase();

  return {
    schema_version: integer(value.schema_version, "schema_version", { min: 1, max: 1 }),
    run_id: opaqueId(value.run_id, "run_id"),
    task_id: opaqueId(value.task_id, "task_id"),
    started_at: startedAt,
    ended_at: endedAt,
    platform,
    outcome,
    jev_model: cleanString(value.jev_model, "jev_model", {
      max: 128,
      pattern:
        /^~?[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*){0,3}(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/,
    }),
    socai_version: socaiVersion,
    socai_commit: socaiCommit,
    result_limit: integer(value.result_limit, "result_limit", { min: 1, max: 100 }),
    max_steps: maxSteps,
    profile_mode: enumValue(value.profile_mode, BENCHMARK_PROFILE_MODES, "profile_mode"),
    region: cleanString(value.region, "region", {
      max: 64,
      pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    }),
    condition: enumValue(value.condition, BENCHMARK_CONDITIONS, "condition"),
    jev_step_latency_ms: jevStepLatency,
    timing_ms: timing,
    evidence,
    stop_reason: stopReason,
    failure_category: failureCategory,
  };
};
