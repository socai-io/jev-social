import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { verifyNpmVersion, verifyReleaseMetadata } from "../scripts/verify-release.js";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const packageLock = JSON.parse(readFileSync(new URL("package-lock.json", root), "utf8"));
const codexManifest = JSON.parse(
  readFileSync(new URL(".codex-plugin/plugin.json", root), "utf8"),
);
const grokManifest = JSON.parse(
  readFileSync(new URL(".grok-plugin/plugin.json", root), "utf8"),
);
const skillContents = readFileSync(new URL("skills/jev-social/SKILL.md", root), "utf8");
const workflow = readFileSync(new URL(".github/workflows/npm-publish.yml", root), "utf8");
const commit = "a".repeat(40);

function metadata(overrides = {}) {
  return {
    packageJson,
    packageLock,
    codexManifest,
    grokManifest,
    skillContents,
    releaseTag: `v${packageJson.version}`,
    eventCommit: commit,
    checkoutCommit: commit,
    ...overrides,
  };
}

function npmPack() {
  const cache = mkdtempSync(join(tmpdir(), "jev-social-npm-publish-"));
  try {
    const args = ["pack", "--dry-run", "--ignore-scripts", "--json", "--cache", cache];
    const output = process.env.npm_execpath
      ? execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
          cwd: root,
          encoding: "utf8",
        })
      : execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
          cwd: root,
          encoding: "utf8",
        });
    return JSON.parse(output)[0];
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
}

test("release metadata must identify one immutable package build", () => {
  assert.deepEqual(verifyReleaseMetadata(metadata()), {
    commit,
    packageName: "jev-social",
    releaseTag: `v${packageJson.version}`,
    version: packageJson.version,
  });

  assert.throws(
    () => verifyReleaseMetadata(metadata({ releaseTag: "v9.9.9" })),
    /release tag must equal package version/u,
  );
  assert.throws(
    () => verifyReleaseMetadata(metadata({
      packageJson: { ...packageJson, version: "1.2.3-beta.1" },
      releaseTag: "v1.2.3-beta.1",
    })),
    /package version must be stable semantic versioning/u,
  );
  assert.throws(
    () => verifyReleaseMetadata(metadata({ checkoutCommit: "b".repeat(40) })),
    /checked-out commit must equal the release event commit/u,
  );
  assert.throws(
    () => verifyReleaseMetadata(metadata({ eventCommit: "b".repeat(40) })),
    /checked-out commit must equal the release event commit/u,
  );
  assert.throws(
    () => verifyReleaseMetadata(metadata({
      packageLock: { ...packageLock, version: "9.9.9" },
    })),
    /package-lock version must equal package version/u,
  );
  assert.throws(
    () => verifyReleaseMetadata(metadata({
      codexManifest: { ...codexManifest, version: "9.9.9" },
    })),
    /plugin manifest versions must equal package version/u,
  );
});

test("trusted publishing requires an OIDC-capable npm CLI", () => {
  assert.equal(verifyNpmVersion("11.5.1"), "11.5.1");
  assert.equal(verifyNpmVersion("12.0.0"), "12.0.0");
  assert.throws(() => verifyNpmVersion("11.5.0"), /npm 11\.5\.1 or newer/u);
  assert.throws(() => verifyNpmVersion("10.9.9"), /npm 11\.5\.1 or newer/u);
  assert.throws(() => verifyNpmVersion("11.5.1-beta.0"), /stable semantic version/u);
  assert.throws(() => verifyNpmVersion("latest"), /stable semantic version/u);
});

test("npm publishing uses a release-only OIDC workflow without a registry token", () => {
  assert.match(workflow, /^on:\n  release:\n    types: \[published\]/mu);
  assert.match(workflow, /permissions:\n  contents: read\n/u);
  assert.match(workflow, /github\.event\.release\.immutable == true/u);
  assert.match(workflow, /verify:[\s\S]+publish:\n    needs: verify/u);
  assert.match(workflow, /environment:\n      name: npm/u);
  assert.match(workflow, /actions\/checkout@[0-9a-f]{40} # v7\.0\.1/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.equal(workflow.match(/ref: \$\{\{ github\.sha \}\}/gu)?.length, 2);
  assert.match(workflow, /actions\/setup-node@[0-9a-f]{40} # v7\.0\.0/u);
  assert.match(workflow, /node-version: 24/u);
  assert.match(workflow, /package-manager-cache: false/u);
  assert.match(workflow, /registry-url: https:\/\/registry\.npmjs\.org/u);
  assert.match(workflow, /RELEASE_TAG: \$\{\{ github\.event\.release\.tag_name \}\}/u);
  assert.equal(workflow.match(/run: node scripts\/verify-release\.js/gu)?.length, 2);
  assert.match(workflow, /npm ci --ignore-scripts/u);
  assert.match(workflow, /npm run check/u);
  assert.match(workflow, /npm test/u);
  assert.match(workflow, /permissions:\n      contents: read\n      id-token: write/u);
  assert.match(workflow, /npm publish --ignore-scripts --provenance --access public/u);
  assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./u);
  assert.doesNotMatch(workflow, /workflow_dispatch/u);

  const verifyPosition = workflow.indexOf("run: node scripts/verify-release.js");
  const installPosition = workflow.indexOf("run: npm ci --ignore-scripts");
  const publishVerifyPosition = workflow.lastIndexOf("run: node scripts/verify-release.js");
  const publishPosition = workflow.indexOf("run: npm publish --ignore-scripts");
  assert.ok(verifyPosition > -1 && verifyPosition < installPosition);
  assert.ok(installPosition < publishPosition);
  assert.ok(publishVerifyPosition > installPosition && publishVerifyPosition < publishPosition);
});

test("the npm tarball has one reviewed file set and no bundled dependencies", () => {
  const packed = npmPack();
  const files = packed.files.map(({ path }) => path);

  assert.equal(packed.name, "jev-social");
  assert.equal(packed.version, packageJson.version);
  assert.deepEqual(packed.bundled, []);
  assert.deepEqual(files, [
    "LICENSE",
    "README.md",
    "benchmark/fixtures/valid-row.json",
    "benchmark/README.md",
    "benchmark/run.js",
    "benchmark/schema.js",
    "benchmark/summary.js",
    "benchmark/tasks/instagram.json",
    "benchmark/tasks/linkedin.json",
    "benchmark/tasks/tiktok.json",
    "bin/jev-social.js",
    "docs/creator-lab-license.txt",
    "docs/reels-import.md",
    "docs/troubleshooting.md",
    "package.json",
    "public/app.js",
    "public/evidence-items.js",
    "public/evidence-preview.js",
    "public/index.html",
    "public/platforms/instagram.png",
    "public/platforms/linkedin.svg",
    "public/platforms/tiktok.png",
    "public/prompts.js",
    "public/report-download.js",
    "public/report-stream.js",
    "public/run-route.js",
    "public/status.js",
    "public/styles.css",
    "public/view-focus.js",
    "schemas/reels-v1.schema.json",
    "skills/jev-social/agents/openai.yaml",
    "skills/jev-social/SKILL.md",
    "src/actions.js",
    "src/app.js",
    "src/classifier.js",
    "src/config.js",
    "src/decision-provider.js",
    "src/env.js",
    "src/errors.js",
    "src/evidence.js",
    "src/index.js",
    "src/onboard.js",
    "src/process.js",
    "src/query.js",
    "src/reels-contract.js",
    "src/reels.js",
    "src/report.js",
    "src/runs.js",
    "src/server.js",
    "src/socai.js",
  ]);
  assert.ok(files.every((path) => !path.startsWith("/") && !path.includes("..")));
  assert.ok(files.every((path) => !/(?:^|\/)(?:\.env(?:[./]|$)|\.git(?:\/|$)|\.github(?:\/|$)|runs?(?:\/|$)|cookies?(?:\/|$))/iu.test(path)));
});
