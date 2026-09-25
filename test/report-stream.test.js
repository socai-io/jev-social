import assert from "node:assert/strict";
import test from "node:test";

import { isFinalReportEvent, mergeReportEvent } from "../public/report-stream.js";

test("report stream appends chunks without duplicating already rendered text", () => {
  const first = mergeReportEvent("", { stage: "report", chunk: "# Report\n\n" });
  const second = mergeReportEvent(first, { stage: "report", chunk: "## Findings\n\nEvidence." });

  assert.equal(first, "# Report\n\n");
  assert.equal(second, "# Report\n\n## Findings\n\nEvidence.");
});

test("report stream preserves legitimate adjacent chunks with identical text", () => {
  const first = mergeReportEvent("", { stage: "report", chunk: "same\n", index: 1, total: 2 });
  const second = mergeReportEvent(first, { stage: "report", chunk: "same\n", index: 2, total: 2 });

  assert.equal(second, "same\nsame\n");
});

test("an authoritative accumulated report wins over a stale or repeated chunk", () => {
  assert.equal(
    mergeReportEvent("# Report\n\n", {
      stage: "report",
      chunk: "## Findings\n\nEvidence.",
      report: "# Report\n\n## Findings\n\nEvidence.",
    }),
    "# Report\n\n## Findings\n\nEvidence.",
  );
  assert.equal(mergeReportEvent("safe", { stage: "evidence", chunk: "raw" }), "safe");
});

test("only the final report chunk can enable a download", () => {
  assert.equal(isFinalReportEvent({ stage: "report", index: 1, total: 3 }), false);
  assert.equal(isFinalReportEvent({ stage: "report", index: 3, total: 3 }), true);
  assert.equal(isFinalReportEvent({ stage: "complete", index: 3, total: 3 }), false);
  assert.equal(isFinalReportEvent({ stage: "report", index: 1, total: 0 }), false);
});
