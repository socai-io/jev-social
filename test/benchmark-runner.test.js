import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildBenchmarkRow,
  collectDownloadedMedia,
  runBenchmarkCli,
  validateBenchmarkTask,
} from "../benchmark/run.js";

const task = {
  task_id: "11111111-1111-4111-8111-111111111111",
  platform: "tiktok",
  goal: "Find beginner watercolor videos, read comments, and download one selected video.",
  result_limit: 4,
  max_steps: 12,
};

const metadata = {
  jev_social_version: "0.1.8",
  jev_social_commit: "abcdef0123456789abcdef0123456789abcdef01",
  jev_model: "typesafe/jev-1.13-20260917",
  socai_version: "0.6.0",
  socai_commit: "0123456789abcdef0123456789abcdef01234567",
  profile_mode: "existing",
  region: "synthetic-us",
  condition: "warm",
};

const completedRun = () => ({
  status: "completed",
  stopReason: "Jev chose to finish with the evidence captured so far.",
  classification: { model: metadata.jev_model, modelVerified: true, elapsedMs: 100 },
  actions: [
    {
      action: { kind: "search", platform: "tiktok" },
      model: metadata.jev_model,
      modelVerified: true,
      jevElapsedMs: 200,
      elapsedMs: 3_000,
      status: "completed",
    },
    {
      action: { kind: "read_post", platform: "tiktok", downloadMedia: true },
      model: metadata.jev_model,
      modelVerified: true,
      jevElapsedMs: 300,
      elapsedMs: 4_000,
      status: "completed",
    },
    {
      action: { kind: "finish", platform: "tiktok" },
      model: metadata.jev_model,
      modelVerified: true,
      jevElapsedMs: 150,
      status: "completed",
    },
  ],
  result: {
    items: [{ url: "https://www.tiktok.com/@demo/video/1", top_comments: [{ text: "A" }, { text: "B" }] }],
  },
});

test("validates fixed benchmark task files without retaining extra fields", () => {
  assert.deepEqual(validateBenchmarkTask(task), task);

  assert.throws(
    () => validateBenchmarkTask({ ...task, account: "private-user" }),
    /unknown field/i,
  );
  assert.throws(
    () => validateBenchmarkTask({ ...task, platform: "youtube" }),
    /platform/i,
  );
  assert.throws(
    () => validateBenchmarkTask({ ...task, goal: "\u0000unsafe" }),
    /goal/i,
  );
});

test("builds one validated row from a completed run and keeps component timings separate", () => {
  const row = buildBenchmarkRow({
    task,
    metadata,
    run: completedRun(),
    startedAt: "2026-09-25T00:00:00.000Z",
    endedAt: "2026-09-25T00:00:09.000Z",
    totalMs: 9_000,
    runId: "00000000-0000-4000-8000-000000000010",
    media: { count: 1, bytes: 4_096 },
  });

  assert.equal(row.outcome, "success");
  assert.equal(row.schema_version, 2);
  assert.equal(row.jev_social_version, metadata.jev_social_version);
  assert.equal(row.jev_social_commit, metadata.jev_social_commit);
  assert.equal(row.stop_reason, "goal_satisfied");
  assert.deepEqual(row.jev_step_latency_ms, [100, 200, 300, 150]);
  assert.deepEqual(row.timing_ms, {
    jev_total: 750,
    socai_browser: 7_000,
    media: 4_000,
    total: 9_000,
  });
  assert.deepEqual(row.evidence, {
    records: 1,
    comments: 2,
    downloaded_media_count: 1,
    downloaded_media_bytes: 4_096,
  });
});

test("keeps access gates, empty results, and preflight failures in the dataset", () => {
  const blocked = completedRun();
  blocked.status = "blocked";
  blocked.stopReason = "The platform requires attention: login_required.";
  blocked.result.items = [];
  blocked.actions = blocked.actions.slice(0, 1);
  const blockedRow = buildBenchmarkRow({
    task,
    metadata,
    run: blocked,
    startedAt: "2026-09-25T00:00:00.000Z",
    endedAt: "2026-09-25T00:00:04.000Z",
    totalMs: 4_000,
    runId: "00000000-0000-4000-8000-000000000011",
  });
  assert.equal(blockedRow.outcome, "failed");
  assert.equal(blockedRow.stop_reason, "login_required");
  assert.equal(blockedRow.failure_category, "access_gate");

  const empty = completedRun();
  empty.status = "partial";
  empty.stopReason = "Jev stopped without usable evidence.";
  empty.result.items = [];
  const emptyRow = buildBenchmarkRow({
    task,
    metadata,
    run: empty,
    startedAt: "2026-09-25T00:00:00.000Z",
    endedAt: "2026-09-25T00:00:09.000Z",
    totalMs: 9_000,
    runId: "00000000-0000-4000-8000-000000000012",
  });
  assert.equal(emptyRow.stop_reason, "empty_results");
  assert.equal(emptyRow.failure_category, "empty_results");

  const unavailable = buildBenchmarkRow({
    task,
    metadata,
    error: { code: "SOCAI_CAPABILITY_MISSING" },
    startedAt: "2026-09-25T00:00:00.000Z",
    endedAt: "2026-09-25T00:00:01.000Z",
    totalMs: 1_000,
    runId: "00000000-0000-4000-8000-000000000013",
  });
  assert.equal(unavailable.outcome, "failed");
  assert.equal(unavailable.stop_reason, "capability_unavailable");
  assert.equal(unavailable.failure_category, "unavailable");

  const browserUnavailable = buildBenchmarkRow({
    task,
    metadata,
    error: { code: "BROWSER_PERMISSION_REQUIRED" },
    startedAt: "2026-09-25T00:00:00.000Z",
    endedAt: "2026-09-25T00:00:01.000Z",
    totalMs: 1_000,
    runId: "00000000-0000-4000-8000-000000000015",
  });
  assert.equal(browserUnavailable.stop_reason, "browser_unavailable");
  assert.equal(browserUnavailable.failure_category, "unavailable");

  const reportFailed = completedRun();
  reportFailed.status = "failed";
  reportFailed.reportStatus = "failed";
  const reportFailedRow = buildBenchmarkRow({
    task,
    metadata,
    run: reportFailed,
    startedAt: "2026-09-25T00:00:00.000Z",
    endedAt: "2026-09-25T00:00:09.000Z",
    totalMs: 9_000,
    runId: "00000000-0000-4000-8000-000000000016",
  });
  assert.equal(reportFailedRow.outcome, "partial");
  assert.equal(reportFailedRow.stop_reason, "report_failed");
  assert.equal(reportFailedRow.failure_category, "execution_error");

  for (const code of [
    "EMPTY_SOCAI_OUTPUT",
    "INVALID_SOCAI_OUTPUT",
    "SOCAI_OUTPUT_TOO_LARGE",
  ]) {
    const failedRun = completedRun();
    failedRun.status = "partial";
    failedRun.result.items = [];
    failedRun.actions = [{
      ...failedRun.actions[0],
      status: "failed",
      elapsedMs: 750,
      observation: { code },
    }];
    const failedRow = buildBenchmarkRow({
      task,
      metadata,
      run: failedRun,
      startedAt: "2026-09-25T00:00:00.000Z",
      endedAt: "2026-09-25T00:00:01.000Z",
      totalMs: 1_000,
      runId: crypto.randomUUID(),
    });
    assert.equal(failedRow.stop_reason, "cli_failed");
    assert.equal(failedRow.timing_ms.socai_browser, 750);
  }

  const lowConfidence = buildBenchmarkRow({
    task,
    metadata,
    error: {
      code: "LOW_ACTION_CONFIDENCE",
      details: { elapsedMs: 320, model: metadata.jev_model },
    },
    startedAt: "2026-09-25T00:00:00.000Z",
    endedAt: "2026-09-25T00:00:01.000Z",
    totalMs: 1_000,
    runId: crypto.randomUUID(),
  });
  assert.equal(lowConfidence.stop_reason, "decision_failed");
  assert.deepEqual(lowConfidence.jev_step_latency_ms, [320]);
});

test("rejects a run whose resolved decision model differs from the declared pin", () => {
  const run = completedRun();
  run.classification.model = "typesafe/jev-other";

  assert.throws(
    () => buildBenchmarkRow({
      task,
      metadata,
      run,
      startedAt: "2026-09-25T00:00:00.000Z",
      endedAt: "2026-09-25T00:00:09.000Z",
      totalMs: 9_000,
      runId: "00000000-0000-4000-8000-000000000014",
    }),
    /decision model/i,
  );
});

test("rejects successful decisions when the provider omits the resolved model", () => {
  const run = completedRun();
  run.classification.modelVerified = false;

  assert.throws(
    () => buildBenchmarkRow({
      task,
      metadata,
      run,
      startedAt: "2026-09-25T00:00:00.000Z",
      endedAt: "2026-09-25T00:00:09.000Z",
      totalMs: 9_000,
      runId: crypto.randomUUID(),
    }),
    /did not report the resolved model/i,
  );
});

test("counts only media tied to an explicit download action below configured run roots", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jev-social-benchmark-media-"));
  const runs = path.join(directory, "runs");
  const inside = path.join(runs, "video.mp4");
  const outside = path.join(directory, "outside.mp4");
  const artifact = path.join(runs, "trace.json");
  const unrelated = path.join(runs, "unrelated.mp4");
  await mkdir(runs);
  await writeFile(inside, Buffer.alloc(4_096, 1));
  await writeFile(outside, Buffer.alloc(8_192, 1));
  await writeFile(artifact, Buffer.alloc(512, 1));
  await writeFile(unrelated, Buffer.alloc(1_024, 1));

  try {
    const media = await collectDownloadedMedia(
      {
        platform: "tiktok",
        actions: [{
          status: "completed",
          action: {
            kind: "read_post",
            downloadMedia: true,
            target: "https://www.tiktok.com/@demo/video/1",
          },
        }],
      },
      [
        {
          url: "https://www.tiktok.com/@demo/video/1",
          video: { local_path: inside },
          artifact: { local_path: artifact },
          duplicate: { local_path: inside },
        },
        { url: "https://www.tiktok.com/@demo/video/2", video: { local_path: unrelated } },
        { url: "https://www.tiktok.com/@demo/video/1", poster: { local_path: outside } },
      ],
      { env: { ...process.env, SOCAI_RUNS_DIR: runs } },
    );
    assert.deepEqual(media, { count: 1, bytes: 4_096 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const cliArguments = [
  "--task", "benchmark/tasks/tiktok.json",
  "--jev-social-version", metadata.jev_social_version,
  "--jev-social-commit", metadata.jev_social_commit,
  "--jev-model", metadata.jev_model,
  "--socai-version", metadata.socai_version,
  "--socai-commit", metadata.socai_commit,
  "--profile-mode", metadata.profile_mode,
  "--region", metadata.region,
  "--condition", metadata.condition,
];

const cliDependencies = (overrides = {}) => ({
  env: { HOME: "/non-sensitive-test-home" },
  loadLocalEnv: async () => {},
  loadTaskFile: async () => task,
  readConfig: async () => ({}),
  createStateDir: async () => "/virtual/benchmark-state",
  removeStateDir: async () => {},
  probeSocai: async () => ({ installed: true, version: metadata.socai_version }),
  runSearch: async (_request, options) => {
    await options.onEvent({ stage: "searching", message: "must not reach stderr" });
    const run = completedRun();
    run.classification.elapsedMs = 0;
    for (const action of run.actions) {
      action.jevElapsedMs = 0;
      if (action.elapsedMs !== undefined) action.elapsedMs = 0;
    }
    return run;
  },
  listRuns: async () => [],
  readRun: async () => null,
  getPrivateRunMedia: () => undefined,
  ...overrides,
});

test("the executable contract emits one row and fixed stage-only stderr", async () => {
  let stdout = "";
  let stderr = "";
  const result = await runBenchmarkCli(cliArguments, {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    dependencies: cliDependencies(),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(stdout.trim().split("\n").length, 1);
  assert.equal(JSON.parse(stdout).outcome, "success");
  assert.equal(stderr, "[benchmark] searching\n");
  assert.doesNotMatch(stderr, /must not reach|virtual|non-sensitive/);
});

test("unverifiable versions and interruptions remain privacy-safe rows", async () => {
  for (const [probeSocai, expectedReason, signal] of [
    [async () => ({ installed: true, version: null }), "capability_unavailable", undefined],
    [async () => ({ installed: true, version: metadata.socai_version }), "interrupted", AbortSignal.abort()],
  ]) {
    let stdout = "";
    let stderr = "";
    const result = await runBenchmarkCli(cliArguments, {
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
      signal,
      dependencies: cliDependencies({
        probeSocai,
        runSearch: async (_request, options) => {
          options.signal?.throwIfAborted();
          return completedRun();
        },
      }),
    });
    assert.equal(result.exitCode, 0);
    assert.equal(stdout.trim().split("\n").length, 1);
    assert.equal(JSON.parse(stdout).stop_reason, expectedReason);
    assert.doesNotMatch(stderr, /\/virtual|\/Users|OPENROUTER/i);
  }
});

test("a provider model mismatch becomes a retained failed row", async () => {
  let stdout = "";
  let stderr = "";
  const result = await runBenchmarkCli(cliArguments, {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    dependencies: cliDependencies({
      runSearch: async () => {
        const run = completedRun();
        run.classification.model = "typesafe/jev-other-pinned";
        run.classification.elapsedMs = 5;
        for (const action of run.actions) {
          action.jevElapsedMs = 0;
          if (action.elapsedMs !== undefined) action.elapsedMs = 0;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
        return run;
      },
    }),
  });
  assert.equal(result.exitCode, 0);
  const row = JSON.parse(stdout);
  assert.equal(row.stop_reason, "decision_failed");
  assert.deepEqual(row.jev_step_latency_ms, [5, 0, 0, 0]);
  assert.equal(row.timing_ms.jev_total, 5);
  assert.equal(row.evidence.records, 1);
  assert.equal(stderr, "[benchmark] row_invalid\n");
});

test("an abort during a Jev request is retained as interrupted", async () => {
  let stdout = "";
  const result = await runBenchmarkCli(cliArguments, {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: () => {} },
    dependencies: cliDependencies({
      runSearch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const error = new Error("interrupted");
        error.name = "AbortError";
        error.code = "JEV_ABORTED";
        error.details = {
          elapsedMs: 4,
          model: metadata.jev_model,
          modelVerified: false,
        };
        throw error;
      },
    }),
  });

  assert.equal(result.exitCode, 0);
  const row = JSON.parse(stdout);
  assert.equal(row.stop_reason, "interrupted");
  assert.equal(row.failure_category, "interrupted");
  assert.deepEqual(row.jev_step_latency_ms, [4]);
});

test("floating model pins fail before a live attempt", async () => {
  let stdout = "";
  let stderr = "";
  let called = false;
  const args = [...cliArguments];
  args[args.indexOf("--jev-model") + 1] = "typesafe/jev-latest";
  const result = await runBenchmarkCli(args, {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    dependencies: cliDependencies({
      probeSocai: async () => {
        called = true;
        return { installed: true, version: metadata.socai_version };
      },
    }),
  });
  assert.equal(result.exitCode, 1);
  assert.equal(called, false);
  assert.equal(stdout, "");
  assert.equal(stderr, "[benchmark] invalid_input\n");
});

test("SIGINT produces an interrupted row instead of dropping the attempt", {
  skip: process.platform === "win32",
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jev-social-benchmark-signal-"));
  const mock = path.join(directory, "socai-hang.mjs");
  await writeFile(mock, "#!/usr/bin/env node\nsetInterval(() => {}, 30_000);\n", { mode: 0o755 });
  await chmod(mock, 0o755);
  const root = new URL("..", import.meta.url);
  const child = spawn(process.execPath, ["benchmark/run.js", ...cliArguments], {
    cwd: root,
    env: { ...process.env, SOCAI_BIN: mock },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  try {
    await new Promise((resolve) => setTimeout(resolve, 250));
    child.kill("SIGINT");
    const { code, signal } = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    assert.equal(signal, null);
    assert.equal(code, 0);
    assert.equal(stdout.trim().split("\n").length, 1);
    assert.equal(JSON.parse(stdout).stop_reason, "interrupted");
    assert.doesNotMatch(stderr, new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});

test("ships one fixed, privacy-safe task per supported platform", async () => {
  const filenames = ["instagram.json", "tiktok.json", "linkedin.json"];
  const tasks = await Promise.all(filenames.map(async (filename) =>
    validateBenchmarkTask(JSON.parse(
      await readFile(new URL(`../benchmark/tasks/${filename}`, import.meta.url), "utf8"),
    )),
  ));

  assert.deepEqual(tasks.map(({ platform }) => platform), ["instagram", "tiktok", "linkedin"]);
  assert.equal(new Set(tasks.map(({ task_id: taskId }) => taskId)).size, tasks.length);
  assert.match(tasks[1].goal, /download one selected video/i);
  for (const benchmarkTask of tasks) {
    assert.equal(benchmarkTask.result_limit, 4);
    assert.equal(benchmarkTask.max_steps, 12);
    assert.doesNotMatch(benchmarkTask.goal, /@|https?:\/\/|\/Users\//i);
  }
});

test("benchmark commands expose offline help without loading live configuration", () => {
  const root = new URL("..", import.meta.url);
  const runner = execFileSync(process.execPath, ["benchmark/run.js", "--help"], {
    cwd: root,
    encoding: "utf8",
  });
  const summary = execFileSync(process.execPath, ["benchmark/summary.js", "--help"], {
    cwd: root,
    encoding: "utf8",
  });

  assert.match(runner, /writes exactly one validated/i);
  assert.match(summary, /--input <rows\.ndjson>/i);
});
