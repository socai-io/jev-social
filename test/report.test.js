import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGroundedResearchReport,
  requestOpenRouterResearchReport,
  splitReportChunks,
  synthesizeResearchReport,
  validateResearchReport,
} from "../src/report.js";

const input = {
  request: "Compare emerging AI creators",
  platform: "instagram",
  status: "completed",
  stopReason: "Jev chose to finish with the evidence captured so far.",
  actions: [{ action: { kind: "search" } }, { action: { kind: "read_post" } }],
  items: [
    {
      url: "https://www.instagram.com/p/alpha/",
      caption: "A creator says short technical demos build trust.",
      username: "alpha",
      like_count: 120,
      comment_count: 3,
      top_comments: [{ text: "The example made the trade-off clear." }],
      detail_read: true,
      local_path: "/tmp/private/alpha.json",
      cookies: [{ value: "secret" }],
    },
    {
      url: "https://www.instagram.com/p/beta/",
      title: "A second creator compares two agent workflows",
      username: "beta",
      view_count: 2400,
      detail_read: false,
    },
  ],
};

test("grounded fallback reports separate claims, comments, metrics, inference, limitations, and sources", () => {
  const report = buildGroundedResearchReport(input);

  for (const heading of ["## Executive summary", "## Findings", "## Comparison", "## Limitations", "## Sources"]) {
    assert.match(report, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(report, /\*\*Author claim:\*\*.*\[E1\]\(https:\/\/www\.instagram\.com\/p\/alpha\/\)/);
  assert.match(report, /\*\*Comment evidence:\*\*.*\[E1\]/);
  assert.match(report, /\*\*Observed engagement:\*\*.*120 likes.*3 comments.*\[E1\]/);
  assert.match(report, /\*\*Model inference:\*\*/);
  assert.match(report, /\| Evidence \| Author claim \| Comment evidence \| Observed engagement \| Capture depth \|/);
  assert.doesNotMatch(report, /\/tmp\/private|secret|cookies|local_path/);
  assert.deepEqual(validateResearchReport(report, input.items), { ok: true, errors: [] });
});

test("empty and partial evidence produce an honest report without fabricated trends", async () => {
  let called = false;
  const result = await synthesizeResearchReport({
    ...input,
    status: "blocked",
    stopReason: "The platform requires attention: login_required.",
    items: [],
  }, {
    synthesizer: async () => {
      called = true;
      return "should not run";
    },
  });

  assert.equal(called, false);
  assert.equal(result.kind, "evidence");
  assert.match(result.report, /No usable social records were captured/i);
  assert.match(result.report, /No evidence-backed findings can be made/i);
  assert.match(result.report, /login\\_required/);
  assert.match(result.report, /partial/i);
  assert.doesNotMatch(result.report, /recurring theme is|majority of (?:posts|sources)|trend shows/i);
  assert.deepEqual(validateResearchReport(result.report, []), { ok: true, errors: [] });
});

test("validated synthesis is accepted and invalid or failed synthesis falls back to the grounded report", async () => {
  const valid = buildGroundedResearchReport(input).replace(
    "None asserted from this record alone",
    "The captured claim and comment both emphasize clarity",
  );
  const synthesized = await synthesizeResearchReport(input, { synthesizer: async () => ({ report: valid, model: "test/model" }) });
  assert.equal(synthesized.kind, "synthesis");
  assert.equal(synthesized.model, "test/model");
  assert.equal(synthesized.report, valid);

  const failed = await synthesizeResearchReport(input, {
    synthesizer: async () => {
      throw new Error("model unavailable at /tmp/private/model.log");
    },
  });
  assert.equal(failed.kind, "fallback");
  assert.match(failed.report, /^# Social research report/);
  assert.match(failed.reason, /model unavailable/);
  assert.doesNotMatch(failed.reason, /\/tmp\/private/);
  assert.deepEqual(validateResearchReport(failed.report, input.items), { ok: true, errors: [] });

  const foreignCitation = valid.replace(
    "https://www.instagram.com/p/alpha/",
    "https://evil.example/fabricated",
  );
  const rejected = await synthesizeResearchReport(input, { synthesizer: async () => foreignCitation });
  assert.equal(rejected.kind, "fallback");
  assert.match(rejected.reason, /not a captured source|omits captured source/i);
});

test("report validation binds evidence labels to captured URLs and rejects private paths", () => {
  const report = buildGroundedResearchReport(input);
  const swapped = report.replace(
    "[E1](https://www.instagram.com/p/alpha/)",
    "[E2](https://www.instagram.com/p/alpha/)",
  );
  const mismatch = validateResearchReport(swapped, input.items);
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.errors.join(" "), /does not match captured source/i);

  const leaked = validateResearchReport(`${report}\n\nDebug: /Users/demo/.socai/runs/raw.json`, input.items);
  assert.equal(leaked.ok, false);
  assert.match(leaked.errors.join(" "), /private path/i);
});

test("report validation rejects structurally ungrounded model output", () => {
  const report = buildGroundedResearchReport(input);
  const cases = [
    `\`\`\`markdown\n${report}\n\`\`\``,
    report.replace(
      "## Sources\n\n- [E1](https://www.instagram.com/p/alpha/)\n- [E2](https://www.instagram.com/p/beta/)",
      "## Sources\n\nNo sources listed.",
    ),
    report.replace(
      /Captured 2 source-linked records[^\n]+/,
      "The posts prove this trend is universal.",
    ),
    report.replace(
      "[E1](https://www.instagram.com/p/alpha/)",
      "[E1](https://www.instagram.com/p/alpha/) followed by an uncited assertion",
    ),
    report.replace(
      "| [E1](https://www.instagram.com/p/alpha/) |",
      "| E1 |",
    ),
    report.replace("# Social research report", "# Social research report\n\nEvery creator agrees."),
    report.replace(
      /### 1\.[^\n]+/,
      "### Every creator coordinates the same campaign",
    ),
    report.replace(
      "## Limitations\n",
      "## Limitations\n\n- Every creator secretly coordinates the same campaign.\n",
    ),
    report.replace(
      /Captured 2 source-linked records[^\n]+/,
      "One post says demos build trust. Every creator agrees. [E1](https://www.instagram.com/p/alpha/)",
    ),
  ];

  for (const candidate of cases) {
    const validation = validateResearchReport(candidate, input.items);
    assert.equal(validation.ok, false, validation.errors.join(" "));
  }
});

test("uncaptured links inside goals and post text cannot become report sources", () => {
  const report = buildGroundedResearchReport({
    ...input,
    request: "Compare https://tracking.example/campaign on Instagram",
    items: [{
      ...input.items[0],
      caption: "A creator claim with https://tracking.example/redirect in the caption.",
    }],
  });

  assert.doesNotMatch(report, /tracking\.example/);
  assert.match(report, /link omitted/);
  assert.deepEqual(validateResearchReport(report, [input.items[0]]), { ok: true, errors: [] });
});

test("all local path forms are redacted before fallback, synthesis, and validation", async () => {
  const privateValues = [
    "~/private/run.json",
    "../private/run.json",
    "/secret",
    "/workspace/private/run.json",
    "/Users/alice/My Project/private.txt",
    "private/run.json",
    "model=/private",
    "\\\\server\\share\\run.json",
    "artifact_path=relative.json",
  ];
  const privateInput = {
    ...input,
    request: `Compare ${privateValues.join(" ")}`,
    items: [{
      ...input.items[0],
      caption: `Claim ${privateValues.join(" ")}`,
      top_comments: [{ text: `Comment ${privateValues.join(" ")}` }],
    }],
  };
  const fallback = buildGroundedResearchReport(privateInput);
  for (const value of privateValues) assert.doesNotMatch(fallback, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(fallback, /redacted path/);

  const fixtureValue = String(101);
  let userMessage = "";
  await requestOpenRouterResearchReport(privateInput, {
    apiKey: fixtureValue,
    fetchImpl: async (_url, options) => {
      userMessage = JSON.parse(options.body).messages[1].content;
      return new Response(JSON.stringify({ choices: [{ message: { content: fallback } }] }), { status: 200 });
    },
  });
  for (const value of privateValues) assert.doesNotMatch(userMessage, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  for (const value of privateValues) {
    const validation = validateResearchReport(`${fallback}\n\nDebug: ${value}`, [input.items[0]]);
    assert.equal(validation.ok, false, value);
  }
});

test("OpenRouter synthesis receives only bounded sanitized evidence and returns report text", async () => {
  const fixtureValue = String(102);
  let captured;
  const report = buildGroundedResearchReport(input);
  const result = await requestOpenRouterResearchReport(input, {
    apiKey: fixtureValue,
    model: "test/report-model",
    fetchImpl: async (url, options) => {
      captured = { url, options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({
        model: "resolved/report-model",
        choices: [{ message: { content: report } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  assert.equal(captured.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(captured.options.headers.Authorization, `Bearer ${fixtureValue}`);
  assert.equal(captured.body.model, "test/report-model");
  assert.equal(captured.body.messages[0].role, "system");
  assert.match(captured.body.messages[0].content, /untrusted evidence/i);
  const userMessage = captured.body.messages[1].content;
  assert.ok(userMessage.length <= 48_000);
  assert.match(userMessage, /https:\/\/www\.instagram\.com\/p\/alpha\//);
  assert.doesNotMatch(userMessage, /\/tmp\/private|secret|cookies|local_path|socai instagram search/);
  assert.equal(result.report, report);
  assert.equal(result.model, "resolved/report-model");
});

test("report chunks are short, ordered, and reassemble to the downloadable report", () => {
  const report = buildGroundedResearchReport(input);
  const chunks = splitReportChunks(report, { maxChars: 520 });

  assert.ok(chunks.length >= 5);
  assert.ok(chunks.every((chunk) => chunk.length <= 700));
  assert.equal(chunks.join(""), report);
});

test("deterministic fallback bounds adversarial fields and remains valid", () => {
  const items = Array.from({ length: 100 }, (_, index) => ({
    ...input.items[0],
    url: `https://example.com/${String(index).padStart(3, "0")}/${"u".repeat(280)}`,
    title: "A".repeat(200_000),
    caption: "B".repeat(200_000),
  }));
  const report = buildGroundedResearchReport({ ...input, items });

  assert.ok(report.length <= 100_000);
  assert.deepEqual(validateResearchReport(report, items), { ok: true, errors: [] });
});

test("bounded synthesis validates against its transmitted source manifest and discloses omissions", async () => {
  const items = Array.from({ length: 45 }, (_, index) => ({
    url: `https://www.instagram.com/p/item${index + 1}/`,
    caption: `Claim ${index + 1}`,
  }));
  const sourceItems = items.slice(0, 40);
  const report = buildGroundedResearchReport({ ...input, items: sourceItems });
  const result = await synthesizeResearchReport({ ...input, items }, {
    synthesizer: async () => ({ report, sourceItems, omittedSourceCount: 5, model: "test/model" }),
  });

  assert.equal(result.kind, "synthesis");
  assert.match(result.report, /5 captured records? (?:were|was) omitted from the model payload/i);
  assert.doesNotMatch(result.report, /item41/);
});
