import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AppError } from "./errors.js";
import { readConfig, resolveApiKey, writeConfig } from "./config.js";
import { resolveDecisionProvider } from "./decision-provider.js";
import { runProcess } from "./process.js";
import { probeSocai } from "./socai.js";

const INSTALLERS = {
  darwin: "https://github.com/socai-io/socai/releases/latest/download/install.sh",
  win32: "https://github.com/socai-io/socai/releases/latest/download/install.ps1",
};

export async function verifyOpenRouterApiKey(apiKey) {
  if (!apiKey?.trim()) {
    throw new AppError("An OpenRouter API key is required for Jev routing.", {
      code: "OPENROUTER_KEY_REQUIRED",
    });
  }
  try {
    const response = await fetch("https://openrouter.ai/api/v1/auth/key", {
      headers: { Authorization: `Bearer ${apiKey.trim()}` },
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error?.message || `HTTP ${response.status}`);
    return payload.data || {};
  } catch (error) {
    throw new AppError(`OpenRouter API key validation failed: ${error.message}`, {
      code: "OPENROUTER_KEY_INVALID",
      status: 502,
    });
  }
}

export async function installSocaiCli({ onMessage } = {}) {
  const installerUrl = INSTALLERS[process.platform];
  if (!installerUrl) {
    throw new AppError(
      "The official prebuilt socai installer supports macOS and Windows. Install from source, then set SOCAI_BIN.",
      { code: "SOCAI_INSTALL_UNSUPPORTED" },
    );
  }

  onMessage?.(`Downloading official installer: ${installerUrl}`);
  const response = await fetch(installerUrl, { redirect: "follow" });
  if (!response.ok) {
    throw new AppError(`Could not download socai installer (HTTP ${response.status}).`, {
      code: "SOCAI_INSTALL_DOWNLOAD_FAILED",
      status: 502,
    });
  }

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "jev-social-install-"));
  const extension = process.platform === "win32" ? "ps1" : "sh";
  const installerPath = path.join(temporaryDirectory, `install.${extension}`);
  try {
    await writeFile(installerPath, await response.text(), { mode: 0o700 });
    const command = process.platform === "win32" ? "powershell.exe" : "sh";
    const args =
      process.platform === "win32"
        ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installerPath]
        : [installerPath];
    const result = await runProcess(command, args, { inherit: true, timeoutMs: 5 * 60_000 });
    if (result.code !== 0) {
      throw new AppError(`socai installer exited with code ${result.code}.`, {
        code: "SOCAI_INSTALL_FAILED",
      });
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function saveOnboarding({
  apiKey,
  socaiBin,
  installCli = false,
  verify = true,
  persistApiKey = Boolean(apiKey?.trim()),
  env = process.env,
  onMessage,
}) {
  const current = await readConfig(env);
  const provider = resolveDecisionProvider(env);
  const key = apiKey?.trim() || resolveApiKey(current, env);
  if (provider.kind === "openrouter" && !key) {
    throw new AppError("An OpenRouter API key is required for Jev routing.", {
      code: "OPENROUTER_KEY_REQUIRED",
    });
  }
  const keyInfo = provider.kind === "openrouter" && verify
    ? await verifyOpenRouterApiKey(key)
    : {};
  if (installCli) await installSocaiCli({ onMessage });

  const next = {
    ...current,
    ...(persistApiKey ? { openrouterApiKey: key } : {}),
    ...(socaiBin?.trim() ? { socaiBin: socaiBin.trim() } : {}),
    updatedAt: new Date().toISOString(),
  };
  const configPath = await writeConfig(next, env);
  const socai = await probeSocai(next, env);
  return {
    configPath,
    keyInfo,
    decisionProvider: { kind: provider.kind, model: provider.model },
    socai,
  };
}

export const verifyTypesafeApiKey = verifyOpenRouterApiKey;
