import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectors, body]) => ({
  selectors: selectors.split(",").map((selector) => selector.trim()),
  body,
}));

function declaration(selector, property) {
  const rule = rules.find((entry) => entry.selectors.includes(`${selector}:focus-visible`));
  assert.ok(rule, `Missing keyboard-focus rule for ${selector}`);
  const value = rule.body.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`))?.[1]?.trim();
  assert.ok(value, `Missing ${property} for ${selector}`);
  return value;
}

test("primary controls retain a high-contrast keyboard-focus ring", () => {
  for (const selector of ["a", "button", ".composer textarea", ".field-group select"]) {
    assert.match(declaration(selector, "outline"), /^[2-9]px solid var\(--ink\)$/);
    assert.match(declaration(selector, "box-shadow"), /var\(--pink\)/);
  }
});

test("prompt and error buttons retain their explicit focus outlines", () => {
  assert.match(declaration(".prompt-example-btn", "outline"), /^[2-9]px solid var\(--ink\)$/);
  assert.match(declaration(".error-close", "outline"), /^[2-9]px solid var\(--pink\)$/);
});
