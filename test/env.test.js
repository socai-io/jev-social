import assert from "node:assert/strict";
import test from "node:test";
import { mergeLocalEnv, parseEnv } from "../src/env.js";

test("parseEnv reads the lowercase OpenRouter key format without evaluating shell code", () => {
  assert.deepEqual(parseEnv("# local\nopenrouter='secret-value'\nINVALID LINE\n"), {
    openrouter: "secret-value",
  });
});

test("project .env values honor the report privacy opt-out", () => {
  const env = {};
  mergeLocalEnv(env, {
    OPENROUTER_REPORT_MODEL: "off",
    UNRELATED_SECRET: "must-not-load",
  });

  assert.equal(env.OPENROUTER_REPORT_MODEL, "off");
  assert.equal(env.UNRELATED_SECRET, undefined);
});
