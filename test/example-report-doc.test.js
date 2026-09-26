import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function evidenceRows(report) {
  const section = report.match(/## Evidence ledger\r?\n([\s\S]*?)(?=\r?\n## )/);
  assert.ok(section, "the report must retain a dedicated evidence ledger");
  return section[1]
    .split(/\r?\n/)
    .filter((line) => /^\| E\d{2} \|/.test(line))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
}

test("the public Instagram example separates inspected evidence from discovery cards", async () => {
  const report = await readFile(new URL("../docs/example-report.md", import.meta.url), "utf8");
  const rows = evidenceRows(report);

  assert.equal(rows.length, 4);
  assert.deepEqual(
    rows.map(([id, source, state]) => ({ id, source, state })),
    [
      { id: "E01", source: "Withheld from public copy", state: "`opened-post`" },
      { id: "E02", source: "Withheld from public copy", state: "`discovery-only`" },
      { id: "E03", source: "Withheld from public copy", state: "`discovery-only`" },
      { id: "E04", source: "Withheld from public copy", state: "`discovery-only`" },
    ],
  );

  assert.match(report, /Only E01 supports an inspected-post observation/i);
  assert.match(report, /E02–E04 are discovery hypotheses, not findings/i);
  assert.doesNotMatch(report, /The results skewed toward/i);
  assert.doesNotMatch(report, /^## Key themes$/m);
});

test("the public Instagram example discloses provenance, privacy, and retention gaps", async () => {
  const [report, readme] = await Promise.all([
    readFile(new URL("../docs/example-report.md", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
  ]);
  const links = [...report.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1]);
  const absoluteUrls = report.match(/https?:\/\/[^\s)"'>]+/g) ?? [];

  assert.match(report, /exact capture timestamp[^.]+not retained/i);
  assert.match(report, /record-to-query mapping[^.]+not retained/i);
  assert.match(report, /provider and model identity[^.]+not retained/i);
  assert.match(report, /intentionally withholds the four canonical source URLs/i);
  assert.match(report, /no automatic cleanup schedule/i);
  assert.match(report, /does not prove that the local run artifacts were deleted/i);
  assert.match(report, /SECURITY\.md/);
  assert.deepEqual(
    links.sort(),
    ["../README.md#run-it", "../SECURITY.md", "https://socai-io.github.io/jev-social/"].sort(),
  );
  assert.deepEqual([...new Set(absoluteUrls)].sort(), ["https://socai-io.github.io/jev-social/"]);
  assert.doesNotMatch(report, /<a\b/i);
  assert.doesNotMatch(report, /<https?:\/\//i);
  assert.doesNotMatch(report, /^\s*\[[^\]]+\]:\s+\S+/m);
  assert.doesNotMatch(report, /instagram\.com/i);
  assert.doesNotMatch(report, /@[a-z\d._]+/i);
  assert.doesNotMatch(
    report,
    /Aman Sanger|Maor Shlomo|Mira Murati|Thomas Guthrie|Cursor|Anysphere|Base44|Thinking Machines|Runwise|TechCrunch|Wall Street Journal/i,
  );
  assert.doesNotMatch(report, /\b(?:18,000|250K|15-year-old)\b|\$(?:189K|80M|12B)/i);
  assert.doesNotMatch(report, /\b(?:github\.com\/)?socai-io\/socai\b/i);
  assert.doesNotMatch(report, /\b(?:www\.)?socai\.io\b/i);
  assert.match(readme, /Sanitized public copy; one opened post is separated from three discovery cards/);
  assert.doesNotMatch(readme, /Four source-linked records after two searches and one post-detail read/);
});
