import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { revealWithInitialFocus } from "../public/view-focus.js";

const indexHtml = await readFile(
  new URL("../public/index.html", import.meta.url),
  "utf8",
);
const stylesCss = await readFile(
  new URL("../public/styles.css", import.meta.url),
  "utf8",
);

function hiddenView() {
  const classes = new Set(["hidden"]);
  return {
    classList: {
      contains: (name) => classes.has(name),
      remove: (name) => classes.delete(name),
      add: (name) => classes.add(name),
    },
  };
}

test("the result heading can receive programmatic focus without entering the tab order", () => {
  const heading = indexHtml.match(/<h2\b[^>]*\bid="result-title"[^>]*>/i)?.[0];
  assert.ok(heading, "expected the result heading");
  assert.match(heading, /\btabindex="-1"/i);
});

test("the programmatically focused result heading has a visible focus treatment", () => {
  const rule = stylesCss.match(/#result-title:focus\s*\{([^}]*)\}/i)?.[1] ?? "";
  assert.match(rule, /\boutline\s*:\s*[2-9]px\s+solid\s+var\(--ink\)/i);
  assert.match(rule, /\bbox-shadow\s*:[^;]*var\(--pink\)/i);
});

test("entering results focuses once while streamed updates leave focus in place", () => {
  const view = hiddenView();
  let focusCount = 0;
  const target = { focus: () => { focusCount += 1; } };

  assert.equal(revealWithInitialFocus(view, target), true);
  assert.equal(focusCount, 1);

  assert.equal(revealWithInitialFocus(view, target), false);
  assert.equal(focusCount, 1);
});

test("returning to search allows the next results entry to receive focus", () => {
  const view = hiddenView();
  let focusCount = 0;
  const target = { focus: () => { focusCount += 1; } };

  revealWithInitialFocus(view, target);
  view.classList.add("hidden");
  revealWithInitialFocus(view, target);

  assert.equal(focusCount, 2);
});
