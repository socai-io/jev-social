import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const pinnedSource = `github:socai-io/jev-social#v${packageJson.version}`;
const publicDocs = [
  ["README.md", new URL("../README.md", import.meta.url)],
  ["site/index.html", new URL("../site/index.html", import.meta.url)],
  ["site/llms.txt", new URL("../site/llms.txt", import.meta.url)],
];

test("public no-clone commands require consent and pin the current release", async () => {
  for (const [name, url] of publicDocs) {
    const contents = await readFile(url, "utf8");
    assert.doesNotMatch(contents, /npx\s+--yes\b/, `${name} must not auto-consent to downloads`);

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
