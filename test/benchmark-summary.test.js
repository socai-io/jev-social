import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  renderBenchmarkSummary,
  summarizeBenchmarkRows,
} from "../benchmark/summary.js";

const fixture = JSON.parse(
  readFileSync(new URL("../benchmark/fixtures/valid-row.json", import.meta.url), "utf8"),
);

const row = (index) => {
  const value = structuredClone(fixture);
  const total = (index + 1) * 1_000;
  value.run_id = `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`;
  value.started_at = `2026-09-25T00:00:${String(index).padStart(2, "0")}.000Z`;
  value.ended_at = new Date(Date.parse(value.started_at) + total).toISOString();
  value.jev_step_latency_ms = [100];
  value.timing_ms = {
    jev_total: 100,
    socai_browser: Math.max(0, total - 100),
    media: 0,
    total,
  };
  value.evidence.records = 4;
  value.evidence.comments = index;
  if (index === 8) {
    value.outcome = "partial";
    value.stop_reason = "step_limit";
    value.failure_category = "step_limit";
  }
  if (index === 9) {
    value.outcome = "failed";
    value.stop_reason = "empty_results";
    value.failure_category = "empty_results";
    value.evidence.records = 0;
    value.evidence.comments = 0;
  }
  return value;
};

test("summarizes every terminal outcome with deterministic p50 and p95 values", () => {
  const summary = summarizeBenchmarkRows(Array.from({ length: 10 }, (_, index) => row(index)));

  assert.equal(summary.publicationReady, true);
  assert.equal(summary.groups.length, 1);
  assert.equal(summary.groups[0].outcomes.success, 8);
  assert.equal(summary.groups[0].outcomes.partial, 1);
  assert.equal(summary.groups[0].outcomes.failed, 1);
  assert.equal(summary.groups[0].failureRatePercent, 10);
  assert.deepEqual(summary.groups[0].metrics.total, { p50: 5_000, p95: 10_000 });
  assert.deepEqual(summary.groups[0].stopReasons, { empty_results: 1, step_limit: 1 });

  const markdown = renderBenchmarkSummary(summary);
  assert.match(markdown, /Publication gate: READY/);
  assert.match(markdown, /8 \/ 1 \/ 1/);
  assert.match(markdown, /10\.0%/);
  assert.match(markdown, /5,000 \/ 10,000/);
  assert.match(markdown, /empty_results/);
  assert.match(markdown, /All terminal outcomes are included/);
});

test("marks every exact environment group with fewer than ten rows as incomplete", () => {
  const secondEnvironment = row(1);
  secondEnvironment.condition = "cold";
  const summary = summarizeBenchmarkRows([row(0), secondEnvironment]);

  assert.equal(summary.publicationReady, false);
  assert.equal(summary.groups.length, 2);
  assert.ok(summary.groups.every((group) => group.publicationStatus === "INCOMPLETE (1/10)"));
  assert.match(renderBenchmarkSummary(summary), /Publication gate: INCOMPLETE/);
});

test("rejects invalid rows instead of silently dropping them", () => {
  const invalid = row(0);
  invalid.api_key = "secret";
  assert.throws(() => summarizeBenchmarkRows([row(1), invalid]), /api_key/);
});

test("rejects duplicate run IDs before they can satisfy the publication gate", () => {
  const duplicate = row(0);
  assert.throws(
    () => summarizeBenchmarkRows(Array.from({ length: 10 }, () => structuredClone(duplicate))),
    /duplicate run_id/i,
  );
});
