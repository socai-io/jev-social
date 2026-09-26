import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readConfig } from "../src/config.js";
import { saveOnboarding } from "../src/onboard.js";

test("environment-only OpenRouter keys are not persisted during onboarding", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jev-social-onboard-"));
  const env = {
    ...process.env,
    JEV_SOCIAL_HOME: directory,
    OPENROUTER_API_KEY: String(101),
    SOCAI_BIN: path.join(directory, "missing-socai"),
  };
  try {
    await saveOnboarding({ verify: false, persistApiKey: false, env });
    const config = await readConfig(env);
    assert.equal(config.openrouterApiKey, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a loopback System One provider can onboard without an OpenRouter key", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jev-social-onboard-local-"));
  const env = {
    ...process.env,
    JEV_SOCIAL_HOME: directory,
    JEV_SOCIAL_SYSTEM_ONE_URL: "http://127.0.0.1:8009/v1/systemone",
    JEV_SOCIAL_SYSTEM_ONE_MODEL: "kev-latest",
    SOCAI_BIN: path.join(directory, "missing-socai"),
  };
  delete env.OPENROUTER_API_KEY;
  delete env.openrouter;
  try {
    const result = await saveOnboarding({ verify: true, persistApiKey: false, env });
    const config = await readConfig(env);
    assert.equal(config.openrouterApiKey, undefined);
    assert.deepEqual(result.decisionProvider, { kind: "local", model: "kev-latest" });
    assert.deepEqual(result.keyInfo, {});
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("saveOnboarding reports the resolved socai bin path for CLI output", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jev-social-onboard-bin-"));
  const mockBin = path.join(directory, "mock-socai.mjs");
  const env = {
    ...process.env,
    JEV_SOCIAL_HOME: directory,
    OPENROUTER_API_KEY: String(102),
    SOCAI_BIN: mockBin,
  };
  try {
    const result = await saveOnboarding({ verify: false, persistApiKey: true, socaiBin: mockBin, env });
    assert.equal(result.socai.bin, mockBin, "socai.bin must be present in saveOnboarding result for CLI callers");
    assert.notEqual(result.socai.bin, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
