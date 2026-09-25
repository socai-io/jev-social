import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BenchmarkRowValidationError,
  validateBenchmarkRow,
} from "../benchmark/schema.js";

const fixture = JSON.parse(
  readFileSync(new URL("../benchmark/fixtures/valid-row.json", import.meta.url), "utf8"),
);

const clone = (value = fixture) => structuredClone(value);

test("accepts and normalizes the documented synthetic row", () => {
  const row = clone();
  row.region = "  synthetic-us  ";

  const normalized = validateBenchmarkRow(row);

  assert.notEqual(normalized, row);
  assert.equal(normalized.region, "synthetic-us");
  assert.equal(normalized.started_at, "2026-09-25T00:00:00.000Z");
  assert.equal(normalized.ended_at, "2026-09-25T00:00:12.000Z");
  assert.deepEqual(normalized, { ...fixture, region: "synthetic-us" });
});

test("schema v2 requires immutable Jev Social runtime metadata while v1 stays readable", () => {
  const current = clone();
  const normalized = validateBenchmarkRow(current);
  assert.equal(normalized.jev_social_version, "0.1.8");
  assert.equal(normalized.jev_social_commit, current.jev_social_commit);

  for (const field of ["jev_social_version", "jev_social_commit"]) {
    const missing = structuredClone(current);
    delete missing[field];
    assert.throws(
      () => validateBenchmarkRow(missing),
      (error) => error instanceof BenchmarkRowValidationError && error.path === field,
    );
  }

  const legacy = clone();
  legacy.schema_version = 1;
  delete legacy.jev_social_version;
  delete legacy.jev_social_commit;
  assert.equal(validateBenchmarkRow(legacy).schema_version, 1);
  assert.equal(Object.hasOwn(validateBenchmarkRow(legacy), "jev_social_version"), false);
});

test("rejects missing required fields and unknown enum values", () => {
  const missing = clone();
  delete missing.run_id;
  assert.throws(() => validateBenchmarkRow(missing), BenchmarkRowValidationError);

  for (const [field, value] of [
    ["platform", "youtube"],
    ["outcome", "mostly-success"],
    ["condition", "sometimes-warm"],
    ["profile_mode", "personal-account"],
  ]) {
    const row = clone();
    row[field] = value;
    assert.throws(
      () => validateBenchmarkRow(row),
      (error) => error instanceof BenchmarkRowValidationError && error.path === field,
      `${field} should reject ${value}`,
    );
  }
});

test("rejects invalid timestamps and inconsistent timing totals", () => {
  for (const mutate of [
    (row) => {
      row.started_at = "2026-09-25 00:00:00";
    },
    (row) => {
      row.ended_at = "2026-09-24T23:59:59.000Z";
    },
    (row) => {
      row.started_at = "2026-02-30T00:00:00.000Z";
      row.ended_at = "2026-02-30T00:00:12.000Z";
    },
    (row) => {
      row.timing_ms.jev_total = 999;
    },
    (row) => {
      row.timing_ms.total = 10_999;
    },
    (row) => {
      row.timing_ms.socai_browser = 12_001;
    },
  ]) {
    const row = clone();
    mutate(row);
    assert.throws(() => validateBenchmarkRow(row), BenchmarkRowValidationError);
  }
});

test("allows overlapping component timers and one-second wall-clock tolerance", () => {
  const row = clone();
  row.timing_ms.socai_browser = 12_000;
  row.timing_ms.media = 12_000;
  row.timing_ms.total = 12_001;
  assert.equal(validateBenchmarkRow(row).timing_ms.total, 12_001);

  row.timing_ms.total = 13_001;
  assert.throws(() => validateBenchmarkRow(row), BenchmarkRowValidationError);
});

test("requires sequential Jev and browser time to fit the end-to-end total", () => {
  const row = clone();
  row.jev_step_latency_ms = [3_000, 3_000];
  row.timing_ms.jev_total = 6_000;
  row.timing_ms.socai_browser = 7_001;
  assert.throws(() => validateBenchmarkRow(row), BenchmarkRowValidationError);
});

test("rejects negative durations and evidence counts", () => {
  for (const path of [
    ["jev_step_latency_ms", 0],
    ["timing_ms", "media"],
    ["evidence", "records"],
    ["evidence", "downloaded_media_bytes"],
  ]) {
    const row = clone();
    if (Array.isArray(row[path[0]])) row[path[0]][path[1]] = -1;
    else row[path[0]][path[1]] = -1;
    assert.throws(() => validateBenchmarkRow(row), BenchmarkRowValidationError);
  }
});

test("rejects unknown fields and recursively denylisted names", () => {
  const unknown = clone();
  unknown.notes = "looks harmless";
  assert.throws(
    () => validateBenchmarkRow(unknown),
    (error) => error instanceof BenchmarkRowValidationError && error.path === "notes",
  );

  for (const [name, value] of [
    ["cookie", "secret"],
    ["authorization", "secret"],
    ["api_key", "secret"],
    ["token", "secret"],
    ["websocket_url", "ws://127.0.0.1"],
    ["cdp_endpoint", "http://127.0.0.1"],
    ["account_id", "123"],
    ["username", "person"],
    ["local_path", "/tmp/private"],
    ["post_text", "private content"],
  ]) {
    const row = clone();
    row.evidence.extra = { [name]: value };
    assert.throws(
      () => validateBenchmarkRow(row),
      (error) =>
        error instanceof BenchmarkRowValidationError && error.path.endsWith(name),
      `${name} should be rejected at any depth`,
    );
  }
});

test("requires opaque IDs and pinned socai metadata", () => {
  for (const [field, value] of [
    ["run_id", "https://example.com/run/1"],
    ["run_id", "/Users/example/run-1"],
    ["run_id", "real_account_username"],
    ["task_id", "@creator"],
  ]) {
    const row = clone();
    row[field] = value;
    assert.throws(
      () => validateBenchmarkRow(row),
      (error) => error instanceof BenchmarkRowValidationError && error.path === field,
    );
  }

  const commit = clone();
  commit.socai_commit = "main";
  assert.throws(
    () => validateBenchmarkRow(commit),
    (error) => error instanceof BenchmarkRowValidationError && error.path === "socai_commit",
  );

  const jevSocialCommit = clone();
  jevSocialCommit.jev_social_commit = "main";
  assert.throws(
    () => validateBenchmarkRow(jevSocialCommit),
    (error) => error instanceof BenchmarkRowValidationError && error.path === "jev_social_commit",
  );

  for (const value of [
    "/Users/alice/jev-model",
    "https://example.com/jev",
    "typesafe/jev?token=secret",
    "@account/model",
  ]) {
    const row = clone();
    row.jev_model = value;
    assert.throws(
      () => validateBenchmarkRow(row),
      (error) => error instanceof BenchmarkRowValidationError && error.path === "jev_model",
    );
  }

  const canonical = clone();
  canonical.socai_version = "v0.6.0-beta.1+sha.abcdef";
  canonical.socai_commit = canonical.socai_commit.toUpperCase();
  canonical.jev_model = "typesafe/jev-1.13-20260917:free";
  const normalized = validateBenchmarkRow(canonical);
  assert.equal(normalized.socai_version, "0.6.0-beta.1+sha.abcdef");
  assert.equal(normalized.socai_commit, canonical.socai_commit.toLowerCase());
  assert.equal(normalized.jev_model, canonical.jev_model);

  const nestedModel = clone();
  nestedModel.jev_model = "org/team/jev";
  assert.equal(validateBenchmarkRow(nestedModel).jev_model, nestedModel.jev_model);

  for (const value of ["~typesafe/jev-latest", "typesafe/jev-latest:free", "kev-latest"]) {
    const row = clone();
    row.jev_model = value;
    assert.throws(
      () => validateBenchmarkRow(row),
      (error) => error instanceof BenchmarkRowValidationError && error.path === "jev_model",
    );
  }
});

test("keeps outcome and stop state consistent", () => {
  const success = clone();
  success.failure_category = "rate_limited";
  assert.throws(() => validateBenchmarkRow(success), BenchmarkRowValidationError);

  const partial = clone();
  partial.outcome = "partial";
  partial.stop_reason = "rate_limited";
  partial.failure_category = null;
  assert.throws(() => validateBenchmarkRow(partial), BenchmarkRowValidationError);

  const stateMatrix = [
    ["step_limit", "step_limit"],
    ["login_required", "access_gate"],
    ["challenge_required", "access_gate"],
    ["rate_limited", "access_gate"],
    ["empty_results", "empty_results"],
    ["capability_unavailable", "unavailable"],
    ["browser_unavailable", "unavailable"],
    ["media_unavailable", "unavailable"],
    ["decision_failed", "execution_error"],
    ["cli_failed", "execution_error"],
    ["network_error", "execution_error"],
    ["report_failed", "execution_error"],
    ["interrupted", "interrupted"],
    ["unknown", "unknown"],
  ];
  for (const [stopReason, failureCategory] of stateMatrix) {
    const failed = clone();
    failed.outcome = "failed";
    failed.stop_reason = stopReason;
    failed.failure_category = failureCategory;
    if (stopReason === "empty_results") {
      failed.evidence.records = 0;
      failed.evidence.comments = 0;
      failed.evidence.downloaded_media_count = 0;
      failed.evidence.downloaded_media_bytes = 0;
    }
    assert.equal(validateBenchmarkRow(failed).stop_reason, stopReason);

    failed.failure_category = failureCategory === "unknown" ? "execution_error" : "unknown";
    assert.throws(() => validateBenchmarkRow(failed), BenchmarkRowValidationError);
  }

  const contradictory = clone();
  contradictory.outcome = "failed";
  contradictory.stop_reason = "goal_satisfied";
  contradictory.failure_category = "unknown";
  assert.throws(() => validateBenchmarkRow(contradictory), BenchmarkRowValidationError);

  const successWithoutEvidence = clone();
  successWithoutEvidence.evidence.records = 0;
  successWithoutEvidence.evidence.comments = 0;
  successWithoutEvidence.evidence.downloaded_media_count = 0;
  successWithoutEvidence.evidence.downloaded_media_bytes = 0;
  assert.throws(() => validateBenchmarkRow(successWithoutEvidence), BenchmarkRowValidationError);

  const nonemptyEmptyResult = clone();
  nonemptyEmptyResult.outcome = "failed";
  nonemptyEmptyResult.stop_reason = "empty_results";
  nonemptyEmptyResult.failure_category = "empty_results";
  assert.throws(() => validateBenchmarkRow(nonemptyEmptyResult), BenchmarkRowValidationError);
});

test("allows zero preflight decisions and bounds route plus action decisions", () => {
  const preflight = clone();
  preflight.outcome = "failed";
  preflight.stop_reason = "capability_unavailable";
  preflight.failure_category = "unavailable";
  preflight.jev_step_latency_ms = [];
  preflight.timing_ms.jev_total = 0;
  preflight.evidence.records = 0;
  preflight.evidence.comments = 0;
  preflight.evidence.downloaded_media_count = 0;
  preflight.evidence.downloaded_media_bytes = 0;
  assert.equal(validateBenchmarkRow(preflight).jev_step_latency_ms.length, 0);

  const fullBudget = clone();
  fullBudget.max_steps = 1;
  assert.equal(validateBenchmarkRow(fullBudget).jev_step_latency_ms.length, 2);

  const tooMany = clone();
  tooMany.max_steps = 1;
  tooMany.jev_step_latency_ms.push(1);
  tooMany.timing_ms.jev_total += 1;
  assert.throws(() => validateBenchmarkRow(tooMany), BenchmarkRowValidationError);
});

test("keeps downloaded media counts possible and TikTok-only", () => {
  const zeroCountWithBytes = clone();
  zeroCountWithBytes.evidence.downloaded_media_bytes = 4_096;
  assert.throws(() => validateBenchmarkRow(zeroCountWithBytes), BenchmarkRowValidationError);

  const countWithZeroBytes = clone();
  countWithZeroBytes.evidence.downloaded_media_count = 1;
  assert.throws(() => validateBenchmarkRow(countWithZeroBytes), BenchmarkRowValidationError);

  const instagramDownload = clone();
  instagramDownload.evidence.downloaded_media_count = 1;
  instagramDownload.evidence.downloaded_media_bytes = 4_096;
  assert.throws(() => validateBenchmarkRow(instagramDownload), BenchmarkRowValidationError);

  const tiktokDownload = clone();
  tiktokDownload.platform = "tiktok";
  tiktokDownload.evidence.downloaded_media_count = 1;
  tiktokDownload.evidence.downloaded_media_bytes = 4_096;
  assert.equal(validateBenchmarkRow(tiktokDownload).evidence.downloaded_media_count, 1);
});

test("the packaged benchmark tools have explicit import paths", async () => {
  const packaged = await import("jev-social/benchmark/schema");
  const runner = await import("jev-social/benchmark/run");
  const summary = await import("jev-social/benchmark/summary");
  assert.equal(packaged.validateBenchmarkRow, validateBenchmarkRow);
  assert.equal(typeof runner.buildBenchmarkRow, "function");
  assert.equal(typeof runner.executeBenchmark, "function");
  assert.equal(typeof runner.runBenchmarkCli, "function");
  assert.equal(typeof summary.summarizeBenchmarkRows, "function");
});

test("the package contains only the intended benchmark artifacts", () => {
  const cache = mkdtempSync(join(tmpdir(), "jev-social-npm-cache-"));
  try {
    const npmArgs = ["pack", "--dry-run", "--ignore-scripts", "--json", "--cache", cache];
    const output = process.env.npm_execpath
      ? execFileSync(process.execPath, [process.env.npm_execpath, ...npmArgs], {
          cwd: new URL("..", import.meta.url),
          encoding: "utf8",
        })
      : execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", npmArgs, {
          cwd: new URL("..", import.meta.url),
          encoding: "utf8",
        });
    const files = JSON.parse(output)[0].files
      .map(({ path }) => path)
      .filter((path) => path.startsWith("benchmark/"));
    assert.deepEqual(files, [
      "benchmark/fixtures/valid-row.json",
      "benchmark/README.md",
      "benchmark/run.js",
      "benchmark/schema.js",
      "benchmark/summary.js",
      "benchmark/tasks/instagram.json",
      "benchmark/tasks/linkedin.json",
      "benchmark/tasks/tiktok.json",
    ]);
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});
