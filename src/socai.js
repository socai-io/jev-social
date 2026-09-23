import { AppError } from "./errors.js";
import { configuredSocaiBin, defaultInstalledSocaiBin } from "./config.js";
import { formatCommand, runProcess } from "./process.js";
import { buildActionArgs } from "./actions.js";

const PLATFORMS = ["instagram", "tiktok", "linkedin"];

export async function actionCapabilities({ config = {}, env = process.env, platform, signal, capabilities }) {
  if (!PLATFORMS.includes(platform)) throw new AppError("Unsupported platform.", { code: "INVALID_PLATFORM" });
  const bin = await resolveSocaiBin(config, env);

  const isSearchSupported = capabilities && typeof capabilities[platform] === "boolean"
    ? capabilities[platform]
    : await platformSupported(bin, platform, env, signal);

  const result = await runProcess(bin, [platform, "--help"], { env, signal, timeoutMs: 15_000 });
  if (result.aborted) throw abortedError();
  if (result.code !== 0 || result.timedOut) {
    if (isSearchSupported) {
      return ["search"];
    }
    throw new AppError(`Could not read socai ${platform} commands.`, { code: "SOCAI_CAPABILITY_MISSING" });
  }
  const help = `${result.stdout}\n${result.stderr}`;
  const names = ["search", "get-posts", "get-videos", "profile", "author", "company", "history", "page_state"];

  const discovered = names.filter((name) => new RegExp(`(?:^|\\s)${name}(?=\\s|$)`, "m").test(help));
  if (!isSearchSupported) {
    return discovered.filter((name) => name !== "search");
  }
  if (!discovered.includes("search")) {
    discovered.unshift("search");
  }
  return discovered;
}

export async function runSocaiAction({ action, config = {}, env = process.env, signal, onProgress }) {
  const bin = await resolveSocaiBin(config, env);
  return runSocaiJson(bin, buildActionArgs(action), { env, signal, onProgress });
}

export async function resolveSocaiBin(config = {}, env = process.env) {
  return configuredSocaiBin(config, env) || (await defaultInstalledSocaiBin());
}

export async function probeSocai(config = {}, env = process.env, signal) {
  const bin = await resolveSocaiBin(config, env);
  try {
    const root = await runProcess(bin, ["--help"], { timeoutMs: 15_000, env, signal });
    if (root.aborted) throw abortedError();
    if (root.code !== 0) {
      return {
        installed: false,
        bin,
        version: null,
        capabilities: { instagram: false, tiktok: false, linkedin: false },
        error: concise(root.stderr || root.stdout),
      };
    }
    const version = await getSocaiVersion(bin, env, signal);
    const capabilities = { instagram: false, tiktok: false, linkedin: false };
    await Promise.all(
      PLATFORMS.map(async (platform) => {
        capabilities[platform] = await platformSupported(bin, platform, env, signal);
      }),
    );
    return { installed: true, bin, version, capabilities };
  } catch (error) {
    if (error?.code === "SOCAI_ABORTED" || error?.name === "AbortError" || signal?.aborted) {
      throw abortedError();
    }
    return {
      installed: false,
      bin,
      version: null,
      capabilities: { instagram: false, tiktok: false, linkedin: false },
      error: error.code === "ENOENT" ? "socai executable not found" : concise(error.message),
    };
  }
}

/**
 * Extracts sanitized semver from `socai --version` output.
 * Assumes the CLI output includes the primary semver token (e.g. `socai 0.5.6` or `0.5.6-beta.1`).
 * If verbose builds output multiple version numbers, the primary/first semver token is selected.
 */
export async function getSocaiVersion(bin, env = process.env, signal) {
  try {
    const result = await runProcess(bin, ["--version"], { timeoutMs: 15_000, env, signal });
    if (result.aborted) throw abortedError();
    const output = `${result.stdout}\n${result.stderr}`.trim();
    const match = output.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\b/);
    return match ? match[0] : null;
  } catch (error) {
    if (error?.code === "SOCAI_ABORTED" || error?.name === "AbortError" || signal?.aborted) {
      throw abortedError();
    }
    return null;
  }
}

export async function platformSupported(bin, platform, env = process.env, signal) {
  try {
    // Probe the concrete subcommand's help rather than pattern-matching the
    // parent command's prose — a platform may mention "search" in an error
    // or disclaimer string without the subcommand actually existing.
    const subcommand = await runProcess(bin, [platform, "search", "--help"], {
      timeoutMs: 15_000,
      env,
      signal,
    }).catch((error) => {
      if (error?.name === "AbortError") throw abortedError();
      return null;
    });
    if (subcommand?.aborted) throw abortedError();
    if (subcommand && subcommand.code === 0) return true;

    const parent = await runProcess(bin, [platform, "--help"], { timeoutMs: 15_000, env, signal });
    if (parent.aborted) throw abortedError();
    if (parent.code !== 0) return false;
    const output = `${parent.stdout}\n${parent.stderr}`;
    return (
      /(?:commands|subcommands|available commands|actions):\s*[^\n]*\bsearch\b/i.test(output) ||
      /(?:^|\n)\s*search(?:\s{2,}[^\n]*|\s*\[[^\n]*|\s*$)/m.test(output)
    );
  } catch (error) {
    if (error?.code === "SOCAI_ABORTED" || error?.name === "AbortError") throw abortedError();
    return false;
  }
}

export function buildSearchArgs(platform, query, limit) {
  if (!PLATFORMS.includes(platform)) {
    throw new AppError(`Unsupported socai site: ${platform}`, { code: "INVALID_PLATFORM" });
  }
  const count = Number(limit);
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new AppError("limit must be an integer between 1 and 100.", { code: "INVALID_LIMIT" });
  }
  return [platform, "search", query, "--num", String(count), "--pretty"];
}

export function buildTikTokVideoArgs(locators, { numComments = 8 } = {}) {
  const videos = [...new Set(locators.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
  if (!videos.length) {
    throw new AppError("TikTok video hydration requires at least one video URL or ID.", {
      code: "MISSING_VIDEO_LOCATOR",
    });
  }
  const comments = Number(numComments);
  if (!Number.isInteger(comments) || comments < 0 || comments > 100) {
    throw new AppError("numComments must be an integer between 0 and 100.", {
      code: "INVALID_COMMENT_LIMIT",
    });
  }
  return [
    "tiktok",
    "get-videos",
    ...videos.flatMap((video) => ["--video", video]),
    "--num-comments",
    String(comments),
    "--download-media",
    "--pretty",
  ];
}

export function buildResearchArgs(platform, task, { maxSteps = 12 } = {}) {
  if (!PLATFORMS.includes(platform)) {
    throw new AppError(`Unsupported socai site: ${platform}`, { code: "INVALID_PLATFORM" });
  }
  const steps = Number(maxSteps);
  if (!Number.isInteger(steps) || steps < 1 || steps > 30) {
    throw new AppError("maxSteps must be an integer between 1 and 30.", {
      code: "INVALID_MAX_STEPS",
    });
  }
  const goal = String(task || "").trim();
  if (!goal) {
    throw new AppError("Research task cannot be empty.", { code: "EMPTY_QUERY" });
  }
  return ["research", goal, "--platform", platform, "--max-steps", String(steps), "--pretty"];
}

export async function runSocaiSearch({
  config = {},
  env = process.env,
  platform,
  query,
  limit = 10,
  onProgress,
  signal,
}) {
  const bin = await resolveSocaiBin(config, env);
  if (!(await platformSupported(bin, platform, env, signal))) {
    throw new AppError(
      `This socai binary does not expose '${platform} search'. Install a compatible build or set SOCAI_BIN.`,
      {
        code: "SOCAI_CAPABILITY_MISSING",
        details: { platform },
      },
    );
  }

  return runSocaiJson(bin, buildSearchArgs(platform, query, limit), { env, onProgress, signal });
}

export async function runSocaiResearch({
  config = {},
  env = process.env,
  platform,
  task,
  maxSteps = 12,
  onProgress,
  signal,
}) {
  const bin = await resolveSocaiBin(config, env);
  const capability = await runProcess(bin, ["research", "--help"], {
    timeoutMs: 15_000,
    env,
    signal,
  }).catch((error) => {
    if (error?.name === "AbortError") throw abortedError();
    return null;
  });
  if (capability?.aborted) throw abortedError();
  if (!capability || capability.code !== 0) {
    throw new AppError("This socai binary does not expose 'socai research'. Build the dev-compatible CLI or set SOCAI_BIN.", {
      code: "SOCAI_RESEARCH_CAPABILITY_MISSING",
    });
  }
  return runSocaiJson(bin, buildResearchArgs(platform, task, { maxSteps }), {
    env,
    onProgress,
    signal,
    timeoutMs: 20 * 60_000,
  });
}

export async function runSocaiTikTokVideos({
  config = {},
  env = process.env,
  locators,
  numComments = 8,
  onProgress,
  signal,
}) {
  const bin = await resolveSocaiBin(config, env);
  const capability = await runProcess(bin, ["tiktok", "get-videos", "--help"], {
    timeoutMs: 15_000,
    env,
    signal,
  }).catch((error) => {
    if (error?.name === "AbortError") throw abortedError();
    return null;
  });
  if (capability?.aborted) throw abortedError();
  if (!capability || capability.code !== 0) {
    throw new AppError("This socai binary does not expose 'tiktok get-videos'. Install the dev-compatible build or set SOCAI_BIN.", {
      code: "SOCAI_VIDEO_CAPABILITY_MISSING",
    });
  }
  return runSocaiJson(bin, buildTikTokVideoArgs(locators, { numComments }), {
    env,
    onProgress,
    signal,
    timeoutMs: 12 * 60_000,
  });
}

async function runSocaiJson(bin, args, { env, onProgress, signal, timeoutMs = 8 * 60_000 }) {
  const command = formatCommand(bin, args);
  const startedAt = Date.now();
  let result;
  try {
    result = await runProcess(bin, args, {
      timeoutMs,
      env: { ...env, NO_COLOR: "1" },
      onStderr: onProgress,
      signal,
    });
  } catch (error) {
    throw new AppError(`Could not start socai CLI: ${concise(error.message)}`, {
      code: "SOCAI_NOT_FOUND",
    });
  }

  if (result.aborted) {
    throw new AppError("socai CLI was cancelled because the client disconnected.", {
      code: "SOCAI_ABORTED",
      status: 499,
    });
  }

  if (result.timedOut) {
    throw new AppError(`socai CLI timed out after ${Math.round(timeoutMs / 60_000)} minutes.`, {
      code: "SOCAI_TIMEOUT",
      status: 504,
    });
  }
  if (result.overflowed) {
    throw new AppError("socai CLI output exceeded the 24 MB safety limit.", {
      code: "SOCAI_OUTPUT_TOO_LARGE",
    });
  }
  if (result.code !== 0) {
    throw new AppError(`socai CLI failed: ${concise(result.stderr || result.stdout)}`, {
      code: "SOCAI_FAILED",
      status: 502,
      details: { exitCode: result.code, ...(result.signal ? { signal: result.signal } : {}) },
    });
  }

  return {
    command,
    exitCode: result.code,
    elapsedMs: Date.now() - startedAt,
    stdout: result.stdout,
    stderr: result.stderr,
    data: parseJsonOutput(result.stdout),
  };
}

export function parseJsonOutput(output) {
  const trimmed = output.trim();
  if (!trimmed) {
    throw new AppError("socai CLI returned no JSON output.", {
      code: "EMPTY_SOCAI_OUTPUT",
      status: 502,
    });
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    for (let index = 0; index < trimmed.length; index += 1) {
      if (trimmed[index] !== "{" && trimmed[index] !== "[") continue;
      try {
        return JSON.parse(trimmed.slice(index));
      } catch {
        // Keep looking for the start of a trailing JSON document.
      }
    }
  }
  throw new AppError("socai CLI output was not valid JSON.", {
    code: "INVALID_SOCAI_OUTPUT",
    status: 502,
    details: { preview: concise(trimmed, 500) },
  });
}

function isPathLike(val) {
  if (!val) return false;
  let decoded = val;
  for (let pass = 0; pass < 3; pass += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return (
    /^[A-Za-z]:[/\\]/i.test(decoded) ||
    /^[A-Za-z]:[^/\\\s]+[/\\]/i.test(decoded) ||
    /^file:\/\/\//i.test(decoded) ||
    /^~[/\\]/.test(decoded) ||
    /^\.{1,2}[/\\]/.test(decoded) ||
    /^[/\\](?![/\\])[^/?#\\]+(?:[/\\][^/?#\\]+)*$/.test(decoded) ||
    /^\/(?!\/)[^/?#]+(?:[/\\][^/?#]+)*$/.test(decoded) ||
    /^\/(?:Users|home|root|tmp|var|opt|usr|etc|Volumes|private|mnt|media|srv|dev|proc|sys)\b/i.test(decoded) ||
    /^(?:\/[a-zA-Z0-9._~-]+){2,}/.test(decoded) ||
    /^[/\\]{2}/.test(decoded) ||
    /\b[A-Za-z]:[/\\]/i.test(decoded) ||
    /^[a-zA-Z0-9_.-]+[/\\].+$/.test(decoded) ||
    /^[a-zA-Z0-9_.-]+[/\\][a-zA-Z0-9_.-]+(?:[/\\][a-zA-Z0-9_.-]+)*$/.test(decoded) ||
    /\b(?:[a-zA-Z0-9_.-]+[/\\]){2,}[a-zA-Z0-9_.-]+/.test(decoded)
  );
}

function sanitizeUrl(urlStr) {
  try {
    const url = new URL(urlStr);
    if (url.search) {
      const parts = url.search.slice(1).split("&");
      const sanitizedParts = parts.map((part) => {
        const eqIdx = part.indexOf("=");
        if (eqIdx === -1) {
          return isPathLike(part) ? "[path]" : part;
        }
        const key = part.slice(0, eqIdx);
        const val = part.slice(eqIdx + 1);
        return isPathLike(val) ? `${key}=[path]` : part;
      });
      url.search = `?${sanitizedParts.join("&")}`;
    }
    if (url.hash) {
      const hashContent = url.hash.slice(1);
      if (hashContent.includes("&") || hashContent.includes("=")) {
        const parts = hashContent.split("&");
        const sanitizedParts = parts.map((part) => {
          const eqIdx = part.indexOf("=");
          if (eqIdx === -1) {
            return isPathLike(part) ? "[path]" : part;
          }
          const key = part.slice(0, eqIdx);
          const val = part.slice(eqIdx + 1);
          return isPathLike(val) ? `${key}=[path]` : part;
        });
        url.hash = `#${sanitizedParts.join("&")}`;
      } else if (isPathLike(hashContent)) {
        url.hash = "#[path]";
      }
    }
    return url.toString().replace(/%5Bpath%5D/gi, "[path]");
  } catch {
    return urlStr;
  }
}

export function sanitizeCliErrorText(text) {
  if (typeof text !== "string") return "";

  // 1. Preserve HTTP/HTTPS URLs by replacing with temporary placeholders after sanitizing query/fragment paths
  const urls = [];
  const withUrlsPreserved = text.replace(/https?:\/\/[^\s"'`<>]+/gi, (url) => {
    const match = url.match(/^(.*?)([.,;:!?)]*)$/);
    const cleanUrl = match ? match[1] : url;
    const trailing = match ? match[2] : "";
    urls.push(sanitizeUrl(cleanUrl));
    return `__URL_PLACEHOLDER_${urls.length - 1}__${trailing}`;
  });

  // 2. Perform path redactions
  const redacted = withUrlsPreserved
    // 1. Local file URLs
    .replace(/\bfile:\/\/\/?(?:[A-Za-z]:)?[^\s"'`<>),;!?]+/gi, "[path]")
    // 2. Quoted paths
    .replace(/(["'`])(?:\/|~\/|[A-Za-z]:[/\\]|\\\\|\.{1,2}[/\\])[^"'`]*\1/g, "[path]")
    // 3. Unquoted paths with spaces that end in a filename extension
    .replace(
      /(?:^|[\s"'`([<{=:])(?:\/|~\/|[A-Za-z]:[/\\]|\\\\|\.{1,2}[/\\]|[a-zA-Z][a-zA-Z0-9_.-]*[/\\])[^\s:)]*(?:[ \t][^\s:)]*)+\.[a-zA-Z0-9_-]{1,16}(?=\s|[,;!?)]|$)/gi,
      (match) => {
        const leadingChar = match.match(/^[\s"'`([<{=:]/)?.[0] || "";
        return `${leadingChar}[path]`;
      },
    )
    // 4. Other unquoted paths with spaces (e.g. /Volumes/My Disk/socai or C:\Program Files\socai\socai.exe)
    .replace(
      /(?:^|[\s"'`([<{=:])(?:\/|~\/|[A-Za-z]:[/\\]|\\\\|\.{1,2}[/\\]|[a-zA-Z][a-zA-Z0-9_.-]*[/\\])(?=[^:\r\n)]*\s+[^:\r\n)]*[/\\])(?:[^\s:)]|(?<! )\s(?! ))*?(?=\s+(?:ENOENT|EACCES|EPERM|EEXIST|not found|no such file|is not recognized|exited with|failed with|script|because|while|when|but|and|or|then|after|before|retrying)\b|(?::|[,;!?)]|\.(?:\s|$))(?:\s|$|\b)|\s{2}|$)/gi,
      (match) => {
        const leadingChar = match.match(/^[\s"'`([<{=:]/)?.[0] || "";
        const pathPart = match.slice(leadingChar.length);
        const trailingPunct = pathPart.match(/[).,;:!?]+$/)?.[0] || "";
        return `${leadingChar}[path]${trailingPunct}`;
      },
    )
    // 5. General paths (single token or standard paths)
    .replace(/(?:^|[\s"'`([<{=:])(?:[A-Za-z]:[/\\]|[A-Za-z]:[a-zA-Z0-9._~-]+[/\\]|~[/\\]|(?:\.{1,2}[/\\]+)|[/\\](?:[a-zA-Z0-9._~-]+[/\\])*|[a-zA-Z][a-zA-Z0-9._~-]*[/\\])[^\s"'`<>:=)]+/g, (match) => {
      const leadingChar = match.match(/^[\s"'`([<{=:]/)?.[0] || "";
      const pathPart = match.slice(leadingChar.length);
      const trailingPunct = pathPart.match(/[).,;:!?]+$/)?.[0] || "";
      return `${leadingChar}[path]${trailingPunct}`;
    })
    // 6. Remaining one-token relative paths, including Unicode and dot/scope prefixes
    .replace(/(?:^|[\s"'`([<{=:])(?=[^\s"'`<>:=)]*\p{L})(?:[^\s"'`<>:=)]+[/\\])+[^\s"'`<>:=)]+/gu, (match) => {
      const leadingChar = match.match(/^[\s"'`([<{=:]/)?.[0] || "";
      const pathPart = match.slice(leadingChar.length);
      const trailingPunct = pathPart.match(/[).,;:!?]+$/)?.[0] || "";
      return `${leadingChar}[path]${trailingPunct}`;
    })
    // 7. Relative paths with a filename, such as logs/error.txt
    .replace(/\b(?:[A-Za-z]:)?(?:[a-zA-Z0-9_.-]+[/\\])+[a-zA-Z0-9_.-]+\.[a-zA-Z0-9_-]+\b/g, "[path]")
    // 8. Relative multi-segment paths like foo/bar/baz
    .replace(/\b(?:[a-zA-Z0-9_.-]+[/\\]){2,}[a-zA-Z0-9_.-]+/g, "[path]")
    // 9. Deduplicate and trim
    .replace(/(?:\[path\](?:\s+\[path\])*)/g, "[path]")
    .replace(/\s+/g, " ")
    .trim();

  // 3. Restore preserved URLs
  return redacted.replace(/__URL_PLACEHOLDER_(\d+)__/g, (_, index) => urls[Number(index)] || "");
}

function concise(value, maxLength = 800) {
  const normalized = sanitizeCliErrorText(String(value || "unknown error"));
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
}

function abortedError() {
  return new AppError("socai CLI was cancelled because the client disconnected.", {
    code: "SOCAI_ABORTED",
    status: 499,
  });
}
