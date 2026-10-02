import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MAX_REELS_BYTES } from "../src/reels-contract.js";
import { startServer } from "../src/server.js";

const fixture = JSON.parse(await readFile(new URL("fixtures/reels-import-v1.json", import.meta.url), "utf8"));
const close = (server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
const post = (url, body, headers = {}) => fetch(`${url}/api/reels`, {
  method: "POST", headers: { Origin: url, "Content-Type": "application/json", ...headers }, body,
});

test("Reel API imports without credentials and reopens the same collection after server restart", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jev-reels-server-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { JEV_SOCIAL_HOME: path.join(root, "state"), PATH: "", SOCAI_BIN: path.join(root, "no-socai-installed") };
  let running = await startServer({ port: 0, open: false, env });
  t.after(() => close(running.server));
  assert.deepEqual(await (await fetch(`${running.url}/api/reels`)).json(), { collections: [] });
  const response = await post(running.url, JSON.stringify(fixture));
  assert.equal(response.status, 201);
  const saved = await response.json();
  assert.equal(saved.posts.length, 5);
  assert.doesNotMatch(JSON.stringify(saved), new RegExp(root));
  await close(running.server);
  running = await startServer({ port: 0, open: false, env });
  const reopened = await fetch(`${running.url}/api/reels/${saved.id}`);
  assert.equal(reopened.status, 200);
  assert.deepEqual(await reopened.json(), saved);
  const list = await (await fetch(`${running.url}/api/reels`)).json();
  assert.deepEqual(list.collections, [{ id: saved.id, sourceId: saved.sourceId, schemaVersion: 1, creator: "example", sourceStatus: "partial", itemCount: 5 }]);
  const repeat = await post(running.url, JSON.stringify({ ...fixture, filename: "renamed.json" }));
  assert.equal(repeat.status, 201);
  assert.deepEqual(await repeat.json(), saved);
  const invalid = await post(running.url, JSON.stringify({ ...fixture, schemaVersion: 2 }));
  assert.equal(invalid.status, 400);
  assert.deepEqual(await (await fetch(`${running.url}/api/reels/${saved.id}`)).json(), saved);
  const missing = await fetch(`${running.url}/api/reels/reels-${"0".repeat(24)}`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "REELS_NOT_FOUND");
  assert.equal((await fetch(`${running.url}/`)).status, 200);
});

test("Reel API rejects cross-origin, malformed, unsafe and oversized imports without writing data", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jev-reels-http-"));
  const env = { JEV_SOCIAL_HOME: root, PATH: "", SOCAI_BIN: path.join(root, "no-socai-installed") };
  const { server, url } = await startServer({ port: 0, open: false, env });
  t.after(async () => { await close(server); await rm(root, { recursive: true, force: true }); });
  for (const headers of [{ Origin: "" }, { Origin: "https://example.test" }, { Origin: "http://127.0.0.1:9" }]) {
    assert.equal((await post(url, JSON.stringify(fixture), headers)).status, 403);
  }
  assert.equal((await post(url, "{}", { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await post(url, "{")).status, 400);
  assert.equal((await post(url, "null")).status, 400);
  const unsafe = structuredClone(fixture); unsafe.posts[0].url = "https://evil.test/private";
  const invalid = await post(url, JSON.stringify(unsafe));
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, "INVALID_REELS_IMPORT");
  const oversized = await post(url, JSON.stringify({ ignored: "x".repeat(MAX_REELS_BYTES) }));
  assert.equal(oversized.status, 413);
  assert.deepEqual(await (await fetch(`${url}/api/reels`)).json(), { collections: [] });
});
