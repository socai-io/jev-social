import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import test from "node:test";

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const releaseTag = `v${packageJson.version}`;
const pinnedSource = `github:socai-io/jev-social#v${packageJson.version}`;
const pinnedSkillSource = `https://github.com/socai-io/jev-social/tree/v${packageJson.version}/skills/jev-social`;
const skillContents = await readFile(new URL("../skills/jev-social/SKILL.md", import.meta.url), "utf8");
const runtimePins = skillContents.match(/github:socai-io\/jev-social#[0-9a-f]{40}/g) ?? [];
const uniqueRuntimePins = [...new Set(runtimePins)];
const releaseCommit = uniqueRuntimePins.length === 1 ? uniqueRuntimePins[0].split("#")[1] : "";
const [readmeContents, llmsContents] = await Promise.all([
  readFile(new URL("../README.md", import.meta.url), "utf8"),
  readFile(new URL("../site/llms.txt", import.meta.url), "utf8"),
]);
const openClawSkillCommits = [readmeContents, llmsContents]
  .flatMap((contents) => [...contents.matchAll(
    /npx skills add https:\/\/github\.com\/socai-io\/jev-social\/tree\/([0-9a-f]{40})\/skills\/jev-social --skill jev-social --agent openclaw --copy/g,
  )].map((match) => match[1]));
const uniqueOpenClawSkillCommits = [...new Set(openClawSkillCommits)];
const openClawSkillCommit = uniqueOpenClawSkillCommits.length === 1
  ? uniqueOpenClawSkillCommits[0]
  : "";
const pinnedOpenClawSkillSource = `https://github.com/socai-io/jev-social/tree/${openClawSkillCommit}/skills/jev-social`;
const kevRepoCommit = "2855ba2a55a80579176a459f78b95d03548cabb5";
const kevModelRevision = "139fdd94f1b6a6ad80cc15e08fcb99cac885a101";
const simpleJevRepoCommit = "c077d5dfdb5c2c7dd24b17d5f556f07e0162dc1c";
const simpleJevModelRevision = "851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a";
const pinnedKevCommands = [
  "git clone https://github.com/jaredpalmer/kev.git",
  "cd kev",
  `git checkout ${kevRepoCommit}`,
  "uv sync --extra serve",
  `uv run --extra serve python -m kev.serve --run jaredpalmer/kev-4b@${kevModelRevision} --port 8009`,
];
const pinnedSimpleJevCommands = [
  "git clone https://github.com/featherless-ai/simple-jev.git",
  "cd simple-jev",
  `git checkout ${simpleJevRepoCommit}`,
  "python3 -m venv .venv",
  "source .venv/bin/activate",
  "python -m pip install -e './hf-server'",
  `python hf-server/hf_server.py --model Qwen/Qwen3.5-4B --revision ${simpleJevModelRevision} --served-model-name simple-jev-qwen3.5-4b --enforce-model-id --device auto --dtype bfloat16 --max-model-len 16384 --max-choice-options 255 --max-batch-size 4 --max-batch-tokens 16384 --host 127.0.0.1 --port 8000`,
  "curl --fail http://127.0.0.1:8000/health",
];
const publicDocs = [
  ["README.md", new URL("../README.md", import.meta.url)],
  ["docs/troubleshooting.md", new URL("../docs/troubleshooting.md", import.meta.url)],
  ["site/index.html", new URL("../site/index.html", import.meta.url)],
  ["site/local-system-one/index.html", new URL("../site/local-system-one/index.html", import.meta.url)],
  ["site/social-research/index.html", new URL("../site/social-research/index.html", import.meta.url)],
  ["site/llms.txt", new URL("../site/llms.txt", import.meta.url)],
];

function normalizedVisibleText(contents) {
  const attributeValues = [...contents.matchAll(/\b(?:aria-label|content|title)="([^"]*)"/gi)]
    .map((match) => match[1])
    .join(" ");
  return `${contents.replace(/<[^>]*>/g, " ")} ${attributeValues}`
    .replace(/&(?:nbsp|ensp|emsp|thinsp|hyphen|ndash|mdash);/gi, " ")
    .replace(/&#(?:x[a-f\d]+|\d+);/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function htmlSectionById(contents, id) {
  const sectionTags = /<\/?section\b[^>]*>/gi;
  const idPattern = new RegExp(`\\bid\\s*=\\s*(["'])${id}\\1`, "i");
  let start = null;
  let depth = 0;
  for (const match of contents.matchAll(sectionTags)) {
    const closing = /^<\//u.test(match[0]);
    if (start === null) {
      if (!closing && idPattern.test(match[0])) {
        start = match.index;
        depth = 1;
      }
      continue;
    }
    depth += closing ? -1 : 1;
    if (depth === 0) return contents.slice(start, match.index + match[0].length);
  }
  return "";
}

function markdownH2Section(contents, title) {
  const start = contents.indexOf(`## ${title}`);
  if (start < 0) return "";
  const next = contents.indexOf("\n## ", start + title.length + 3);
  return contents.slice(start, next < 0 ? contents.length : next);
}

function extractKevCommands(contents) {
  const prefixes = [
    "git clone https://github.com/jaredpalmer/kev.git",
    "cd kev",
    `git checkout ${kevRepoCommit}`,
    "uv sync --extra serve",
    "uv run --extra serve python -m kev.serve ",
  ];
  return contents
    .replace(/<[^>]*>/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => prefixes.some((prefix) => line.startsWith(prefix)));
}

function extractSimpleJevCommands(contents) {
  const prefixes = [
    "git clone https://github.com/featherless-ai/simple-jev.git",
    "cd simple-jev",
    `git checkout ${simpleJevRepoCommit}`,
    "python3 -m venv .venv",
    "source .venv/bin/activate",
    "python -m pip install -e './hf-server'",
    "python hf-server/hf_server.py ",
    "curl --fail http://127.0.0.1:8000/health",
  ];
  return contents
    .replace(/<[^>]*>/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => prefixes.some((prefix) => line.startsWith(prefix)));
}

function assertNoAffirmativeOfflineClaim(contents) {
  const normalized = normalizedVisibleText(contents);
  const withoutExplicitLimit = normalized.replace(
    /\bnot\s+(?:fully|completely)[\s-]+offline\b/gi,
    "",
  );
  assert.doesNotMatch(withoutExplicitLimit, /\b(?:fully|completely)[\s-]+offline\b/i);
}

test("public no-clone commands require consent and pin the current release", async () => {
  for (const [name, url] of publicDocs) {
    const contents = await readFile(url, "utf8");
    assert.doesNotMatch(contents, /\bnpx\b[^\n]*\s--yes\b/, `${name} must not auto-consent to downloads`);

    const githubPackages = contents.match(/github:socai-io\/jev-social(?:#[^\s"'<`]+)?/g) ?? [];
    assert.ok(githubPackages.length > 0, `${name} must expose a GitHub-backed command`);
    for (const source of githubPackages) {
      assert.equal(source, pinnedSource, `${name} must pin the current release`);
    }
  }
});

test("top-level quickstarts state the socai installer platform boundary", async () => {
  const landing = await readFile(new URL("../site/index.html", import.meta.url), "utf8");
  const readmeTryQuickstart = markdownH2Section(readmeContents, "Try it");
  const readmeRunQuickstart = markdownH2Section(readmeContents, "Run it");
  const landingQuickstart = normalizedVisibleText(htmlSectionById(landing, "run"));
  const expectedBoundary = [
    "With the default OpenRouter provider, onboarding prompts for the OpenRouter key.",
    "On macOS and Windows, onboarding can also install the official socai CLI when it is missing.",
    "On Linux, install a current socai CLI from source first, then put it on PATH or set SOCAI_BIN.",
  ].join(" ");

  for (const quickstart of [readmeTryQuickstart, readmeRunQuickstart, landingQuickstart]) {
    assert.ok(
      quickstart.replaceAll("`", "").includes(expectedBoundary),
      "each top-level quickstart must state the exact provider and installer boundary",
    );
  }
});

test("machine-readable setup avoids command-line credentials and exposes the Agent Skill", async () => {
  const contents = await readFile(new URL("../site/llms.txt", import.meta.url), "utf8");
  assert.doesNotMatch(contents, /OPENROUTER_API_KEY\s*=.*\bnpx\b/);
  assert.match(
    contents,
    new RegExp(`gh skill install socai-io/jev-social jev-social@v${packageJson.version}\\b`),
  );
});

test("cross-agent Skill installers use an immutable release source", async () => {
  for (const [name, url] of publicDocs) {
    const contents = await readFile(url, "utf8");
    assert.doesNotMatch(
      contents,
      /npx skills add socai-io\/jev-social\b/,
      `${name} must not install the mutable default branch`,
    );
    for (const command of contents.match(/npx skills add [^\n<`]*/g) ?? []) {
      assert.ok(
        command.includes(pinnedSkillSource) || command.includes(pinnedOpenClawSkillSource),
        `${name} must pin the release tag or its exact commit`,
      );
    }
  }
});

test("OpenClaw setup uses the verified immutable release Skill command", async () => {
  const expected = `npx skills add ${pinnedOpenClawSkillSource} --skill jev-social --agent openclaw --copy`;
  const landing = await readFile(new URL("../site/index.html", import.meta.url), "utf8");

  assert.equal(openClawSkillCommits.length, 2, "README and llms.txt must each pin OpenClaw once");
  assert.equal(uniqueOpenClawSkillCommits.length, 1, "OpenClaw docs must use one Skill source commit");
  assert.match(readmeContents, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(llmsContents, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(llmsContents, /standard Agent Skill[\s\S]*not an OpenCode or OpenClaw plugin/i);
  assert.match(landing, /Codex, OpenCode, or OpenClaw/);

  const installedSkill = execFileSync(
    "git",
    ["show", `${openClawSkillCommit}:skills/jev-social/SKILL.md`],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );
  const installedRuntimePins = installedSkill.match(
    /github:socai-io\/jev-social#[0-9a-f]{40}/g,
  ) ?? [];
  assert.ok(installedRuntimePins.length > 0, "the installed OpenClaw Skill must pin a runtime");
  assert.deepEqual(
    [...new Set(installedRuntimePins)],
    [`github:socai-io/jev-social#${releaseCommit}`],
    "the installed OpenClaw Skill must pin the v0.1.10 runtime",
  );
  const skillSourcePackage = JSON.parse(execFileSync(
    "git",
    ["show", `${openClawSkillCommit}:package.json`],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  ));
  assert.equal(
    skillSourcePackage.version,
    packageJson.version,
    "the immutable OpenClaw Skill source must identify the current release",
  );
});

test("package, plugin manifests, and Agent Skill identify the current release", async () => {
  const [codexManifest, grokManifest] = await Promise.all([
    readFile(new URL("../.codex-plugin/plugin.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../.grok-plugin/plugin.json", import.meta.url), "utf8").then(JSON.parse),
  ]);

  assert.equal(codexManifest.version, packageJson.version);
  assert.equal(grokManifest.version, packageJson.version);
  assert.equal(codexManifest.homepage, packageJson.homepage);
  assert.equal(codexManifest.repository, "https://github.com/socai-io/jev-social");
  assert.equal(codexManifest.interface.websiteURL, packageJson.homepage);
  assert.ok(skillContents.includes(`release \`${releaseTag}\``));

  assert.ok(runtimePins.length > 0, "the Agent Skill must pin an immutable runtime commit");
  assert.equal(uniqueRuntimePins.length, 1, "all Agent Skill commands must use one runtime commit");
  const runtimePackage = JSON.parse(execFileSync(
    "git",
    ["show", `${releaseCommit}:package.json`],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  ));
  assert.equal(
    runtimePackage.version,
    packageJson.version,
    "the immutable Agent Skill runtime must identify the current release",
  );
});

test("the Pages artifact retains the .nojekyll marker", async () => {
  const workflow = await readFile(new URL("../.github/workflows/pages.yml", import.meta.url), "utf8");
  assert.match(workflow, /touch _site\/\.nojekyll/);
  assert.match(
    workflow,
    /actions\/upload-pages-artifact@[^\n]+# v5\.0\.0[\s\S]*?with:\n\s+path: _site\n\s+include-hidden-files: true/,
  );
});

test("the Pages landing exposes current structured metadata and recorded evidence", async () => {
  const landing = await readFile(new URL("../site/index.html", import.meta.url), "utf8");
  const structuredData = landing.match(
    /<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/,
  );
  assert.ok(structuredData, "site/index.html must include JSON-LD");

  const software = JSON.parse(structuredData[1]);
  assert.equal(software["@type"], "SoftwareApplication");
  assert.equal(software.softwareVersion, packageJson.version);
  assert.equal(software.codeRepository, "https://github.com/socai-io/jev-social");
  assert.equal(software.offers?.price, "0");
  assert.ok(software.sameAs?.includes("https://ossdrop.com/tool/jev-social"));

  for (const expected of [
    "docs/example-report.md",
    "docs/tiktok-evidence.md#search",
    "docs/tiktok-evidence.md#video-detail-and-media-download",
    "https://ossdrop.com/tool/jev-social",
  ]) {
    assert.match(landing, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(
    landing,
    /<a class="text-link" href="https:\/\/skills\.sh\/socai-io\/jev-social\/jev-social" rel="noreferrer">Browse the Agent Skill on skills\.sh ↗<\/a>/,
  );
  assert.match(landing, /individual local observations, not a benchmark/i);
  assert.match(landing, /\.\/local-system-one\//);
  assert.match(landing, /\.\/social-research\//);
  assert.doesNotMatch(landing, /github\.com\/socai-io\/socai/);
  assert.doesNotMatch(landing, /https:\/\/(?:www\.)?socai\.io/);
});

test("the README keeps Jev Social promotion separate from the socai runtime", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const sourceCheckout = readme.match(
    /To work from a source checkout instead:\r?\n[\s\S]*?```bash\r?\n([\s\S]*?)\r?\n```/,
  );

  assert.match(readme, /\bsocai CLI\b/);
  assert.match(readme, /star Jev Social/i);
  assert.ok(sourceCheckout, "the README must retain a fenced source-checkout sequence");
  assert.deepEqual(
    sourceCheckout[1].split(/\r?\n/),
    [
      "git clone https://github.com/socai-io/jev-social.git",
      "cd jev-social",
      "npm install",
      "npm start -- onboard",
      "npm start",
    ],
  );
  assert.match(readme, /On Linux,[^.]+(?:PATH|SOCAI_BIN)[^.]+onboarding\./);
  assert.ok(readme.includes(
    '[good first issues](https://github.com/socai-io/jev-social/issues?q=is%3Aissue%20state%3Aopen%20label%3A%22good%20first%20issue%22)',
  ));
  assert.ok(readme.includes(
    "[CONTRIBUTING.md](https://github.com/socai-io/jev-social/blob/main/CONTRIBUTING.md)",
  ));
  assert.doesNotMatch(
    readme,
    /https?:\/\/(?:www\.)?github\.com\/socai-io\/socai(?:\.git)?(?=$|[\s/?#)"'<])/i,
  );
  assert.doesNotMatch(readme, /https:\/\/(?:www\.)?socai\.io/);
  assert.doesNotMatch(readme, /(?:star|visit|try|explore|check out) (?:the )?socai\b/i);
  assert.doesNotMatch(readme, /(?:call|run|use|install|download) (?:the )?socai(?: CLI)? directly/i);
  assert.doesNotMatch(readme, /^socai\s+(?:instagram|tiktok|linkedin)\s+/im);
});

test("the local UI keeps project links scoped to Jev Social", async () => {
  const landing = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

  assert.match(landing, /https:\/\/socai-io\.github\.io\/jev-social\/social-research\//);
  assert.match(landing, /https:\/\/github\.com\/socai-io\/jev-social/);
  assert.doesNotMatch(landing, /https:\/\/(?:www\.)?socai\.io/);
  assert.doesNotMatch(landing, /github\.com\/socai-io\/socai(?:\.git)?(?=$|[\s/?#)"'<])/i);
});

test("the README exposes the privacy and local-data boundaries", async () => {
  const [readme, security] = await Promise.all([
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../SECURITY.md", import.meta.url), "utf8"),
  ]);
  const privacySection = readme.match(
    /## Privacy and local data\r?\n([\s\S]*?)(?=\r?\n## )/,
  );
  const securityLinkIndex = readme.indexOf("[Security and data flow](SECURITY.md)");
  const firstInstallCommandIndex = readme.indexOf("npx github:");

  assert.ok(privacySection, "the README must include a dedicated privacy section");
  assert.notEqual(securityLinkIndex, -1, "the README must link to the security data-flow policy");
  assert.notEqual(firstInstallCommandIndex, -1, "the README must retain the no-clone install command");
  assert.ok(
    securityLinkIndex < firstInstallCommandIndex,
    "the security link must appear before the first installation command",
  );
  assert.match(privacySection[1], /does not read or copy the browser cookie store directly/i);
  assert.match(privacySection[1], /user input and visible social content are untrusted/i);
  assert.match(privacySection[1], /OPENROUTER_REPORT_MODEL=off/);
  assert.match(privacySection[1], /SOCAI_TELEMETRY=0/);
  assert.match(privacySection[1], /no automatic cleanup schedule/i);
  assert.match(privacySection[1], /only when the research goal explicitly requests/i);
  assert.match(security, /github\.com\/socai-io\/socai\/blob\/v0\.6\.1\/docs\/telemetry-schema\.md/);
  assert.match(security, /SOCAI_TELEMETRY_QUERY_TEXT=off/);
  assert.match(security, /SOCAI_TELEMETRY_CHAT_TEXT=off/);
  assert.match(security, /third-party observability provider Axiom/i);
  assert.match(security, /full phone number/i);
  assert.match(security, /does not remove those targets or other metadata/i);
  assert.match(security, /pattern-based secret scrubbing/i);
  assert.match(security, /does not pin the installed socai executable/i);
  assert.match(security, /does not specify a server-side deletion or retention period/i);
});

test("the social research guide is shipped with exact platform and safety boundaries", async () => {
  const [guide, sitemap, workflow, llms] = await Promise.all([
    readFile(new URL("../site/social-research/index.html", import.meta.url), "utf8"),
    readFile(new URL("../site/sitemap.xml", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/pages.yml", import.meta.url), "utf8"),
    readFile(new URL("../site/llms.txt", import.meta.url), "utf8"),
  ]);
  const structuredData = guide.match(
    /<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/,
  );
  assert.ok(structuredData, "the social research guide must include JSON-LD");
  const graph = JSON.parse(structuredData[1])["@graph"];
  assert.ok(Array.isArray(graph));
  const article = graph.find((entry) => entry["@type"] === "TechArticle");
  const faq = graph.find((entry) => entry["@type"] === "FAQPage");
  assert.equal(
    article?.url,
    "https://socai-io.github.io/jev-social/social-research/",
  );
  assert.equal(article?.headline, "Open-source social media research with Jev Social");
  assert.equal(
    article?.description,
    "Open-source Instagram, TikTok, and LinkedIn research agent. Jev chooses bounded steps; the local socai CLI captures source-linked evidence in Chrome.",
  );
  assert.equal(article?.about?.codeRepository, "https://github.com/socai-io/jev-social");
  assert.equal(faq?.mainEntity?.length, 4);
  const networkFaq = faq?.mainEntity?.find(
    (entry) => entry.name === "What still needs network access?",
  );
  assert.equal(
    networkFaq?.acceptedAnswer?.text,
    "Chrome and the selected social platform still require normal network access. With an OpenRouter key configured, report synthesis also uses OpenRouter unless OPENROUTER_REPORT_MODEL=off; only typed decision calls can move to an explicit loopback provider.",
  );
  assert.match(
    guide,
    /<dt>What still needs network access\?<\/dt>\s*<dd>Chrome and the selected social platform still require normal network access\. With an OpenRouter key configured, report synthesis also uses OpenRouter unless OPENROUTER_REPORT_MODEL=off; only typed decision calls can move to an explicit loopback provider\.<\/dd>/,
  );
  assert.match(
    guide,
    /<title>Open-source social media research agent \| Jev Social<\/title>/,
  );
  assert.match(
    guide,
    /<meta name="description" content="Open-source Instagram, TikTok, and LinkedIn research agent\. Jev chooses bounded steps; the local socai CLI captures source-linked evidence in Chrome\.">/,
  );
  assert.match(
    guide,
    /<meta property="og:title" content="Jev Social — open-source social media research agent">/,
  );
  assert.match(
    guide,
    /<meta property="og:description" content="Jev chooses bounded steps while the local socai CLI captures source-linked Instagram, TikTok, and LinkedIn evidence in Chrome\.">/,
  );
  assert.match(
    guide,
    /<meta name="twitter:title" content="Jev Social — open-source social media research agent">/,
  );
  assert.match(
    guide,
    /<meta name="twitter:description" content="Bounded Jev decisions, real Chrome evidence, and source-linked Instagram, TikTok, and LinkedIn research\.">/,
  );
  assert.match(
    guide,
    /<p class="hero-copy">\s*Jev Social is an open-source, read-only social media research agent for Instagram, TikTok, and LinkedIn\. Jev chooses what to inspect next; the local socai CLI performs that operation in Chrome; captured sources stay beside the report\.\s*<\/p>/,
  );
  assert.doesNotMatch(guide, /<\/p>\s*<\/p>/, "the guide must not contain a stray closing paragraph tag");

  for (const expected of [
    "Creators, posts, Reels, comments",
    "Videos, authors, comments, media",
    "People, content, companies",
    "Media download appears only when the original goal explicitly requests it",
    "does not post, like, follow, message, purchase, or change settings",
    "partial evidence",
  ]) {
    assert.match(guide, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
  assert.doesNotMatch(guide, /github\.com\/socai-io\/socai/);
  assert.doesNotMatch(llms, /github\.com\/socai-io\/socai/);
  assertNoAffirmativeOfflineClaim(guide);
  assert.match(sitemap, /https:\/\/socai-io\.github\.io\/jev-social\/social-research\//);
  assert.match(llms, /https:\/\/socai-io\.github\.io\/jev-social\/social-research\//);
  assert.match(workflow, /mkdir -p _site\/assets\/platforms _site\/local-system-one _site\/social-research/);
  assert.match(
    workflow,
    /cp site\/social-research\/index\.html _site\/social-research\//,
  );
});

test("the local System One guide is shipped and keeps its local boundary honest", async () => {
  const [readme, troubleshooting, guide, sitemap, workflow] = await Promise.all([
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/troubleshooting.md", import.meta.url), "utf8"),
    readFile(new URL("../site/local-system-one/index.html", import.meta.url), "utf8"),
    readFile(new URL("../site/sitemap.xml", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/pages.yml", import.meta.url), "utf8"),
  ]);
  const structuredData = guide.match(
    /<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/,
  );
  assert.ok(structuredData, "the local guide must include JSON-LD");
  const article = JSON.parse(structuredData[1]);
  assert.equal(article["@type"], "TechArticle");
  assert.equal(
    article.url,
    "https://socai-io.github.io/jev-social/local-system-one/",
  );

  assert.match(guide, /http:\/\/127\.0\.0\.1:8009\/v1\/systemone/);
  assert.match(guide, /http:\/\/127\.0\.0\.1:8000\/v1\/systemone/);
  assert.match(guide, /OPENROUTER_REPORT_MODEL=off/);
  assert.match(guide, /No hosted key[\s\S]*Not fully offline/i);
  assert.match(guide, /social sites still load through your browser/i);
  assert.match(guide, /seven-case check covers decision compatibility/i);
  assert.match(guide, /docs\/simple-jev\.md/);
  for (const [name, contents] of [
    ["README.md", readme],
    ["docs/troubleshooting.md", troubleshooting],
    ["site/local-system-one/index.html", guide],
  ]) {
    assert.deepEqual(
      extractKevCommands(contents),
      pinnedKevCommands,
      `${name} must expose exactly one immutable Kev setup sequence`,
    );
    assert.doesNotMatch(
      contents,
      /--run\s+jaredpalmer\/kev-4b(?!@[0-9a-f]{40}\b)/,
      `${name} must not expose a mutable Kev model reference`,
    );
  }
  assert.deepEqual(
    extractSimpleJevCommands(guide),
    pinnedSimpleJevCommands,
    "the local guide must expose exactly one immutable Simple Jev setup sequence",
  );
  assert.doesNotMatch(
    guide,
    /--model\s+Qwen\/Qwen3\.5-4B(?![\s\S]{0,160}--revision\s+[0-9a-f]{40}\b)/,
    "the Simple Jev setup must pin the model revision",
  );
  assertNoAffirmativeOfflineClaim(guide);
  assert.match(sitemap, /https:\/\/socai-io\.github\.io\/jev-social\/local-system-one\//);
  assert.match(workflow, /mkdir -p _site\/assets\/platforms _site\/local-system-one/);
  assert.match(
    workflow,
    /cp site\/local-system-one\/index\.html _site\/local-system-one\//,
  );
});

test("the offline-claim guard normalizes markup and encoded separators", () => {
  for (const unsafeClaim of [
    "works fully offline",
    "works fully-offline",
    "works fully&nbsp;offline",
    "works fully&#45;offline",
    "works fully <em>offline</em>",
    '<meta name="description" content="works completely offline">',
  ]) {
    assert.throws(() => assertNoAffirmativeOfflineClaim(unsafeClaim));
  }
  assert.doesNotThrow(() => assertNoAffirmativeOfflineClaim("No hosted key. Not fully offline."));
});

test("public docs expose the reproducible benchmark workflow without claiming results", async () => {
  const [readme, llms] = await Promise.all([
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../site/llms.txt", import.meta.url), "utf8"),
  ]);

  for (const contents of [readme, llms]) {
    assert.match(contents, /reproducible benchmark/i);
    assert.match(contents, /benchmark\/README\.md/);
    assert.match(contents, /no live (?:benchmark )?(?:measurements|results)/i);
  }
});

test("the Grok plugin manifest exposes the released Jev Social skill", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../.grok-plugin/plugin.json", import.meta.url), "utf8"),
  );
  const skillDirectories = (await readdir(new URL("../skills/", import.meta.url), {
    withFileTypes: true,
  }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const skill = await readFile(new URL("../skills/jev-social/SKILL.md", import.meta.url), "utf8");

  assert.deepEqual(Object.keys(manifest).sort(), [
    "author",
    "description",
    "homepage",
    "keywords",
    "license",
    "name",
    "repository",
    "version",
  ]);
  assert.equal(manifest.name, packageJson.name);
  assert.equal(manifest.version, packageJson.version);
  assert.equal(manifest.license, packageJson.license);
  assert.equal(manifest.repository, "https://github.com/socai-io/jev-social");
  assert.equal(manifest.homepage, packageJson.homepage);
  assert.deepEqual(manifest.author, {
    name: "socai-io",
    url: "https://github.com/socai-io",
  });
  assert.ok(Array.isArray(manifest.keywords));
  assert.ok(manifest.keywords.length > 0);
  assert.ok(manifest.keywords.every((keyword) => typeof keyword === "string" && keyword.length > 0));
  assert.match(manifest.description, /Jev/);
  assert.match(manifest.description, /socai CLI/);
  assert.deepEqual(skillDirectories, ["jev-social"]);
  assert.match(skill, /^name: jev-social$/m);

  for (const componentPath of [
    "../commands/",
    "../agents/",
    "../hooks/hooks.json",
    "../.mcp.json",
    "../.lsp.json",
  ]) {
    await assert.rejects(
      access(new URL(componentPath, import.meta.url)),
      (error) => error?.code === "ENOENT",
      `${componentPath} would expand the Grok plugin beyond its single read-only skill`,
    );
  }
});
