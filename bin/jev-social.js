#!/usr/bin/env node

import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { runSearch } from "../src/app.js";
import { getConfigPath, readConfig, resolveApiKey } from "../src/config.js";
import { resolveDecisionProvider } from "../src/decision-provider.js";
import { loadLocalEnv } from "../src/env.js";
import { saveOnboarding } from "../src/onboard.js";
import { probeSocai } from "../src/socai.js";
import { startServer } from "../src/server.js";

const HELP = `jev-social — Jev-directed social research through socai CLI

Usage:
  jev-social                                      Start local preview
  jev-social onboard [options]                    Optional manual configuration
  jev-social status                               Show local readiness
  jev-social search <query> [options]             Run one search
  jev-social serve [--port 8766] [--no-open]      Start local preview

Search options:
  --platform <auto|instagram|tiktok|linkedin>  Platform hint (default: auto)
  --limit <1-100>                      Result limit (default: 10)
  --max-steps <1-30>                   Decision budget (default: 12)

Configuration (normally auto-loaded from .env):
  --api-key <key>                      OpenRouter API key (prompt is safer)
  --socai-bin <path>                   socai executable override
  --install                            Install/reinstall official socai CLI
  --skip-install                       Do not offer CLI installation
  --no-verify                          Save API key without a network check

Local decision provider (environment only):
  JEV_SOCIAL_SYSTEM_ONE_URL            Loopback /v1/systemone endpoint
  JEV_SOCIAL_SYSTEM_ONE_MODEL          Model name (default: kev-latest)
  JEV_SOCIAL_SYSTEM_ONE_TIMEOUT_MS     Timeout in ms (default/max: 120000)
`;

try {
  await loadLocalEnv();
  const [command = "serve", ...rest] = process.argv.slice(2);
  if (["help", "--help", "-h"].includes(command)) {
    console.log(HELP);
  } else if (command === "serve") {
    const flags = parseArgs(rest);
    await startServer({ port: flags.port || 8766, open: !flags.noOpen });
  } else if (command === "status") {
    const config = await readConfig();
    const provider = resolveDecisionProvider();
    console.log(
      JSON.stringify(
        {
          jevConfigured: provider.kind === "local" || Boolean(resolveApiKey(config)),
          jevModel: provider.model,
          decisionProvider: provider.kind,
          configPath: getConfigPath(),
          socai: await probeSocai(config, process.env, undefined, { includeReadiness: true }),
        },
        null,
        2,
      ),
    );
  } else if (command === "onboard") {
    await onboard(parseArgs(rest));
  } else if (command === "search") {
    const flags = parseArgs(rest);
    const query = flags._.join(" ").trim();
    const run = await runSearch(
      { query, platform: flags.platform || "auto", limit: Number(flags.limit ?? 10), maxSteps: Number(flags.maxSteps ?? 12) },
      {
        onEvent(event) {
          if (event.message) console.error(`[${event.stage}] ${event.message}`);
        },
      },
    );
    console.log(JSON.stringify(run, null, 2));
  } else {
    throw new Error(`Unknown command: ${command}\n\n${HELP}`);
  }
} catch (error) {
  console.error(`jev-social: ${error.message}`);
  if (error.details) console.error(JSON.stringify(error.details, null, 2));
  process.exitCode = 1;
}

async function onboard(flags) {
  const current = await readConfig();
  const provider = resolveDecisionProvider();
  let apiKey;
  let persistApiKey = false;
  if (flags.apiKey) {
    apiKey = flags.apiKey;
    persistApiKey = true;
  } else if (resolveApiKey(current)) {
    apiKey = resolveApiKey(current);
  }
  if (!apiKey && provider.kind === "openrouter") {
    apiKey = await promptSecret("OpenRouter API key: ");
    persistApiKey = true;
  }

  const proposed = { ...current, ...(flags.socaiBin ? { socaiBin: flags.socaiBin } : {}) };
  const before = await probeSocai(proposed);
  let installCli = Boolean(flags.install);
  if (!before.installed && !flags.skipInstall && !flags.install) {
    installCli = await promptYesNo("socai CLI was not found. Install the official release now?", true);
  }

  console.log("Checking setup…");
  const result = await saveOnboarding({
    apiKey,
    socaiBin: flags.socaiBin,
    installCli,
    verify: !flags.noVerify,
    persistApiKey,
    onMessage: (message) => console.log(message),
  });
  console.log(`Saved ${result.configPath}`);
  console.log(
    result.decisionProvider.kind === "local"
      ? `Decision provider: local (${result.decisionProvider.model})`
      : `Jev API: ${flags.noVerify ? "saved (not verified)" : "verified"}`,
  );
  console.log(`socai CLI: ${result.socai.installed ? result.socai.bin : "not ready"}`);
  if (result.socai.capabilities) {
    console.log(`Capabilities: ${JSON.stringify(result.socai.capabilities)}`);
  }
}

function parseArgs(args) {
  const result = { _: [] };
  const booleanFlags = new Map([
    ["--no-open", "noOpen"],
    ["--skip-install", "skipInstall"],
    ["--install", "install"],
    ["--no-verify", "noVerify"],
  ]);
  const valueFlags = new Map([
    ["--platform", "platform"],
    ["--limit", "limit"],
    ["--max-steps", "maxSteps"],
    ["--port", "port"],
    ["--api-key", "apiKey"],
    ["--socai-bin", "socaiBin"],
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (booleanFlags.has(token)) {
      result[booleanFlags.get(token)] = true;
    } else if (valueFlags.has(token)) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${token} requires a value.`);
      result[valueFlags.get(token)] = value;
      index += 1;
    } else if (token.startsWith("--")) {
      throw new Error(`Unknown option: ${token}`);
    } else {
      result._.push(token);
    }
  }
  return result;
}

async function promptYesNo(question, defaultYes) {
  if (!stdin.isTTY) return defaultYes;
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
    if (!answer) return defaultYes;
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

function promptSecret(label) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    throw new Error("Set OPENROUTER_API_KEY when onboarding without an interactive terminal.");
  }
  return new Promise((resolve, reject) => {
    let value = "";
    stdout.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (character) => {
      if (character === "\u0003") {
        cleanup();
        stdout.write("\n");
        reject(new Error("Onboarding cancelled."));
      } else if (character === "\r" || character === "\n") {
        cleanup();
        stdout.write("\n");
        resolve(value);
      } else if (character === "\u007f" || character === "\b") {
        if (value) {
          value = value.slice(0, -1);
          stdout.write("\b \b");
        }
      } else if (character >= " ") {
        value += character;
        stdout.write("•");
      }
    };
    stdin.on("data", onData);
  });
}
