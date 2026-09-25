import { sourceUrl, targetKind } from "./actions.js";

const record = (value) => value && typeof value === "object" && !Array.isArray(value);
const PRIVATE_EVIDENCE_KEY = /^(?:stdout|stderr|cookie(?:s|_jar|_string)?|dom|dom_state|(?:inner_|outer_)?html|page_source|storage_state|(?:.*_)?headers|authorization|(?:.*_)?token|api_?key|secret|password|raw(?:_.*)?)$/i;
const LOCAL_PATH_KEY = /(?:^|_)(?:local_)?path$|(?:^|_)(?:run|output|artifact)_dir$/i;

export function unwrapResult(value) {
  return record(value?.data) ? value.data : value;
}

export function extractEvidence(raw, action) {
  const data = unwrapResult(raw);
  if (!data || action.kind === "page_state") return [];
  const output = [];
  const add = (value, detailRead = false) => {
    if (!record(value) || value.ok === false) return;
    const entity = record(value.entity) ? value.entity : value;
    if (entity.ok === false) return;
    const item = { ...entity, platform: action.platform };
    item.url = sourceUrl(entity.url || entity.web_url || entity.share_url || value.url || (detailRead ? action.target : ""), action.platform);
    if (!item.url) return;
    if (Array.isArray(value.comments)) item.top_comments = value.comments;
    item.detail_read = detailRead;
    item.kind ||= targetKind(item.url, action.platform) || "result";
    output.push(item);
  };
  const detail = ["read_post", "read_profile", "read_company", "history"].includes(action.kind);
  if (Array.isArray(data)) data.forEach((value) => add(value, detail));
  for (const key of ["results", "cards", "items", "posts", "videos", "video_cards"]) {
    if (Array.isArray(data[key])) data[key].forEach((value) => add(value, action.kind === "read_post"));
  }
  if (record(data.profile)) {
    add(data.profile, action.kind === "read_profile");
    for (const card of Array.isArray(data.profile.video_cards) ? data.profile.video_cards : []) add(card);
  }
  if (detail && !["read_post"].includes(action.kind) && !record(data.profile)) add(data, true);
  return output;
}

export function mergeEvidence(previous, incoming) {
  const items = new Map(previous.map((item) => [item.url, item]));
  for (const item of incoming) {
    const old = items.get(item.url) || {};
    const fields = Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined && value !== null && value !== ""));
    items.set(item.url, { ...old, ...fields, detail_read: Boolean(old.detail_read || item.detail_read) });
  }
  return [...items.values()];
}

export function resultObservation(raw, captured) {
  const data = unwrapResult(raw) || {};
  const states = [data, data.state, data.entity, ...(Array.isArray(data.posts) ? data.posts : []), ...(Array.isArray(data.videos) ? data.videos : [])].filter(record);
  const gate = states.find((state) => ["login_required", "challenge_required", "rate_limited"].some((key) => state[key] === true)
    || /login|captcha|challenge|rate.?limit|access.?denied|sign.?in/i.test(String(state.reason || state.status || state.error?.code || state.error || "")));
  return {
    ok: data.ok !== false,
    count: captured.length,
    status: typeof data.status === "string" ? data.status : undefined,
    reason: typeof data.reason === "string" ? data.reason : gate?.reason || gate?.status || (gate && ["login_required", "challenge_required", "rate_limited"].find((key) => gate[key] === true)),
    blocked: Boolean(gate),
    urls: captured.map((item) => item.url),
  };
}

export function publicEvidence(value) {
  if (Array.isArray(value)) return value.map(publicEvidence).filter((item) => item !== undefined);
  if (!record(value)) {
    return typeof value === "string" ? redactLocalPaths(value) : value;
  }
  const clean = {};
  for (const [key, child] of Object.entries(value)) {
    if (LOCAL_PATH_KEY.test(key) || PRIVATE_EVIDENCE_KEY.test(key)) continue;
    if (/(?:^|_)browser_url$/i.test(key) && typeof child === "string" && /^\/media\/[A-Za-z0-9_-]+$/.test(child)) {
      clean[key] = child;
      continue;
    }
    const next = publicEvidence(child);
    if (next !== undefined) clean[key] = next;
  }
  return clean;
}

export function redactLocalPaths(value) {
  return String(value || "")
    .replace(/\b((?:run_dir|local_path|output_dir|artifact_path|report_path)\s*[:=]\s*)(?!\[redacted path\])(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s\r\n]+)/gi, "$1[redacted path]")
    .replace(/file:\/\/\/[^\s"'`<>)\]}]+/gi, "[redacted path]")
    .replace(/\b[A-Za-z]:[\\/][^\s"'`<>)\]}\r\n]+/g, "[redacted path]")
    .replace(/(^|[\s("'`])\\\\[^\\\s"'`<>)\]}\r\n]+(?:\\[^\\\s"'`<>)\]}\r\n]+)+/g, "$1[redacted path]")
    .replace(/(^|[\s("'`])(?:~[\\/]|\.{1,2}[\\/])[^\s"'`<>)\]}\r\n]*/g, "$1[redacted path]")
    // File-like POSIX paths may contain spaces. Requiring a short extension
    // avoids treating ordinary prose or HTTP URL paths as filesystem data.
    .replace(/(^|[\s("'`=])(\/(?!\/)(?:[^/\r\n"'`<>\[\]{}]+\/)*[^/\r\n"'`<>\[\]{}]*?\.[A-Za-z0-9]{1,10})(?=$|[\s),;:!?\]}])/g, "$1[redacted path]")
    .replace(/(^|[\s("'`=])((?:[A-Za-z0-9._~-]+\/)+[A-Za-z0-9._~ -]+\.[A-Za-z0-9]{1,10})(?=$|[\s),;:!?\]}])/g, "$1[redacted path]")
    // Also cover extensionless absolute paths, including a single component.
    .replace(/(^|[\s("'`=])(\/(?!\/)[^\s"'`<>)\]}\r\n,;:!?]+)/g, "$1[redacted path]");
}

export function evidenceReport({ request, platform, items, actions, status, stopReason }) {
  const lines = ["# Captured evidence", "", `Request: ${markdown(request)}`, "", `${items.length} records from ${platform}; ${actions.filter((step) => step.command).length} browser operations.`, ""];
  for (const [index, item] of items.entries()) {
    lines.push(`## ${index + 1}. ${markdown(item.title || item.name || item.author || "Captured result").slice(0, 180)}`, "", `[Source](${item.url})`, "");
    const text = item.caption || item.description || item.text || item.bio || item.subtitle;
    if (text) lines.push(markdown(text), "");
    lines.push(item.detail_read ? "Details opened through socai." : "Search or profile card; details not opened.", "");
    const comments = item.top_comments || (Array.isArray(item.comments) ? item.comments : []);
    for (const comment of comments.slice(0, 8)) {
      const content = comment.text || comment.content;
      if (content) lines.push(`- Comment: ${markdown(content)}`);
    }
    for (const section of ["experience", "education"]) {
      if (item[section]) lines.push("", `${section}: ${markdown(JSON.stringify(item[section]))}`);
    }
    lines.push("");
  }
  lines.push("## Run notes", "", markdown(stopReason), "", "This report lists captured evidence; it does not infer trends or rankings from unverified material.");
  if (status !== "completed") lines.push("", "The run is partial. Available evidence has been preserved.");
  return lines.join("\n");
}

function markdown(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return String(text || "").replace(/[\\`*_{}\[\]<>#|]/g, "\\$&");
}
