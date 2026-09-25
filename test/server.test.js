import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { saveRun } from "../src/runs.js";
import { startServer } from "../src/server.js";

test("local APIs require exact same-origin JSON and typed onboarding fields", async () => {
  const { server, url } = await startServer({ port: 0, open: false });
  try {
    const status = await fetch(`${url}/api/status`);
    assert.equal(status.status, 200);

    const previewModule = await fetch(`${url}/evidence-preview.js`);
    assert.equal(previewModule.status, 200);
    assert.match(previewModule.headers.get("content-type"), /^text\/javascript/);
    assert.match(await previewModule.text(), /selectSummaryCards/);

    const statusModule = await fetch(`${url}/status.js`);
    assert.equal(statusModule.status, 200);
    assert.match(statusModule.headers.get("content-type"), /^text\/javascript/);
    assert.match(await statusModule.text(), /deriveStatusView/);

    const reportStreamModule = await fetch(`${url}/report-stream.js`);
    assert.equal(reportStreamModule.status, 200);
    assert.match(reportStreamModule.headers.get("content-type"), /^text\/javascript/);
    assert.match(await reportStreamModule.text(), /mergeReportEvent/);

    const wrongOrigin = await fetch(`${url}/api/onboard`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://127.0.0.1:9",
      },
      body: "{}",
    });
    assert.equal(wrongOrigin.status, 403);

    const wrongType = await fetch(`${url}/api/onboard`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", Origin: url },
      body: "{}",
    });
    assert.equal(wrongType.status, 415);

    const coercedInstall = await fetch(`${url}/api/onboard`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: url },
      body: JSON.stringify({ installCli: "false" }),
    });
    assert.equal(coercedInstall.status, 400);
    const payload = await coercedInstall.json();
    assert.equal(payload.error.code, "INVALID_BODY");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("saved socai media is exposed through an opaque range-capable local URL", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jev-social-media-"));
  const socaiHome = path.join(directory, "socai");
  const jevHome = path.join(directory, "jev");
  const mediaPath = path.join(socaiHome, "runs", "capture", "site_media", "video.mp4");
  await mkdir(path.dirname(mediaPath), { recursive: true });
  await writeFile(mediaPath, "0123456789");
  const env = { ...process.env, SOCAI_HOME: socaiHome, JEV_SOCIAL_HOME: jevHome };
  await saveRun({ id: "media-test", result: { items: [{ video: { local_path: mediaPath } }] } }, env);
  const { server, url } = await startServer({ port: 0, open: false, env });
  try {
    const runResponse = await fetch(`${url}/api/runs/media-test`);
    assert.equal(runResponse.status, 200);
    const run = await runResponse.json();
    assert.match(run.result.items[0].video.browser_url, /^\/media\/[A-Za-z0-9_-]+$/);
    assert.equal(run.result.items[0].video.local_path, undefined);
    assert.doesNotMatch(JSON.stringify(run), new RegExp(mediaPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const mediaResponse = await fetch(`${url}${run.result.items[0].video.browser_url}`, {
      headers: { Range: "bytes=2-5" },
    });
    assert.equal(mediaResponse.status, 206);
    assert.equal(mediaResponse.headers.get("content-range"), "bytes 2-5/10");
    assert.equal(await mediaResponse.text(), "2345");

    await rename(mediaPath, `${mediaPath}.original`);
    await writeFile(mediaPath, "abcdefghij");
    const swappedResponse = await fetch(`${url}${run.result.items[0].video.browser_url}`);
    assert.equal(swappedResponse.status, 410);
    assert.equal((await swappedResponse.json()).error.code, "MEDIA_CHANGED");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(directory, { recursive: true, force: true });
  }
});

test("/api/status returns exact sanitized shape and no leaked paths or env variables", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jev-social-status-"));
  const mock = path.join(directory, "socai-mock.mjs");
  await writeFile(
    mock,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") console.log("socai 0.5.6");
else if (args[0] === "--help") console.log("socai root");
else if (args[0] === "status" && args[1] === "--json") console.log(JSON.stringify({
  schema_version: 1,
  cli_available: true,
  cli_version: "2",
  daemon_running: true,
  daemon_compatible: true,
  browser_connected: false,
  browser_state: "disconnected",
  profile_mode: "existing",
  active_profile_mode: null,
  error_code: "BROWSER_ENDPOINT_UNREACHABLE",
  next_step: "connect ws://127.0.0.1:9222/devtools/browser/private-token",
  profile_path: "/Users/private/Chrome/Profile 1",
  platforms: [
    { id: "instagram", available: true, login_state: "unknown", operations: ["search", "get-posts", "/Users/private/leak"] },
    { id: "tiktok", available: true, login_state: "unknown", operations: ["search", "get-videos"] },
  ],
}));
else if (args[0] === "instagram" && args[1] === "--help") console.log("Commands: search");
else if (args[0] === "tiktok" && args[1] === "--help") console.log("Commands: search");
else if (args[0] === "linkedin" && args[1] === "--help") process.exitCode = 1;
else process.exitCode = 2;
`,
    { mode: 0o755 },
  );

  const env = {
    ...process.env,
    SOCAI_BIN: mock,
    OPENROUTER_API_KEY: "secret-key-123",
    OPENROUTER_JEV_MODEL: "~typesafe/jev-latest",
    JEV_SOCIAL_SYSTEM_ONE_URL: "",
    JEV_SOCIAL_SYSTEM_ONE_TIMEOUT_MS: "",
  };
  const { server, url } = await startServer({ port: 0, open: false, env });
  try {
    const response = await fetch(`${url}/api/status`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, {
      jevConfigured: true,
      jevModel: "~typesafe/jev-latest",
      decisionProvider: "openrouter",
      socai: {
        installed: true,
        version: "0.5.6",
        capabilities: {
          instagram: true,
          tiktok: true,
          linkedin: false,
        },
        readiness: {
          schemaVersion: 1,
          cliAvailable: true,
          daemonRunning: true,
          daemonCompatible: true,
          browserConnected: false,
          browserState: "disconnected",
          profileMode: "existing",
          activeProfileMode: null,
          errorCode: "BROWSER_ENDPOINT_UNREACHABLE",
          platforms: {
            instagram: { available: true, loginState: "unknown", operations: ["search", "get-posts"] },
            tiktok: { available: true, loginState: "unknown", operations: ["search", "get-videos"] },
            linkedin: { available: false, loginState: "unknown", operations: [] },
          },
        },
      },
    });
    const text = JSON.stringify(body);
    assert.ok(!text.includes("secret-key-123"), "API key must not leak");
    assert.ok(!text.includes(directory), "Filesystem path must not leak");
    assert.ok(!text.includes("socai-mock.mjs"), "Binary filename must not leak");
    assert.ok(!text.includes("9222"), "Browser ports must not leak");
    assert.ok(!text.includes("private-token"), "Browser session tokens must not leak");
    assert.ok(!text.includes("Profile 1"), "Browser profile paths must not leak");
    assert.equal(body.configPath, undefined);
    assert.equal(body.socai.bin, undefined, "/api/status must omit bin property");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(directory, { recursive: true, force: true });
  }
});

test("/api/status reports a local decision provider without exposing its endpoint", async () => {
  const env = {
    ...process.env,
    JEV_SOCIAL_SYSTEM_ONE_URL: "http://127.0.0.1:8009/v1/systemone",
    JEV_SOCIAL_SYSTEM_ONE_MODEL: "kev-latest",
  };
  delete env.OPENROUTER_API_KEY;
  delete env.openrouter;
  const { server, url } = await startServer({ port: 0, open: false, env });
  try {
    const response = await fetch(`${url}/api/status`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.jevConfigured, true);
    assert.equal(body.jevModel, "kev-latest");
    assert.equal(body.decisionProvider, "local");
    assert.doesNotMatch(JSON.stringify(body), /127\.0\.0\.1|8009|systemone/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("/api/status rejects an unsafe local decision endpoint without echoing it", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jev-social-invalid-provider-"));
  const mock = path.join(directory, "socai-mock.mjs");
  await writeFile(
    mock,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") console.log("socai 0.5.6");
else if (args[0] === "--help") console.log("socai root");
else if (["instagram", "tiktok", "linkedin"].includes(args[0]) && args[1] === "--help") console.log("Commands: search");
else process.exitCode = 2;
`,
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    SOCAI_BIN: mock,
    JEV_SOCIAL_SYSTEM_ONE_URL: "http://example.com/v1/systemone?token=secret",
  };
  const { server, url } = await startServer({ port: 0, open: false, env });
  try {
    const response = await fetch(`${url}/api/status`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.jevConfigured, false);
    assert.equal(body.decisionProviderError, "Decision provider configuration is invalid.");
    assert.equal(body.configError, undefined);
    assert.equal(body.socai.installed, true);
    assert.deepEqual(body.socai.capabilities, { instagram: true, tiktok: true, linkedin: true });
    assert.doesNotMatch(JSON.stringify(body), /example\.com|token|secret/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(directory, { recursive: true, force: true });
  }
});

test("/api/status never leaks config path when readConfig fails", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jev-social-err-status-"));
  await writeFile(path.join(directory, "config.json"), "{ invalid JSON syntax !!!");
  const badEnv = {
    ...process.env,
    JEV_SOCIAL_HOME: directory,
  };
  const { server, url } = await startServer({ port: 0, open: false, env: badEnv });
  try {
    const response = await fetch(`${url}/api/status`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.jevConfigured, false);
    assert.equal(body.configError, "Configuration could not be read.");
    const text = JSON.stringify(body);
    assert.ok(!text.includes(directory), "Filesystem path must not leak when readConfig fails");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(directory, { recursive: true, force: true });
  }
});
