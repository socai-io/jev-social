import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE_ENV = path.resolve(PROJECT_ROOT, "../docs/work/20260918-2/.env");
const AUTO_ENV_KEYS = new Set([
  "OPENROUTER_API_KEY",
  "OPENROUTER_JEV_MODEL",
  "OPENROUTER_REPORT_MODEL",
  "JEV_SOCIAL_SYSTEM_ONE_URL",
  "JEV_SOCIAL_SYSTEM_ONE_MODEL",
  "JEV_SOCIAL_SYSTEM_ONE_TIMEOUT_MS",
  "openrouter",
]);

export async function loadLocalEnv(env = process.env) {
  const explicitEnvFile = env.JEV_SOCIAL_ENV_FILE?.trim();
  const candidates = [
    ...(explicitEnvFile ? [{ path: explicitEnvFile, trusted: true }] : []),
    { path: path.join(PROJECT_ROOT, ".env"), trusted: false },
    { path: WORKSPACE_ENV, trusted: false },
  ];
  let envFile = null;
  for (const candidate of candidates) {
    try {
      const values = parseEnv(await readFile(candidate.path, "utf8"));
      mergeLocalEnv(env, values, { trusted: candidate.trusted });
      envFile = candidate.path;
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  if (!env.OPENROUTER_API_KEY?.trim() && env.openrouter?.trim()) {
    env.OPENROUTER_API_KEY = env.openrouter.trim();
  }
  return { envFile };
}

export function mergeLocalEnv(env, values, { trusted = false } = {}) {
  for (const [key, value] of Object.entries(values)) {
    if (!trusted && !AUTO_ENV_KEYS.has(key)) continue;
    if (env[key] === undefined) env[key] = value;
  }
  return env;
}

export function parseEnv(source) {
  const values = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

export async function firstExecutable(candidates) {
  for (const candidate of candidates) {
    try {
      await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch {
      // Try the next local build location.
    }
  }
  return null;
}

export function localSocaiBuildCandidates() {
  const filename = process.platform === "win32" ? "socai.exe" : "socai";
  const targetRoot = path.resolve(
    PROJECT_ROOT,
    "../docs/work/20260918/worktrees/dev-platform-validation/target",
  );
  return [path.join(targetRoot, "debug", filename), path.join(targetRoot, "release", filename)];
}
