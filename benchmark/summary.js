#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateBenchmarkRow } from "./schema.js";

const MINIMUM_RUNS = 10;
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_ROWS = 10_000;
const GROUP_FIELDS = [
  "schema_version",
  "task_id",
  "platform",
  "jev_social_version",
  "jev_social_commit",
  "jev_model",
  "socai_version",
  "socai_commit",
  "result_limit",
  "max_steps",
  "profile_mode",
  "region",
  "condition",
];

const percentile = (values, fraction) => {
  const sorted = [...values].sort((left, right) => left - right);
  if (!sorted.length) return 0;
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
};

const metric = (rows, select) => {
  const values = rows.map(select);
  return { p50: percentile(values, 0.5), p95: percentile(values, 0.95) };
};

const groupIdentity = (row) => Object.fromEntries(GROUP_FIELDS.map((field) => [field, row[field]]));
const groupKey = (row) => JSON.stringify(groupIdentity(row));

export function summarizeBenchmarkRows(inputRows) {
  if (!Array.isArray(inputRows) || inputRows.length === 0) {
    throw new TypeError("at least one benchmark row is required");
  }
  if (inputRows.length > MAX_ROWS) throw new TypeError(`benchmark input exceeds ${MAX_ROWS} rows`);
  const rows = inputRows.map(validateBenchmarkRow);
  const runIds = new Set();
  for (const row of rows) {
    if (runIds.has(row.run_id)) throw new TypeError(`duplicate run_id: ${row.run_id}`);
    runIds.add(row.run_id);
  }
  const grouped = new Map();
  for (const row of rows) {
    const key = groupKey(row);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }

  const groups = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, entries], index) => {
      const outcomes = { success: 0, partial: 0, failed: 0 };
      const stopReasons = {};
      for (const row of entries) {
        outcomes[row.outcome] += 1;
        if (row.stop_reason !== "goal_satisfied") {
          stopReasons[row.stop_reason] = (stopReasons[row.stop_reason] || 0) + 1;
        }
      }
      return {
        id: `G${index + 1}`,
        ...groupIdentity(entries[0]),
        runs: entries.length,
        publicationStatus: entries[0].schema_version < 2
          ? "LEGACY SCHEMA (v1)"
          : entries.length >= MINIMUM_RUNS
            ? "READY"
            : `INCOMPLETE (${entries.length}/${MINIMUM_RUNS})`,
        startedAt: entries.map((row) => row.started_at).sort()[0],
        endedAt: entries.map((row) => row.ended_at).sort().at(-1),
        outcomes,
        failureRatePercent: (outcomes.failed / entries.length) * 100,
        stopReasons: Object.fromEntries(Object.entries(stopReasons).sort(([left], [right]) =>
          left.localeCompare(right),
        )),
        metrics: {
          total: metric(entries, (row) => row.timing_ms.total),
          jev: metric(entries, (row) => row.timing_ms.jev_total),
          socaiBrowser: metric(entries, (row) => row.timing_ms.socai_browser),
          media: metric(entries, (row) => row.timing_ms.media),
          records: metric(entries, (row) => row.evidence.records),
          comments: metric(entries, (row) => row.evidence.comments),
          downloadedMedia: metric(entries, (row) => row.evidence.downloaded_media_count),
        },
      };
    });

  return {
    schemaVersion: 1,
    minimumRuns: MINIMUM_RUNS,
    rowCount: rows.length,
    publicationReady: groups.every((group) => group.publicationStatus === "READY"),
    groups,
  };
}

const number = (value) => new Intl.NumberFormat("en-US").format(value);
const pair = ({ p50, p95 }) => `${number(p50)} / ${number(p95)}`;
const shortCommit = (value) => value.slice(0, 12);

export function renderBenchmarkSummary(summary) {
  const lines = [
    "# Jev Social benchmark summary",
    "",
    `Publication gate: ${summary.publicationReady ? "READY" : "INCOMPLETE"}`,
    "",
    `Validated rows: ${number(summary.rowCount)}. Each exact task and environment group needs at least ${summary.minimumRuns} rows before publication. All terminal outcomes are included; failures and partial runs are never dropped.`,
    "",
    "Timing percentiles use the nearest-rank method across every row in the group. Media-op time is the full socai operation that requested a download, so it may overlap socai/browser time and is an upper bound on download-only work.",
    "",
    "## Results",
    "",
    "| Group | Platform | Condition | Runs | Success / partial / failed | Failure rate | Total ms p50 / p95 | Jev ms p50 / p95 | socai/browser ms p50 / p95 | Media-op ms p50 / p95 | Records p50 / p95 | Comments p50 / p95 | Media count p50 / p95 |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const group of summary.groups) {
    lines.push(`| ${group.id} | ${group.platform} | ${group.condition} | ${group.runs} | ${group.outcomes.success} / ${group.outcomes.partial} / ${group.outcomes.failed} | ${group.failureRatePercent.toFixed(1)}% | ${pair(group.metrics.total)} | ${pair(group.metrics.jev)} | ${pair(group.metrics.socaiBrowser)} | ${pair(group.metrics.media)} | ${pair(group.metrics.records)} | ${pair(group.metrics.comments)} | ${pair(group.metrics.downloadedMedia)} |`);
  }

  lines.push(
    "",
    "## Environment",
    "",
    "| Group | Task ID | Jev Social | Jev model | socai | Profile | Region | Limit / steps | Date window (UTC) | Status |",
    "| --- | --- | --- | --- | --- | --- | --- | ---: | --- | --- |",
  );
  for (const group of summary.groups) {
    const jevSocial = group.schema_version < 2
      ? "legacy schema v1"
      : `${group.jev_social_version} @ ${shortCommit(group.jev_social_commit)}`;
    lines.push(`| ${group.id} | ${group.task_id} | ${jevSocial} | ${group.jev_model} | ${group.socai_version} @ ${shortCommit(group.socai_commit)} | ${group.profile_mode} | ${group.region} | ${group.result_limit} / ${group.max_steps} | ${group.startedAt} – ${group.endedAt} | ${group.publicationStatus} |`);
  }

  lines.push(
    "",
    "## Non-success outcomes",
    "",
    "| Group | Stop reason | Count |",
    "| --- | --- | ---: |",
  );
  let failureRows = 0;
  for (const group of summary.groups) {
    for (const [reason, count] of Object.entries(group.stopReasons)) {
      lines.push(`| ${group.id} | ${reason} | ${count} |`);
      failureRows += 1;
    }
  }
  if (!failureRows) lines.push("| — | none | 0 |");
  lines.push("");
  return lines.join("\n");
}

const parseArgs = (args) => {
  if (args.includes("--help") || args.includes("-h")) return { help: true };
  if (args.length !== 2 || args[0] !== "--input" || !args[1]) {
    throw new TypeError("usage: node benchmark/summary.js --input <rows.ndjson>");
  }
  return { input: args[1] };
};

const loadRows = async (filename) => {
  let source;
  try {
    const metadata = await stat(filename);
    if (!metadata.isFile() || metadata.size > MAX_INPUT_BYTES) throw new Error();
    source = await readFile(filename, "utf8");
  } catch {
    throw new TypeError("could not read benchmark NDJSON input");
  }
  return source.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line)];
    } catch {
      throw new TypeError(`line ${index + 1}: invalid JSON`);
    }
  });
};

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      process.stdout.write("Usage: node benchmark/summary.js --input <rows.ndjson>\n");
      return;
    }
    process.stdout.write(renderBenchmarkSummary(summarizeBenchmarkRows(await loadRows(args.input))));
  } catch (error) {
    process.stderr.write(`benchmark summary failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
