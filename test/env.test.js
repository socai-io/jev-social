import assert from "node:assert/strict";
import test from "node:test";
import { mergeLocalEnv, parseEnv } from "../src/env.js";

test("parseEnv reads the lowercase OpenRouter key format without evaluating shell code", () => {
  const fixtureValue = String(101);
  assert.deepEqual(parseEnv(`# local\nopenrouter='${fixtureValue}'\nINVALID LINE\n`), {
    openrouter: fixtureValue,
  });
});

test("project .env values honor the report privacy opt-out", () => {
  const env = {};
  mergeLocalEnv(env, {
    OPENROUTER_REPORT_MODEL: "off",
    UNRELATED_SECRET: String(102),
  });

  assert.equal(env.OPENROUTER_REPORT_MODEL, "off");
  assert.equal(env.UNRELATED_SECRET, undefined);
});
