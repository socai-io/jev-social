import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const indexHtml = await readFile(
  new URL("../public/index.html", import.meta.url),
  "utf8",
);
const stylesCss = await readFile(
  new URL("../public/styles.css", import.meta.url),
  "utf8",
);

test("the local UI starts with a skip link to the focusable main region", () => {
  const firstControl = indexHtml.match(/<(?:a|button|input|select|textarea)\b[^>]*>/i)?.[0];
  assert.ok(firstControl, "expected a focusable control in the local UI");
  assert.match(firstControl, /\bclass="skip-link"/i);

  const skipLink = indexHtml.match(
    /<a\b(?=[^>]*\bclass="skip-link")[^>]*>([\s\S]*?)<\/a>/i,
  );
  assert.ok(skipLink, "expected the local UI skip link");
  assert.match(skipLink[0], /\bhref="#main-content"/i);
  assert.equal(skipLink[1].trim(), "Skip to main content");

  const main = indexHtml.match(/<main\b(?=[^>]*\bid="main-content")[^>]*>/i)?.[0];
  assert.ok(main, "expected a main region with the skip-link target ID");
  assert.match(main, /\btabindex="-1"/i);
});

test("the skip link is offscreen until focused and appears above the top bar", () => {
  const linkStyle = stylesCss.match(/\.skip-link\s*\{([^}]*)\}/i)?.[1] ?? "";
  const focusStyle = stylesCss.match(/\.skip-link:focus-visible\s*\{([^}]*)\}/i)?.[1] ?? "";
  assert.match(linkStyle, /\bposition\s*:\s*absolute\b/i);
  assert.match(linkStyle, /\btransform\s*:\s*translateY\(calc\(-100%/i);
  assert.match(linkStyle, /\bbackground\s*:\s*var\(--pink\)/i);
  assert.match(linkStyle, /\bcolor\s*:\s*var\(--ink\)/i);
  assert.ok(Number(linkStyle.match(/\bz-index\s*:\s*(\d+)/i)?.[1]) > 20);
  assert.match(focusStyle, /\btransform\s*:\s*translateY\(0\)/i);
});
