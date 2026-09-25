/**
 * Client-side report download helpers.
 *
 * Provides safe filename generation, Markdown sanitization to redact local
 * filesystem paths and raw run JSON, and browser download triggering.
 */

/**
 * Generate a safe, human-readable filename for an evidence report.
 *
 * @param {object|string} [source] - A run object, options object, or query string.
 * @param {object} [options]
 * @param {string} [options.query]
 * @param {string} [options.platform]
 * @returns {string} Safe filename ending with '.md'.
 */
export function generateReportFilename(source = {}, options = {}) {
  let query = "";
  let platform = "";

  if (typeof source === "string") {
    query = source;
    platform = options.platform || "";
  } else if (source && typeof source === "object") {
    query = source.query || source.request || options.query || "";
    platform = source.platform || source.requestedPlatform || options.platform || "";
  }

  const safePlatform = typeof platform === "string"
    ? platform.trim().toLowerCase().replace(/[^a-z0-9]/g, "")
    : "";

  const cleanQuery = stripFilesystemPaths(query);
  let slug = slugify(cleanQuery);

  if (slug.length > 50) {
    slug = slug.slice(0, 50).replace(/-[^-]*$/, "");
    if (!slug) slug = slugify(cleanQuery).slice(0, 50);
  }

  if (safePlatform && safePlatform !== "auto") {
    if (slug.startsWith(`${safePlatform}-`)) {
      slug = slug.slice(safePlatform.length + 1);
    } else if (slug === safePlatform) {
      slug = "";
    }
  }

  const parts = ["report"];
  if (safePlatform && safePlatform !== "auto") {
    parts.push(safePlatform);
  }
  if (slug) {
    parts.push(slug);
  }

  return `${parts.join("-")}.md`;
}

/**
 * Strip filesystem paths, drive letters, and traversal patterns from input text.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripFilesystemPaths(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/file:\/\/\/[^\s"'`<>)]*\/+/gi, " ")
    .replace(/\b[A-Za-z]:[/\\]+(?:[^/\s"'`<>)]+[/\\]+)*/g, " ")
    .replace(/(?:^|[\s("'`])(?:\/(?:Users|home|tmp|var|private|etc|usr|opt|bin|Windows|Program Files)\/(?:[^/\s"'`<>)]+[/\\]+)*)/gi, " ")
    .replace(/(?:\.{1,2}[/\\]+)+/g, " ")
    .replace(/[/\\]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Create a clean, filename-safe slug from text while preserving Unicode letters/numbers.
 *
 * @param {string} text
 * @returns {string}
 */
export function slugify(text) {
  if (typeof text !== "string") return "";
  return text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Sanitize Markdown report text before downloading or displaying.
 * Redacts any local filesystem paths and rejects raw run JSON dumps.
 *
 * @param {string} raw - Markdown content.
 * @returns {string} Sanitized UTF-8 Markdown text.
 */
export function sanitizeReportMarkdown(raw) {
  if (typeof raw !== "string") return "";
  let text = raw;

  // Do not expose raw run JSON payload if accidentally supplied as a string
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.report === "string" && parsed.report.trim()) {
          text = parsed.report;
        } else if (typeof parsed.finalSocaiOutput === "string" && parsed.finalSocaiOutput.trim()) {
          text = parsed.finalSocaiOutput;
        } else {
          return "";
        }
      }
    } catch {
      // not valid JSON, treat as standard text
    }
  }

  // Redact file:// URLs
  text = text.replace(/file:\/\/\/[^\s"'`<>)]+/gi, "[redacted path]");

  // Redact path-valued fields even when the value is relative.
  text = text.replace(/\b((?:run_dir|local_path|output_dir|artifact_path|report_path)\s*[:=]\s*)(?!\[redacted path\])(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s\r\n]+)/gi, "$1[redacted path]");

  // Redact Windows absolute paths
  text = text.replace(/\b[A-Za-z]:\\[^\s"'`<>)\r\n]+/g, "[redacted path]");
  text = text.replace(/\b[A-Za-z]:\/[^\s"'`<>)\r\n]+/g, "[redacted path]");

  // Redact UNC and home/traversal paths.
  text = text.replace(/(^|[\s("'`])\\\\[^\\\s"'`<>)\r\n]+(?:\\[^\\\s"'`<>)\r\n]+)+/g, "$1[redacted path]");
  text = text.replace(/(^|[\s("'`])(?:~[\\/]|\.{1,2}[\\/])[^\s"'`<>)\r\n]*/g, "$1[redacted path]");
  // File-like POSIX paths may contain spaces; relative file paths are private
  // too. The extension requirement keeps HTTP URL paths and prose intact.
  text = text.replace(/(^|[\s("'`=])(\/(?!\/)(?:[^/\r\n"'`<>\[\]{}]+\/)*[^/\r\n"'`<>\[\]{}]*?\.[A-Za-z0-9]{1,10})(?=$|[\s),;:!?\]}])/g, "$1[redacted path]");
  text = text.replace(/(^|[\s("'`=])((?:[A-Za-z0-9._~-]+\/)+[A-Za-z0-9._~ -]+\.[A-Za-z0-9]{1,10})(?=$|[\s),;:!?\]}])/g, "$1[redacted path]");
  // Cover extensionless absolute paths, including a single component.
  text = text.replace(/(^|[\s("'`=])(\/(?!\/)[^\s"'`<>)\]}\r\n,;:!?]+)/g, "$1[redacted path]");

  return text;
}

/**
 * Extract downloadable Markdown text from a run object or string.
 * Returns empty string if no valid report is available.
 *
 * @param {object|string} run
 * @returns {string}
 */
export function getReportMarkdown(run) {
  if (!run) return "";
  if (typeof run === "string") {
    const trimmed = run.trim();
    if (!trimmed || trimmed === "socai completed without a report.") return "";
    return sanitizeReportMarkdown(run);
  }
  if (typeof run === "object") {
    const candidate = typeof run.report === "string" && run.report.trim()
      ? run.report
      : typeof run.finalSocaiOutput === "string" && run.finalSocaiOutput.trim()
        ? run.finalSocaiOutput
        : "";
    if (!candidate || candidate === "socai completed without a report.") return "";
    return sanitizeReportMarkdown(candidate);
  }
  return "";
}

/**
 * Determine whether a run object or string has a non-empty, downloadable report.
 *
 * @param {object|string} source
 * @returns {boolean}
 */
export function isReportDownloadable(source) {
  const markdown = typeof source === "string" ? source.trim() : getReportMarkdown(source);
  if (!markdown) return false;
  if (markdown === "socai completed without a report.") return false;
  return markdown.length > 0;
}

/**
 * Download the report as a UTF-8 Markdown file in the browser,
 * or return the sanitized payload when running in headless/test environments.
 *
 * @param {object} [options]
 * @param {object} [options.run] - Full run object.
 * @param {string} [options.report] - Raw markdown report text.
 * @param {string} [options.filename] - Custom filename override.
 * @param {object} [options.document] - Injectable Document for testing.
 * @param {function} [options.Blob] - Injectable Blob constructor for testing.
 * @param {object} [options.URL] - Injectable URL interface for testing.
 * @returns {object} Result descriptor { ok: boolean, filename?: string, content?: string, size?: number, error?: string }
 */
export function downloadReport(options = {}) {
  const run = options.run || (options.report ? null : options);
  const rawReport = options.report || getReportMarkdown(run);
  const content = sanitizeReportMarkdown(rawReport);

  if (!isReportDownloadable(content)) {
    return { ok: false, error: "No non-empty report available for download." };
  }

  const filename = options.filename || generateReportFilename(run || options);
  return downloadMarkdownFile(filename, content, options);
}

/**
 * Trigger client-side download of UTF-8 Markdown content.
 *
 * @param {string} filename
 * @param {string} content
 * @param {object} [options]
 * @returns {object}
 */
export function downloadMarkdownFile(filename, content, options = {}) {
  const doc = options.document || (typeof document !== "undefined" ? document : null);
  const BlobClass = options.Blob || (typeof Blob !== "undefined" ? Blob : null);
  const urlInterface = options.URL || (typeof URL !== "undefined" ? URL : null);

  if (!doc || !BlobClass || !urlInterface?.createObjectURL) {
    return { ok: true, filename, content, clientSide: false };
  }

  const blob = new BlobClass([content], { type: "text/markdown;charset=utf-8" });
  const objectUrl = urlInterface.createObjectURL(blob);
  const anchor = doc.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.hidden = true;
  doc.body.append(anchor);
  anchor.click();
  anchor.remove();

  if (typeof urlInterface.revokeObjectURL === "function") {
    setTimeout(() => urlInterface.revokeObjectURL(objectUrl), 1500);
  }

  return { ok: true, filename, size: blob.size, clientSide: true };
}
