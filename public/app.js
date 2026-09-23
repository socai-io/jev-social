import {
  downloadReport,
  getReportMarkdown,
  isReportDownloadable,
} from "./report-download.js";
import {
  mediaPreviewCandidates,
  nextPreviewCandidate,
  selectSummaryCards,
} from "./evidence-preview.js";
import { bindPromptButtons, platformLabel, updatePromptButtons } from "./prompts.js";
import { parseRunRoute, resultHash } from "./run-route.js";
import { deriveStatusView } from "./status.js";

const $ = (selector) => document.querySelector(selector);
const elements = {
  searchView: $("#search-view"),
  resultView: $("#result-view"),
  searchForm: $("#search-form"),
  platformNotice: $("#platform-notice"),
  activity: $("#activity"),
  activityTitle: $("#activity-title"),
  activityMessage: $("#activity-message"),
  error: $("#error"),
  errorMessage: $("#error-message"),
  errorClose: $("#close-error"),
  result: $("#result"),
  cards: $("#cards"),
  evidenceHeading: $("#evidence-heading"),
  evidenceTable: $("#evidence-table"),
  reportSection: $("#research-report-section"),
  output: $("#socai-output"),
  downloadReportBtn: $("#download-report"),
  elapsed: $("#elapsed-time"),
  dialog: $("#detail-dialog"),
  detail: $("#detail-content"),
};

let timer;
let startedAt = 0;
let activeController;
let currentRun;
let restorePoll;

elements.searchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearError();
  clearPlatformNotice();
  resetLiveWorkspace();
  const query = $("#query").value.trim();
  $("#result-title").textContent = query;
  showResultView({ push: true });
  const button = elements.searchForm.querySelector("button[type=submit]");
  button.disabled = true;
  activeController?.abort();
  activeController = new AbortController();
  startTimer();
  showActivity("Jev is routing the request", "Preparing a read-only social research workflow…");
  try {
    const run = await streamApi("/api/search-stream", {
      query,
      platform: $("#platform").value,
    }, handleStreamEvent, activeController.signal);
    renderRun(run);
  } catch (error) {
    if (error.name !== "AbortError") showError(error);
  } finally {
    activeController = undefined;
    if (elements.resultView.classList.contains("is-running")) stopTimer();
    button.disabled = false;
  }
});

$("#back-to-search").addEventListener("click", () => {
  if (parseRunRoute(location.hash)) history.back();
  else showSearchView();
});
elements.downloadReportBtn?.addEventListener("click", () => {
  const fallbackReport = elements.output?.dataset?.markdown || elements.output?.textContent || "";
  const report = currentRun ? getReportMarkdown(currentRun) : fallbackReport;
  if (!isReportDownloadable(report)) return;
  downloadReport({ run: currentRun, report });
});
if (typeof window !== "undefined") {
  window.renderRun = renderRun;
  window.downloadReport = downloadReport;
}
$("#close-detail").addEventListener("click", () => elements.dialog.close());
$("#close-error")?.addEventListener("click", clearError);
elements.dialog.addEventListener("click", (event) => {
  if (event.target === elements.dialog) elements.dialog.close();
});

window.addEventListener("popstate", () => {
  if (parseRunRoute(location.hash)) void restoreRunFromRoute();
  else showSearchView();
});

void initialize();
bindPromptButtons({
  buttons: document.querySelectorAll(".prompt-example-btn"),
  queryElement: $("#query"),
  platformElement: $("#platform"),
});
$("#query")?.addEventListener("input", clearPlatformNotice);
$("#platform")?.addEventListener("change", clearPlatformNotice);

function handleStreamEvent(event) {
  if (event.stage === "result") return;
  if (event.stage === "started" && event.run?.id) {
    history.replaceState({ view: "results", runId: event.run.id }, "", `${location.pathname}${location.search}${resultHash(event.run.id)}`);
    return;
  }
  if (event.stage === "error") {
    const error = new Error(event.error?.message || "The social research run failed.");
    error.code = event.error?.code;
    error.details = event.error?.details;
    throw error;
  }
  if (event.stage === "evidence") {
    showLiveEvidence(event.items);
    return;
  }
  const titles = {
    classifying: "Jev is routing the request",
    planning: "Jev is choosing the next step",
    reading: "socai is opening the selected result",
    executing: "socai is starting the browser",
    searching: "socai is collecting search results",
    downloading: "socai is reading and downloading videos",
    researching: "socai is researching the captured evidence",
    complete: "socai finished the run",
  };
  const descriptions = {
    classifying: "Choosing the right social workflow.",
    executing: "Opening the local browser.",
    searching: "Collecting previewable posts.",
    downloading: "Preparing video previews.",
    researching: "Reading captured posts and building the report.",
    complete: "The research report is ready.",
  };
  showActivity(titles[event.stage] || "socai is working", event.message || descriptions[event.stage] || "Research is in progress.");
}

function startTimer(initialMs = 0) {
  startedAt = performance.now() - Math.max(0, Number(initialMs) || 0);
  clearInterval(timer);
  updateTimer();
  timer = setInterval(updateTimer, 100);
}

function stopTimer(finalMs) {
  clearInterval(timer);
  timer = undefined;
  if (Number.isFinite(finalMs)) elements.elapsed.textContent = formatDuration(finalMs);
  else updateTimer();
}

function updateTimer() {
  if (startedAt) elements.elapsed.textContent = `${((performance.now() - startedAt) / 1000).toFixed(1)} s`;
}

function showResultView({ push = false } = {}) {
  elements.searchView.classList.add("hidden");
  elements.resultView.classList.remove("hidden");
  if (push && !parseRunRoute(location.hash)) history.pushState({ view: "results" }, "", `${location.pathname}${location.search}${resultHash()}`);
}

function showSearchView() {
  activeController?.abort();
  clearTimeout(restorePoll);
  currentRun = undefined;
  if (elements.downloadReportBtn) {
    elements.downloadReportBtn.disabled = true;
    elements.downloadReportBtn.classList.add("hidden");
  }
  elements.resultView.classList.add("hidden");
  elements.searchView.classList.remove("hidden");
  elements.activity.classList.add("hidden");
  elements.resultView.classList.remove("has-live-evidence", "is-running");
  clearError();
  $("#query").focus();
}

async function initialize() {
  const status = refreshStatus();
  const restored = parseRunRoute(location.hash) ? restoreRunFromRoute() : Promise.resolve();
  await Promise.all([status, restored]);
}

async function restoreRunFromRoute() {
  const route = parseRunRoute(location.hash);
  if (!route) return;
  const requestedHash = location.hash;
  clearTimeout(restorePoll);
  showResultView();
  try {
    let id = route.id;
    if (!id) {
      const history = await api("/api/runs");
      if (location.hash !== requestedHash) return;
      id = history.runs?.[0]?.id || "";
    }
    if (!id) {
      resetLiveWorkspace();
      $("#result-title").textContent = "No saved research yet";
      return;
    }
    const run = await api(`/api/runs/${encodeURIComponent(id)}`);
    if (location.hash !== requestedHash) return;
    history.replaceState({ view: "results", runId: id }, "", `${location.pathname}${location.search}${resultHash(id)}`);
    renderRun(run);
    if (run.status === "running") {
      restorePoll = setTimeout(() => void restoreRunFromRoute(), 750);
    }
  } catch (error) {
    showError(error);
  }
}

async function refreshStatus() {
  try {
    const status = await api("/api/status");
    const view = deriveStatusView(status);
    setStatus("jev", view.jev.ready, view.jev.label);
    setStatus("socai", view.socai.ready, view.socai.label);
    if (view.error) showError(new Error(view.error));

    updatePlatformOptions(view.capabilities);
    updatePromptButtons(document.querySelectorAll(".prompt-example-btn"), view.capabilities);
  } catch (error) {
    showError(error);
  }
}

function updatePlatformOptions(caps = {}) {
  const platformSelect = $("#platform");
  if (!platformSelect) return;
  const previousValue = platformSelect.value;
  let switchedToAuto = false;

  for (const option of platformSelect.options) {
    const val = option.value;
    if (val === "auto") continue;
    const isAvailable = Boolean(caps[val]);
    option.disabled = !isAvailable;
    const label = platformLabel(val);
    if (!isAvailable) {
      option.title = `${label} search isn't available in this socai build`;
      option.textContent = `${label} (unavailable)`;
      if (previousValue === val) {
        switchedToAuto = true;
      }
    } else {
      option.title = "";
      option.textContent = label;
    }
  }

  if (switchedToAuto) {
    platformSelect.value = "auto";
    showPlatformNotice(`${platformLabel(previousValue)} search isn't available in this socai build. Switched to Jev auto.`);
  }
}

function showPlatformNotice(message) {
  if (elements.platformNotice) {
    elements.platformNotice.textContent = message;
    elements.platformNotice.classList.remove("hidden");
  }
}

function clearPlatformNotice() {
  if (elements.platformNotice) {
    elements.platformNotice.textContent = "";
    elements.platformNotice.classList.add("hidden");
  }
}

function setStatus(prefix, ready, label) {
  $(`#${prefix}-dot`).classList.toggle("ready", ready);
  $(`#${prefix}-status`).textContent = label;
}

function showActivity(title, message) {
  const changed = elements.activityTitle.textContent !== title || elements.activityMessage.textContent !== message;
  elements.activityTitle.textContent = title;
  elements.activityMessage.textContent = message;
  if (changed) {
    elements.activityMessage.classList.remove("message-swap");
    void elements.activityMessage.offsetWidth;
    elements.activityMessage.classList.add("message-swap");
  }
  elements.activity.classList.remove("hidden");
}

function showError(error) {
  elements.activity.classList.add("hidden");
  const message = error?.message || String(error || "An unexpected error occurred.");
  if (elements.errorMessage) {
    elements.errorMessage.textContent = message;
  } else {
    elements.error.textContent = message;
  }
  elements.error.classList.remove("hidden");
}

function clearError() {
  elements.error.classList.add("hidden");
  if (elements.errorMessage) {
    elements.errorMessage.textContent = "";
  } else {
    elements.error.textContent = "";
  }
}

function renderRun(run) {
  showResultView();
  elements.activity.classList.add("hidden");
  elements.resultView.classList.remove("has-live-evidence", "is-running");
  elements.reportSection.classList.remove("hidden");
  if (run.status === "running") startTimer(run.elapsedMs);
  else stopTimer(run.elapsedMs);
  $("#result-title").textContent = run.request || run.query || "Social results";
  $("#run-status").textContent = run.status === "running"
    ? "Research in progress · restored from the latest checkpoint"
    : run.status && run.status !== "completed" ? `Partial results · ${run.stopReason}` : "";
  $("#action-list").replaceChildren(...(run.actions || []).map((step) => element("li", "", `${step.action.label} · ${step.status}`)));
  $("#action-history").classList.toggle("hidden", !run.actions?.length);

  const items = findItems(run.result);
  const hasEvidence = items.length > 0;
  elements.evidenceHeading.classList.toggle("hidden", !hasEvidence);
  elements.evidenceTable.classList.toggle("hidden", !hasEvidence);
  elements.cards.classList.toggle("hidden", !hasEvidence);
  const downloaded = items.filter((item) => Boolean(localVideoSource(item))).length;
  $("#result-summary").textContent = `${items.length} captured ${items.length === 1 ? "record" : "records"}`;
  $("#media-summary").textContent = downloaded
    ? `${downloaded} downloaded ${downloaded === 1 ? "video" : "videos"}`
    : "read-only evidence";

  elements.cards.replaceChildren();
  if (items.length) {
    selectSummaryCards(items, 4).forEach((item, index) => {
      const card = renderCard(item, index);
      if (card) {
        card.classList.add("card-enter");
        elements.cards.append(card);
      }
    });
  }
  currentRun = run;
  renderTable(items);
  const reportMarkdown = getReportMarkdown(run);
  if (elements.output) elements.output.dataset.markdown = reportMarkdown;
  const canDownload = isReportDownloadable(reportMarkdown);
  if (elements.downloadReportBtn) {
    elements.downloadReportBtn.disabled = !canDownload;
    elements.downloadReportBtn.classList.toggle("hidden", !canDownload);
  }
  renderMarkdown(elements.output, reportMarkdown || "socai completed without a report.");
  revealReport(elements.output);
  elements.result.classList.remove("hidden");
}

function resetLiveWorkspace() {
  currentRun = undefined;
  if (elements.downloadReportBtn) {
    elements.downloadReportBtn.disabled = true;
    elements.downloadReportBtn.classList.add("hidden");
  }
  $("#run-status").textContent = "";
  $("#action-list").replaceChildren();
  elements.resultView.classList.remove("has-live-evidence");
  elements.resultView.classList.add("is-running");
  elements.result.classList.remove("hidden");
  elements.evidenceHeading.classList.remove("hidden");
  elements.evidenceTable.classList.add("hidden");
  elements.reportSection.classList.add("hidden");
  elements.cards.classList.remove("hidden");
  elements.cards.replaceChildren(element("div", "waiting-evidence", "Captured posts will appear here as soon as socai finds them."));
  $("#result-summary").textContent = "Waiting for the first post";
  $("#media-summary").textContent = "live evidence stream";
  elements.output.replaceChildren();
}

function showLiveEvidence(items) {
  const visible = Array.isArray(items) ? items.filter(isRecord) : [];
  if (!visible.length) return;
  showActivity(
    "Jev is reviewing the results",
    `${visible.length} ${visible.length === 1 ? "record" : "records"} captured. Choosing what to open next.`,
  );
  elements.resultView.classList.add("has-live-evidence");
  elements.result.classList.remove("hidden");
  elements.evidenceHeading.classList.remove("hidden");
  elements.cards.classList.remove("hidden");
  elements.evidenceTable.classList.add("hidden");
  elements.reportSection.classList.add("hidden");
  renderLiveCards(selectSummaryCards(visible, 4));
  $("#result-summary").textContent = `${visible.length} captured so far`;
  $("#media-summary").textContent = "live evidence stream";
}

function renderLiveCards(items) {
  const current = new Map(
    [...elements.cards.children].map((card) => [card.dataset.evidenceKey, card]),
  );
  const wanted = new Set();
  items.forEach((item, index) => {
    const key = evidenceKey(item, index);
    const fingerprint = JSON.stringify(item);
    wanted.add(key);
    const existing = current.get(key);
    let card = existing;
    if (existing?.dataset.fingerprint !== fingerprint) {
      card = renderCard(item, index);
      if (!card) return;
      card.dataset.evidenceKey = key;
      card.dataset.fingerprint = fingerprint;
      card.classList.add(existing ? "card-update" : "card-enter");
      if (existing) existing.replaceWith(card);
    }
    elements.cards.append(card);
  });
  for (const [key, card] of current) {
    if (!wanted.has(key)) card.remove();
  }
}

function evidenceKey(item, index) {
  return String(item.shortcode || item.video_id || item.id || item.url || item.web_url || item.share_url || `item-${index}`);
}

function renderCard(item, index) {
  const card = element("article", "card");
  const frame = element("div", "media-frame");
  renderMediaPreview(frame, item);
  card.append(frame);

  const body = element("div", "card-body");
  const title = firstString(item, ["title", "caption", "description", "text", "name"]) || `Result ${index + 1}`;
  const author = authorName(item);
  body.append(element("h4", "", title));
  if (author) body.append(element("p", "author", author.startsWith("@") ? author : `@${author}`));
  const stats = renderStats(item);
  if (stats) body.append(stats);
  const actions = element("div", "card-actions");
  const inspect = element("button", "", "View details");
  inspect.type = "button";
  inspect.addEventListener("click", () => showDetail(item, title));
  actions.append(inspect);
  const sourceUrl = firstString(item, ["url", "web_url", "share_url", "canonical_url"]);
  if (isHttpUrl(sourceUrl)) {
    const link = element("a", "", "Open source ↗");
    link.href = sourceUrl;
    link.target = "_blank";
    link.rel = "noreferrer";
    actions.append(link);
  }
  body.append(actions);
  card.append(body);
  return card;
}

function renderMediaPreview(frame, item, { showBadge = true } = {}) {
  const failed = new Set();
  const poster = posterSource(item);
  const tryNext = () => {
    const candidate = nextPreviewCandidate(item, failed);
    frame.classList.toggle("media-frame-fallback", candidate.kind === "fallback");
    if (candidate.kind === "fallback") {
      renderMediaFallback(frame, item);
      return;
    }
    if (candidate.kind.endsWith("video")) {
      const video = document.createElement("video");
      video.src = candidate.src;
      if (poster) video.poster = poster;
      video.controls = true;
      video.preload = "metadata";
      video.playsInline = true;
      video.addEventListener("error", () => {
        failed.add(candidate.src);
        tryNext();
      }, { once: true });
      const children = [video];
      if (showBadge) children.push(element("span", "media-badge", candidate.kind === "local-video" ? "downloaded video" : "remote video"));
      frame.replaceChildren(...children);
      return;
    }
    const image = document.createElement("img");
    image.src = candidate.src;
    image.alt = "";
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";
    image.addEventListener("error", () => {
      failed.add(candidate.src);
      tryNext();
    }, { once: true });
    const children = [image];
    if (showBadge) children.push(element("span", "media-badge", "image preview"));
    frame.replaceChildren(...children);
  };
  tryNext();
}

function renderMediaFallback(frame, item) {
  const platform = capitalize(String(item.platform || "social"));
  const fallback = element("div", "media-fallback");
  fallback.append(
    element("span", "media-fallback-platform", platform),
    element("strong", "", "Evidence captured"),
    element("small", "", "Preview unavailable — post details are still preserved."),
  );
  frame.replaceChildren(fallback);
}

function posterSources(item) {
  return mediaPreviewCandidates(item).filter((candidate) => candidate.kind === "image").map((candidate) => candidate.src);
}

function revealReport(container) {
  const blocks = [...container.children];
  blocks.forEach((block) => block.classList.add("report-reveal"));
  requestAnimationFrame(() => {
    blocks.forEach((block, index) => {
      setTimeout(() => block.classList.add("is-visible"), Math.min(index * 42, 840));
    });
  });
  if (!blocks.length) {
    container.classList.add("is-visible");
  }
}

function renderStats(item) {
  const definitions = [
    ["views", ["views", "view_count", "plays"]],
    ["likes", ["likes", "like_count"]],
    ["comments", ["comments_count", "comment_count"]],
    ["shares", ["shares", "share_count"]],
  ];
  const values = definitions.map(([label, keys]) => [label, firstValue(item, keys)]).filter(([, value]) => value !== "");
  if (!values.length) return null;
  const container = element("div", "stats");
  values.forEach(([label, value]) => container.append(element("span", "", `${compactNumber(value)} ${label}`)));
  return container;
}

function renderTable(items) {
  const columns = [
    ["Platform", (item) => item.platform || "—"],
    ["Author", authorName],
    ["Title / caption", (item) => firstString(item, ["title", "caption", "description", "text", "name"]) || "—"],
    ["Published", (item) => firstString(item, ["created_at", "published_at", "date"]) || "—"],
    ["Views", (item) => firstValue(item, ["views", "view_count", "plays"]) || "—"],
    ["Likes", (item) => firstValue(item, ["likes", "like_count"]) || "—"],
    ["Comments", (item) => firstValue(item, ["comments_count", "comment_count"]) || "—"],
    ["Shares", (item) => firstValue(item, ["shares", "share_count"]) || "—"],
    ["Duration", (item) => item.duration_seconds === undefined ? "—" : `${item.duration_seconds}s`],
    ["Media", (item) => localVideoSource(item) ? "Downloaded video" : remoteVideoSource(item) ? "Remote video" : posterSource(item) ? "Image preview" : "Unavailable"],
  ];
  const headRow = document.createElement("tr");
  columns.forEach(([label]) => headRow.append(element("th", "", label)));
  $("#table-head").replaceChildren(headRow);
  const rows = items.map((item) => {
    const row = document.createElement("tr");
    columns.forEach(([, read]) => row.append(element("td", "", String(read(item)))));
    return row;
  });
  $("#table-body").replaceChildren(...rows);
}

function showDetail(item, title) {
  const media = element("div", "detail-media");
  renderMediaPreview(media, item, { showBadge: false });
  const copy = element("div", "detail-copy");
  copy.append(element("h3", "", title));
  const description = firstString(item, ["description", "caption", "text", "title"]);
  if (description) copy.append(element("p", "", description));
  const comments = item.top_comments || item.comments || item.socai_detail?.entity?.top_comments;
  if (Array.isArray(comments) && comments.length) {
    copy.append(element("p", "eyebrow", `TOP COMMENTS · ${comments.length}`));
    for (const comment of comments) copy.append(element("p", "", `${authorName(comment) || "Comment"}: ${comment.text || ""}`));
  }
  const sourceUrl = firstString(item, ["url", "web_url", "share_url", "canonical_url"]);
  if (isHttpUrl(sourceUrl)) {
    const link = element("a", "detail-source", "Open original post ↗");
    link.href = sourceUrl;
    link.target = "_blank";
    link.rel = "noreferrer";
    copy.append(link);
  }
  const content = element("div", "detail-content");
  content.append(media, copy);
  elements.detail.replaceChildren(content);
  elements.dialog.showModal();
}

function localVideoSource(item) {
  return mediaPreviewCandidates(item).find((candidate) => candidate.kind === "local-video")?.src || "";
}

function remoteVideoSource(item) {
  return mediaPreviewCandidates(item).find((candidate) => candidate.kind === "remote-video")?.src || "";
}

function posterSource(item) {
  return posterSources(item)[0] || "";
}

function emptyResultMessage(run) {
  if (run.result?.status === "empty" || run.result?.search_state?.empty) {
    return `socai completed successfully. ${capitalize(run.platform)} returned no matches for “${run.query}”.`;
  }
  if (run.result?.ok === false) return `socai returned ${run.result.status || run.result.reason || "an unavailable state"}. The complete output is below.`;
  return "socai completed successfully, but returned no displayable records.";
}

function findItems(value) {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];
  for (const key of ["items", "results", "cards", "videos", "posts", "notes", "data"]) {
    if (Array.isArray(value[key])) return value[key].filter(isRecord).map((item) => isRecord(item.entity) ? { ...item, ...item.entity } : item);
    if (isRecord(value[key])) {
      const nested = findItems(value[key]);
      if (nested.length) return nested;
    }
  }
  return [];
}

async function streamApi(url, body, onEvent, signal) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) return parseApiError(response);
  if (!response.body) throw new Error("Streaming response is unavailable in this browser.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let run;
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n");
    buffer = done ? "" : lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      onEvent(event);
      if (event.stage === "result") run = event.run;
    }
    if (done) break;
  }
  if (!run) throw new Error("socai stream ended before returning a result.");
  return run;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!response.ok) return parseApiError(response);
  return response.json();
}

async function parseApiError(response) {
  const value = await response.json().catch(() => ({}));
  const error = new Error(value.error?.message || `HTTP ${response.status}`);
  error.code = value.error?.code;
  error.details = value.error?.details;
  throw error;
}

function element(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== "") node.textContent = text;
  return node;
}

function renderMarkdown(container, markdown) {
  container.replaceChildren();
  const lines = String(markdown || "").replace(/\r/g, "").split("\n");
  let list;
  let listKind;
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = rawLine.trim();
    if (!line) {
      list = undefined;
      listKind = undefined;
      continue;
    }
    if (line.startsWith("|") && /^\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(lines[index + 1]?.trim() || "")) {
      list = undefined;
      listKind = undefined;
      const table = document.createElement("table");
      const thead = document.createElement("thead");
      const tbody = document.createElement("tbody");
      thead.append(markdownTableRow(line, "th"));
      index += 2;
      while (index < lines.length && lines[index].trim().startsWith("|")) {
        tbody.append(markdownTableRow(lines[index].trim(), "td"));
        index += 1;
      }
      index -= 1;
      table.append(thead, tbody);
      const scroll = element("div", "table-scroll report-table");
      scroll.append(table);
      container.append(scroll);
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      list = undefined;
      listKind = undefined;
      const level = Math.min(heading[1].length + 1, 5);
      const node = element(`h${level}`);
      appendMarkdownInline(node, heading[2]);
      container.append(node);
      continue;
    }
    const bullet = line.match(/^([-*]|\d+\.)\s+(.+)$/);
    if (bullet) {
      const kind = /\d/.test(bullet[1]) ? "ol" : "ul";
      if (!list || listKind !== kind) {
        list = document.createElement(kind);
        listKind = kind;
        container.append(list);
      }
      const item = element("li");
      appendMarkdownInline(item, bullet[2]);
      list.append(item);
      continue;
    }
    list = undefined;
    listKind = undefined;
    const paragraph = element("p");
    appendMarkdownInline(paragraph, line);
    container.append(paragraph);
  }
}

function markdownTableRow(line, cellTag) {
  const row = document.createElement("tr");
  const cells = line.replace(/^\||\|$/g, "").split("|");
  for (const value of cells) {
    const cell = document.createElement(cellTag);
    appendMarkdownInline(cell, value.trim());
    row.append(cell);
  }
  return row;
}

function appendMarkdownInline(container, value) {
  const pattern = /(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*|`([^`]+)`)/g;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    container.append(document.createTextNode(value.slice(cursor, match.index)));
    if (match[2] && match[3]) {
      const link = element("a", "", match[2]);
      link.href = match[3];
      link.target = "_blank";
      link.rel = "noreferrer";
      container.append(link);
    } else if (match[4]) {
      container.append(element("strong", "", match[4]));
    } else {
      container.append(element("code", "", match[5]));
    }
    cursor = match.index + match[0].length;
  }
  container.append(document.createTextNode(value.slice(cursor)));
}

function firstString(object, keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function firstValue(object, keys) {
  for (const key of keys) {
    const value = object?.[key] ?? object?.engagement?.[key];
    if ((typeof value === "string" && value.trim()) || typeof value === "number") return String(value);
  }
  return "";
}

function authorName(item) {
  const value = item?.author_name ?? item?.author ?? item?.username ?? item?.nickname ?? item?.handle ?? item?.author_id;
  if (typeof value === "string") return value;
  if (isRecord(value)) return firstString(value, ["username", "name", "nickname", "id"]);
  return "";
}

function compactNumber(value) {
  const number = Number(String(value).replaceAll(",", ""));
  if (!Number.isFinite(number)) return value;
  return Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(number);
}

function isRecord(value) { return value && typeof value === "object" && !Array.isArray(value); }
function isHttpUrl(value) { return typeof value === "string" && /^https?:\/\//i.test(value); }
function capitalize(value = "") { return value.charAt(0).toUpperCase() + value.slice(1); }
function formatDuration(value) { return value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(1)} s`; }
