import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { filterReels, LABEL_VALUES, MAX_REELS_BYTES, SCRIPT_ROLES, SOURCE_STATES } from "../src/reels-contract.js";
import { importReels, listReels, normalizeReels, readReels } from "../src/reels.js";

const sample = JSON.parse(await readFile(new URL("fixtures/reels-import-v1.json", import.meta.url), "utf8"));
const fixture = () => structuredClone(sample);
const ids = (posts) => posts.map((post) => post.id);
async function storage(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "jev-reels-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { JEV_SOCIAL_HOME: path.join(root, "state") };
  return { root, env, directory: path.join(env.JEV_SOCIAL_HOME, "reels", "v1") };
}

test("v1 fixture preserves transcripts, independent nullable metrics and explicit states", () => {
  const result = normalizeReels(fixture());
  assert.match(result.id, /^reels-[a-f0-9]{24}$/);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.sourceId, "fixture-collection-1");
  assert.equal(result.creator, "example");
  assert.equal(result.sourceStatus, "partial");
  assert.equal(result.createdAt, "2026-09-03T12:00:00.000Z");
  assert.equal(result.duplicateCount, 0);
  const [a, b, c, d, e] = result.posts;
  assert.equal(a.url, "https://www.instagram.com/p/FixtureA/");
  assert.deepEqual(a.transcript, sample.posts[0].transcript);
  assert.deepEqual(a.analysis, sample.posts[0].analysis);
  assert.equal(a.plays, 1000);
  assert.equal(a.views, null);
  assert.equal(a.comments, 0);
  assert.equal(b.plays, null);
  assert.equal(b.views, 500);
  assert.deepEqual(result.posts.map((post) => post.status), ["classified", "excluded", "error", "unclassified", "classified"]);
  assert.equal(b.statusNote, "No audio track");
  assert.equal(c.statusNote, "Source processing failed");
  assert.equal(d.transcript.segments[0].start, null);
  assert.equal(d.likes, 0);
  assert.deepEqual(result.posts.map((post) => post.needsReview), [false, false, false, false, true]);
  assert.equal(e.analysis.labels.mechanism.confidence, 0.3);
});

test("IDs are independent of filenames, input order, creator case and source URL aliases", () => {
  const raw = fixture(), original = normalizeReels(raw);
  raw.filename = "renamed-export.json";
  raw.creator = "EXAMPLE";
  raw.posts.reverse();
  raw.posts.find((post) => post.id === "item-a").url = "https://www.instagram.com/p/FixtureA/#ignored";
  assert.deepEqual(normalizeReels(raw), original);
  raw.posts.push(structuredClone(raw.posts[0]));
  assert.deepEqual(normalizeReels(raw).posts, original.posts);
  assert.equal(normalizeReels(raw).duplicateCount, 1);
  raw.posts.at(-1).caption = "A conflicting snapshot.";
  assert.throws(() => normalizeReels(raw), /Conflicting duplicate/);
  assert.notEqual(normalizeReels({ ...fixture(), id: "other" }).id, original.id);
  assert.notEqual(normalizeReels({ ...fixture(), creator: "another" }).id, original.id);
});

test("malformed envelopes, classifications and timestamps fail closed", () => {
  const changes = [
    (raw) => delete raw.schemaVersion,
    (raw) => raw.schemaVersion = 2,
    (raw) => raw.id = "../escape",
    (raw) => raw.creator = "@invalid",
    (raw) => raw.status = "invented",
    (raw) => raw.posts = [],
    (raw) => raw.posts = Array(1001).fill(raw.posts[0]),
    (raw) => raw.posts[0].id = "../../escape",
    (raw) => raw.posts[0].creator = "/Users/private",
    (raw) => raw.posts[0].status = "invented",
    (raw) => raw.posts[0].status = "failed",
    (raw) => raw.posts[1].status = "classified",
    (raw) => raw.posts[1].excludedReason = {},
    (raw) => raw.posts[2].excludedReason = "also excluded",
    (raw) => raw.posts[0].transcript = "raw text",
    (raw) => raw.posts[0].transcript.text = "",
    (raw) => raw.posts[0].caption = {},
    (raw) => raw.posts[0].caption = "x".repeat(12001),
    (raw) => raw.posts[0].transcript.text = "x".repeat(48001),
    (raw) => raw.posts[0].transcript.segments = Array(201).fill({}),
    (raw) => raw.posts[0].transcript.segments = [null],
    (raw) => raw.posts[0].transcript.segments[0].start = -1,
    (raw) => raw.posts[0].transcript.segments[0].start = "0",
    (raw) => raw.posts[0].transcript.segments[0].end = Infinity,
    (raw) => raw.posts[0].transcript.segments[0].end = -1,
    (raw) => raw.posts[0].transcript.segments[1].end = 1,
    (raw) => delete raw.posts[0].analysis.labels.topic,
    (raw) => raw.posts[0].analysis.labels.topic.value = "invented",
    (raw) => raw.posts[0].analysis.labels.topic.confidence = "0.9",
    (raw) => raw.posts[0].analysis.labels.topic.confidence = 1.01,
    (raw) => raw.posts[0].analysis.labels.topic.confidence = NaN,
    (raw) => raw.posts[0].analysis.anatomy[0].value = "invented",
    (raw) => raw.posts[0].analysis.anatomy[0].confidence = -0.1,
  ];
  for (const change of changes) {
    const raw = fixture(); change(raw);
    assert.throws(() => normalizeReels(raw), { code: "INVALID_REELS_IMPORT" }, change.toString());
  }
  for (const raw of [null, [], "text", 1]) assert.throws(() => normalizeReels(raw), { code: "INVALID_REELS_IMPORT" });
});

test("only HTTPS Instagram posts are accepted, without credentials or lookalike hosts", () => {
  for (const url of [
    "http://instagram.com/p/a/", "https://instagram.com.evil.test/p/a/",
    "https://evil.test/instagram.com/p/a/", "https://instagram.com@evil.test/p/a/",
    "https://user:pass@instagram.com/p/a/", "https://instagram.com:8443/p/a/",
    "https://instagram.com/profile/", "https://instagram.com/p/a/extra",
    "https://instagram.com/p/%2Fetc%2Fpasswd/", "javascript:alert(1)",
    "file:///tmp/post", "//instagram.com/p/a/", null,
  ]) {
    const raw = fixture(); raw.posts[0].url = url;
    assert.throws(() => normalizeReels(raw), { code: "INVALID_REELS_IMPORT" });
  }
});

test("unknown fields and known credential/path patterns never enter stored content", () => {
  const raw = fixture();
  raw.api_key = "private-root-payload";
  raw.posts[0].providerResponse = { cookies: "private-provider-payload" };
  raw.posts[0].video = { local_path: "/Users/private/movie.mp4" };
  raw.posts[0].thumbnail = "https://cdn.example.test/private-poster";
  raw.posts[0].caption = "Public caption.\nAuthorization: Bearer private-token\n/Users/private/capture.json\n";
  raw.posts[0].transcript.segments[0].text = "api_key=private-segment-payload";
  raw.posts[0].analysis.anatomy[0].text = "data:video/mp4;base64,private-media-payload";
  const serialized = JSON.stringify(normalizeReels(raw));
  assert.match(serialized, /Public caption/);
  assert.match(serialized, /redacted credential/);
  assert.doesNotMatch(serialized, /private-|\/Users\/private|providerResponse|thumbnail|local_path/);
});

test("unknown counts stay null and review state is derived rather than trusted", () => {
  const raw = fixture(), a = raw.posts[0];
  a.plays = "1000"; a.views = -1; a.likes = NaN; a.comments = Infinity;
  a.publishedAt = "invalid";
  a.needsReview = false;
  a.analysis.anatomy[0].confidence = null;
  let post = normalizeReels(raw).posts[0];
  for (const key of ["plays", "views", "likes", "comments", "publishedAt"]) assert.equal(post[key], null);
  assert.equal(post.needsReview, true);
  a.analysis.anatomy[0].confidence = 0.65;
  a.analysis.labels.topic.confidence = 0.65;
  assert.equal(normalizeReels(raw).posts[0].needsReview, false);
  a.analysis.labels.topic.value = "unclear";
  assert.equal(normalizeReels(raw).posts[0].needsReview, true);
});

test("path sanitization handles dense paths and spaces without scanning across lines", () => {
  const raw = fixture();
  raw.posts[0].transcript.text = "/x ".repeat(8000);
  raw.posts[0].caption = "Public text.\n/Users/private/My Capture.json\nC:\\Users\\private\\My Capture.json\nrelative/capture.json\nhttps://www.instagram.com/p/FixtureA/";
  const post = normalizeReels(raw).posts[0];
  assert.equal(post.transcript.text, "[redacted path]");
  assert.equal(post.caption, "Public text.\n[redacted path]\n[redacted path]\n[redacted path]\nhttps://www.instagram.com/p/FixtureA/");
});

test("filters combine labels, confidence and review state without changing evidence", () => {
  const posts = normalizeReels(fixture()).posts, before = structuredClone(posts);
  assert.deepEqual(ids(filterReels(posts)), ["item-a", "item-b", "item-c", "item-d", "item-e"]);
  assert.deepEqual(ids(filterReels(posts, { topic: "marketing", structure: "steps" })), ["item-a", "item-e"]);
  assert.deepEqual(ids(filterReels(posts, { mechanism: "curiosity" })), ["item-a"]);
  assert.deepEqual(ids(filterReels(posts, { minConfidence: 0.65 })), ["item-a"]);
  assert.deepEqual(ids(filterReels(posts, { dimension: "topic", minConfidence: 0.65 })), ["item-a", "item-e"]);
  assert.deepEqual(ids(filterReels(posts, { dimension: "topic", mechanism: "unclear", minConfidence: 0.65 })), []);
  for (const [review, expected] of Object.entries({ review: ["item-e"], classified: ["item-a", "item-e"], excluded: ["item-b"], error: ["item-c"], unclassified: ["item-d"] })) {
    assert.deepEqual(ids(filterReels(posts, { review })), expected);
  }
  for (const options of [{ topic: "invented" }, { review: "invented" }, { minConfidence: "0" }, { minConfidence: 1.1 }, { dimension: "__proto__" }]) assert.throws(() => filterReels(posts, options));
  assert.deepEqual(posts, before);
});

test("schema vocabulary and closed field sets match the normalized fixture", async () => {
  const schema = JSON.parse(await readFile(new URL("../schemas/reels-v1.schema.json", import.meta.url), "utf8"));
  const collection = normalizeReels(fixture());
  function fields(value, definition) {
    assert.equal(definition.additionalProperties, false);
    assert.deepEqual(Object.keys(value).sort(), definition.required.toSorted());
    assert.deepEqual(Object.keys(value).sort(), Object.keys(definition.properties).sort());
  }
  fields(collection, schema);
  assert.deepEqual(schema.properties.sourceStatus.enum, SOURCE_STATES);
  for (const post of collection.posts) {
    fields(post, schema.$defs.post);
    fields(post.transcript, schema.$defs.post.properties.transcript);
    for (const segment of post.transcript.segments) fields(segment, schema.$defs.segment);
    if (post.analysis) {
      fields(post.analysis, schema.$defs.analysis);
      fields(post.analysis.labels, schema.$defs.analysis.properties.labels);
      for (const [key, values] of Object.entries(LABEL_VALUES)) {
        const label = schema.$defs.analysis.properties.labels.properties[key];
        fields(post.analysis.labels[key], label);
        assert.deepEqual(label.properties.value.enum, values);
      }
    }
  }
  assert.deepEqual(schema.$defs.analysis.properties.anatomy.items.properties.value.enum, SCRIPT_ROLES);
});

test("private atomic storage reopens exact data and replaces snapshots by stable identity", async (t) => {
  const { env, directory } = await storage(t);
  assert.deepEqual(await listReels(env), []);
  const raw = fixture(); raw.posts.push(structuredClone(raw.posts[0]));
  const saved = await importReels(raw, env), filename = path.join(directory, `${saved.id}.json`);
  assert.deepEqual(await readReels(saved.id, env), saved);
  const bytes = await readFile(filename, "utf8");
  await importReels({ ...raw, filename: "renamed.json" }, env);
  assert.equal(await readFile(filename, "utf8"), bytes);
  assert.deepEqual(await readdir(directory), [`${saved.id}.json`]);
  if (process.platform !== "win32") {
    assert.equal((await lstat(filename)).mode & 0o777, 0o600);
    for (const dir of [env.JEV_SOCIAL_HOME, path.dirname(directory), directory]) assert.equal((await lstat(dir)).mode & 0o777, 0o700);
  }
  const broken = fixture(); broken.posts[0].url = "file:///tmp/private";
  await assert.rejects(importReels(broken, env), { code: "INVALID_REELS_IMPORT" });
  assert.equal(await readFile(filename, "utf8"), bytes);
  const replacement = fixture(); replacement.posts = [replacement.posts[0]]; replacement.posts[0].plays = 2000;
  const updated = await importReels(replacement, env);
  assert.equal(updated.id, saved.id);
  assert.equal((await readReels(saved.id, env)).posts[0].plays, 2000);
  assert.equal((await listReels(env))[0].itemCount, 1);
});

test("bounded input and invalid storage fail without leaking local paths", async (t) => {
  const { root, env } = await storage(t);
  await assert.rejects(importReels({ ...fixture(), ignored: "x".repeat(MAX_REELS_BYTES) }, env), { code: "INVALID_REELS_IMPORT" });
  const expanding = { ...fixture(), posts: Array.from({ length: 220 }, (_, index) => ({
    id: `item-${index}`, url: `https://instagram.com/p/Fixture${index}/`, transcript: { text: "Bearer x ".repeat(4000) },
  })) };
  assert.ok(Buffer.byteLength(JSON.stringify(expanding)) < MAX_REELS_BYTES);
  await assert.rejects(importReels(expanding, env), /Normalized Reel imports must not exceed/);
  const cyclic = fixture(); cyclic.self = cyclic;
  await assert.rejects(importReels(cyclic, env), { code: "INVALID_REELS_IMPORT" });
  await assert.rejects(lstat(env.JEV_SOCIAL_HOME), { code: "ENOENT" });
  await writeFile(env.JEV_SOCIAL_HOME, "not a directory");
  await assert.rejects(importReels(fixture(), env), (error) => error.code === "REELS_SAVE_FAILED" && !error.message.includes(root));
  const project = fileURLToPath(new URL("../", import.meta.url));
  await assert.rejects(importReels(fixture(), { JEV_SOCIAL_HOME: path.join(project, "public", "forbidden-reels-state") }), { code: "REELS_SAVE_FAILED" });
  await assert.rejects(lstat(path.join(project, "public", "forbidden-reels-state")), { code: "ENOENT" });
});

test("corrupt, oversized, unsafe or mismatched persisted collections are not reopened", async (t) => {
  const { env, directory } = await storage(t);
  const saved = await importReels(fixture(), env), filename = path.join(directory, `${saved.id}.json`);
  const unsafe = structuredClone(saved); unsafe.posts[0].url = "https://evil.test/post";
  for (const content of ["{", "x".repeat(MAX_REELS_BYTES + 1), JSON.stringify({ ...saved, schemaVersion: 2 }), JSON.stringify({ ...saved, sourceId: "other" }), JSON.stringify({ ...saved, duplicateCount: -1 }), JSON.stringify(unsafe)]) {
    await writeFile(filename, content);
    assert.equal(await readReels(saved.id, env), null);
    assert.deepEqual(await listReels(env), []);
  }
  assert.equal(await readReels("../../outside", env), null);
  await rm(filename); await mkdir(filename);
  assert.equal(await readReels(saved.id, env), null);
});

test("symlinked state directories and saved files cannot expose outside content", { skip: process.platform === "win32" }, async (t) => {
  const { root, env, directory } = await storage(t);
  const outside = path.join(root, "outside"); await mkdir(outside);
  await symlink(outside, env.JEV_SOCIAL_HOME);
  await assert.rejects(importReels(fixture(), env), { code: "REELS_SAVE_FAILED" });
  await rm(env.JEV_SOCIAL_HOME); await mkdir(env.JEV_SOCIAL_HOME);
  await symlink(outside, path.join(env.JEV_SOCIAL_HOME, "reels"));
  await assert.rejects(importReels(fixture(), env), { code: "REELS_SAVE_FAILED" });
  await rm(path.join(env.JEV_SOCIAL_HOME, "reels"));
  await mkdir(path.join(env.JEV_SOCIAL_HOME, "reels"));
  await symlink(outside, directory);
  await assert.rejects(importReels(fixture(), env), { code: "REELS_SAVE_FAILED" });
  await rm(directory);
  const saved = await importReels(fixture(), env), filename = path.join(directory, `${saved.id}.json`);
  const target = path.join(outside, "outside.json"); await writeFile(target, JSON.stringify(saved));
  await rm(filename); await symlink(target, filename);
  assert.equal(await readReels(saved.id, env), null);
  assert.deepEqual(await listReels(env), []);
  await importReels(fixture(), env);
  assert.equal((await lstat(filename)).isSymbolicLink(), false);
  assert.equal(await readFile(target, "utf8"), JSON.stringify(saved));
});
