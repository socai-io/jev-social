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
const kevRepoCommit = "2855ba2a55a80579176a459f78b95d03548cabb5";
const kevModelRevision = "139fdd94f1b6a6ad80cc15e08fcb99cac885a101";
const pinnedKevCommands = [
  "git clone https://github.com/jaredpalmer/kev.git",
  "cd kev",
  `git checkout ${kevRepoCommit}`,
  "uv sync --extra serve",
  `uv run --extra serve python -m kev.serve --run jaredpalmer/kev-4b@${kevModelRevision} --port 8009`,
];
const publicDocs = [
  ["README.md", new URL("../README.md", import.meta.url)],
  ["docs/troubleshooting.md", new URL("../docs/troubleshooting.md", import.meta.url)],
  ["site/index.html", new URL("../site/index.html", import.meta.url)],
  ["site/local-system-one/index.html", new URL("../site/local-system-one/index.html", import.meta.url)],
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

function extractKevCommands(contents) {
  const prefixes = [
    "git clone https://github.com/jaredpalmer/kev.git",
    "cd kev",
    "git checkout ",
    "uv sync --extra serve",
    "uv run --extra serve python -m kev.serve ",
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

test("machine-readable setup avoids command-line credentials and exposes the Agent Skill", async () => {
  const contents = await readFile(new URL("../site/llms.txt", import.meta.url), "utf8");
  assert.doesNotMatch(contents, /OPENROUTER_API_KEY\s*=.*\bnpx\b/);
  assert.match(
    contents,
    new RegExp(`gh skill install socai-io/jev-social jev-social@v${packageJson.version}\\b`),
  );
});

test("cross-agent Skill installers use the tagged release", async () => {
  for (const [name, url] of publicDocs) {
    const contents = await readFile(url, "utf8");
    assert.doesNotMatch(
      contents,
      /npx skills add socai-io\/jev-social\b/,
      `${name} must not install the mutable default branch`,
    );
    for (const command of contents.match(/npx skills add [^\n<`]*/g) ?? []) {
      assert.match(command, new RegExp(pinnedSkillSource.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  }
});

test("package, plugin manifests, and Agent Skill identify the current release", async () => {
  const [codexManifest, grokManifest, skill] = await Promise.all([
    readFile(new URL("../.codex-plugin/plugin.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../.grok-plugin/plugin.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../skills/jev-social/SKILL.md", import.meta.url), "utf8"),
  ]);

  assert.equal(codexManifest.version, packageJson.version);
  assert.equal(grokManifest.version, packageJson.version);
  assert.ok(skill.includes(`release \`${releaseTag}\``));

  const runtimePins = skill.match(/github:socai-io\/jev-social#[0-9a-f]{40}/g) ?? [];
  assert.ok(runtimePins.length > 0, "the Agent Skill must pin an immutable runtime commit");
  assert.equal(new Set(runtimePins).size, 1, "all Agent Skill commands must use one runtime commit");
  const runtimeCommit = runtimePins[0].split("#")[1];
  const runtimePackage = JSON.parse(execFileSync(
    "git",
    ["show", `${runtimeCommit}:package.json`],
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
  assert.match(landing, /individual local observations, not a benchmark/i);
  assert.match(landing, /\.\/local-system-one\//);
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
  assert.match(guide, /OPENROUTER_REPORT_MODEL=off/);
  assert.match(guide, /No hosted key[\s\S]*Not fully offline/i);
  assert.match(guide, /social sites still load through your browser/i);
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
