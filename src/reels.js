import crypto from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getHomeDir } from "./config.js";
import { AppError } from "./errors.js";
import { LABEL_VALUES, MAX_REELS_BYTES, REELS_SCHEMA_VERSION, REVIEW_THRESHOLD, SCRIPT_ROLES, SOURCE_STATES, knownMetric } from "./reels-contract.js";

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const stableId = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const libraryId = (value) => typeof value === "string" && /^reels-[a-f0-9]{24}$/.test(value);
const invalid = (message) => new AppError(message, { code: "INVALID_REELS_IMPORT" });
const metric = (value) => knownMetric(value) ? value : null;
const date = (value) => typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const creatorName = (value) => typeof value === "string" && /^[a-zA-Z0-9_.]{1,30}$/.test(value);

function redactPaths(value) {
  // Drop the whole line when a local path is detected, including paths with
  // spaces. Scan bounded lines/tokens without nested, overlapping quantifiers.
  return value.split(/\r?\n/).map((line) => {
    const absolute = /(^|[\s("'`=:])(?:file:\/\/\/|[A-Za-z]:[\\/]|\\\\|~[\\/]|\.{1,2}[\\/]|\/(?!\/))\S/.test(line);
    const named = /\b(?:run_dir|local_path|output_dir|artifact_path|report_path)\s*[:=]/i.test(line);
    const relative = line.split(/\s+/).some((token) => token.includes("/") && !token.includes("://") && /\.[A-Za-z0-9]{1,10}[),;:!?\]}"']*$/.test(token));
    return absolute || named || relative ? "[redacted path]" : line;
  }).join("\n");
}

function text(value, max = 12000) {
  if (value == null) return "";
  if (typeof value !== "string" || value.length > max) throw invalid("Invalid or oversized Reel text field.");
  return redactPaths(value)
    .replace(/\b(?:authorization|cookie|set-cookie|(?:access[_ -]?|refresh[_ -]?|session[_ -]?)?token|api[_ -]?key|password|secret)\s*[:=]\s*[^\r\n]*/gi, "[redacted credential]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "[redacted credential]")
    .replace(/\b(?:sk-|gsk_|apify_api_|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{8,}\b/g, "[redacted credential]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted credential]")
    .replace(/data:[^\s]+/gi, "[media omitted]").slice(0, max);
}

function source(raw) {
  if (typeof raw !== "string" || raw.length > 5000) throw invalid("Every Reel needs a valid Instagram post URL.");
  let url;
  try { url = new URL(raw); } catch { throw invalid("Every Reel needs a valid Instagram post URL."); }
  const code = url.pathname.match(/^\/(?:p|reel)\/([A-Za-z0-9_-]+)\/?$/)?.[1];
  if (!code || url.protocol !== "https:" || url.username || url.password || url.port
    || !["instagram.com", "www.instagram.com"].includes(url.hostname)) throw invalid("Every Reel needs a valid Instagram post URL.");
  return `https://www.instagram.com/p/${code}/`;
}

function segments(raw = [], labeled = false) {
  if (!Array.isArray(raw) || raw.length > 200) throw invalid("Invalid Reel transcript segments.");
  return raw.map((segment) => {
    if (!object(segment)) throw invalid("Invalid Reel transcript segment.");
    const start = segment.start ?? null, end = segment.end ?? null;
    if ((start !== null && !knownMetric(start)) || (end !== null && !knownMetric(end))
      || (start !== null && end !== null && end < start)) throw invalid("Invalid Reel segment timestamps.");
    const result = { text: text(segment.text, 48000), start, end };
    if (labeled) {
      if (!SCRIPT_ROLES.includes(segment.value)) throw invalid("Invalid Reel script role.");
      if (segment.confidence != null && (!knownMetric(segment.confidence) || segment.confidence > 1)) throw invalid("Invalid Reel segment confidence.");
      result.value = segment.value; result.confidence = segment.confidence ?? null;
    }
    return result;
  });
}

function classification(raw, transcript) {
  if (raw == null) return null;
  if (!object(raw) || !object(raw.labels) || !transcript) throw invalid("Classification requires labels and a transcript.");
  const labels = {};
  for (const [key, values] of Object.entries(LABEL_VALUES)) {
    const label = raw.labels[key];
    if (!object(label) || !values.includes(label.value) || !knownMetric(label.confidence) || label.confidence > 1) throw invalid("Invalid Reel classification or confidence.");
    labels[key] = { value: label.value, confidence: label.confidence };
  }
  return { labels, anatomy: segments(raw.anatomy, true) };
}

export function normalizeReels(raw) {
  if (!object(raw) || raw.schemaVersion !== REELS_SCHEMA_VERSION) throw invalid("Expected Reel import schemaVersion 1.");
  if (!stableId(raw.id) || !creatorName(raw.creator)) throw invalid("Invalid Reel collection ID or creator.");
  if (!Array.isArray(raw.posts) || !raw.posts.length || raw.posts.length > 1000) throw invalid("Import 1 to 1,000 Reel items.");
  if (raw.status != null && !SOURCE_STATES.includes(raw.status)) throw invalid("Invalid Reel collection status.");
  const creator = raw.creator.toLowerCase(), seen = new Map(), posts = [];
  for (const item of raw.posts) {
    if (!object(item) || !stableId(item.id)) throw invalid("Every Reel needs a stable item ID.");
    if (item.creator != null && !creatorName(item.creator)) throw invalid("Invalid Reel creator.");
    if (item.status != null && !["classified", "unclassified", "pending", "ready", "no_audio", "no_speech", "excluded", "failed", "error"].includes(item.status)) throw invalid("Invalid Reel item status.");
    if (item.transcript != null && !object(item.transcript)) throw invalid("Invalid Reel transcript.");
    const transcript = { text: text(item.transcript?.text, 48000), segments: segments(item.transcript?.segments) };
    const analysis = classification(item.analysis, transcript.text);
    if (item.excludedReason != null && typeof item.excludedReason !== "string") throw invalid("Invalid Reel exclusion reason.");
    const excluded = Boolean(item.excludedReason) || ["no_audio", "no_speech", "excluded"].includes(item.status);
    const failed = ["failed", "error"].includes(item.status);
    if (excluded && failed) throw invalid("A Reel cannot be both excluded and failed.");
    if ((excluded || failed) && analysis) throw invalid("Excluded or error rows cannot contain a classification.");
    if (item.status === "classified" && !analysis) throw invalid("Classified rows require a classification.");
    const status = excluded ? "excluded" : failed ? "error" : analysis ? "classified" : "unclassified";
    const post = {
      id: item.id, url: source(item.url), creator: (item.creator || creator).toLowerCase(),
      publishedAt: date(item.publishedAt), capturedAt: date(item.capturedAt || item.scrapedAt),
      caption: text(item.caption), transcript, duration: metric(item.duration),
      plays: metric(item.plays), views: metric(item.views), likes: metric(item.likes), comments: metric(item.comments),
      status, statusNote: excluded ? (item.status === "no_audio" || item.statusNote === "No audio track" ? "No audio track" : "Excluded by source") : failed ? "Source processing failed" : "",
      analysis, needsReview: Boolean(analysis) && (Object.values(analysis.labels).some((label) => label.confidence < REVIEW_THRESHOLD || label.value === "unclear")
        || analysis.anatomy.some((segment) => segment.confidence === null || segment.confidence < REVIEW_THRESHOLD || segment.value === "unclear")),
    };
    const duplicate = seen.get(post.id);
    if (duplicate && JSON.stringify(duplicate) !== JSON.stringify(post)) throw invalid("Conflicting duplicate Reel item IDs.");
    if (!duplicate) { seen.set(post.id, post); posts.push(post); }
  }
  posts.sort((a, b) => a.id.localeCompare(b.id, "en"));
  return {
    schemaVersion: REELS_SCHEMA_VERSION,
    id: `reels-${crypto.createHash("sha256").update(`${creator}\0${raw.id}`).digest("hex").slice(0, 24)}`,
    sourceId: raw.id, creator, createdAt: date(raw.createdAt), sourceStatus: raw.status || "unknown",
    duplicateCount: raw.posts.length - posts.length, posts,
  };
}

async function directory(env, create = false) {
  const root = getHomeDir(env);
  const project = await realpath(fileURLToPath(new URL("..", import.meta.url)));
  const insideProject = (candidate) => {
    const relative = path.relative(project, candidate);
    return !relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  if (insideProject(root)) throw new Error("Reel storage must be outside the project.");
  if (create) await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await lstat(root)).isSymbolicLink()) throw new Error("State directory must not be a symlink.");
  if (insideProject(await realpath(root))) throw new Error("Reel storage must be outside the project.");
  let result = root;
  for (const name of ["reels", "v1"]) {
    result = path.join(result, name);
    if (create) await mkdir(result, { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
    const info = await lstat(result);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Invalid Reel storage directory.");
  }
  return result;
}

export async function importReels(raw, env = process.env) {
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(raw)); } catch { throw invalid("Invalid Reel JSON input."); }
  if (bytes > MAX_REELS_BYTES) throw invalid("Reel imports must not exceed 10 MB.");
  const collection = normalizeReels(raw), serialized = JSON.stringify(collection);
  if (Buffer.byteLength(serialized) > MAX_REELS_BYTES) throw invalid("Normalized Reel imports must not exceed 10 MB.");
  let temporary;
  try {
    const root = await directory(env, true);
    temporary = path.join(root, `${collection.id}.${crypto.randomUUID()}.tmp`);
    await writeFile(temporary, serialized, { flag: "wx", mode: 0o600 });
    await rename(temporary, path.join(root, `${collection.id}.json`));
  } catch { throw new AppError("The local library could not save this collection.", { code: "REELS_SAVE_FAILED", status: 500 }); }
  finally { if (temporary) await unlink(temporary).catch(() => {}); }
  return collection;
}

export async function readReels(id, env = process.env) {
  if (!libraryId(id)) return null;
  let file;
  try {
    file = await open(path.join(await directory(env), `${id}.json`), constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_REELS_BYTES) return null;
    const chunks = []; let bytes = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      bytes += chunk.length; if (bytes > MAX_REELS_BYTES) return null;
      chunks.push(chunk);
    }
    const saved = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const clean = normalizeReels({ ...saved, id: saved.sourceId, status: saved.sourceStatus });
    if (clean.id !== id || saved.id !== id) return null;
    if (!Number.isInteger(saved.duplicateCount) || saved.duplicateCount < 0 || saved.duplicateCount > 999) return null;
    return { ...clean, duplicateCount: saved.duplicateCount };
  } catch { return null; }
  finally { await file?.close(); }
}

export async function listReels(env = process.env) {
  let files;
  try { files = await readdir(await directory(env)); }
  catch (error) {
    if (error.code === "ENOENT") return [];
    throw new AppError("The local library could not read saved collections.", { code: "REELS_READ_FAILED", status: 500 });
  }
  const collections = [];
  for (const name of files.filter((name) => /^reels-[a-f0-9]{24}\.json$/.test(name)).sort()) {
    const saved = await readReels(name.slice(0, -5), env);
    if (saved) collections.push({ id: saved.id, sourceId: saved.sourceId, schemaVersion: saved.schemaVersion, creator: saved.creator, sourceStatus: saved.sourceStatus, itemCount: saved.posts.length });
  }
  return collections;
}
