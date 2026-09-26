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

function labelFor(html, targetId) {
  const match = html.match(
    new RegExp(`<label\\b[^>]*\\bfor="${targetId}"[^>]*>([\\s\\S]*?)</label>`, "i"),
  );
  return match ? match[1] : null;
}

test("textarea#query keeps its placeholder and required behavior", () => {
  const match = indexHtml.match(/<textarea\b[^>]*\bid="query"[^>]*>/i);
  assert.ok(match, "expected a textarea with id=\"query\"");
  assert.match(match[0], /\brequired\b/i, "textarea#query must stay required");
  assert.match(
    match[0],
    /placeholder="Find emerging AI creators and their most engaging posts"/,
    "textarea#query must keep its example placeholder",
  );
});

test("textarea#query has an explicit associated label with non-empty text", () => {
  const labelText = labelFor(indexHtml, "query");
  assert.ok(labelText !== null, 'expected a <label for="query"> element');
  assert.notEqual(
    labelText.replace(/<[^>]*>/g, "").trim(),
    "",
    "the label for textarea#query must contain non-empty text",
  );
});

test("the query label does not change the visible layout", () => {
  const match = indexHtml.match(/<label\b[^>]*\bfor="query"[^>]*>/i);
  assert.ok(match, 'expected a <label for="query"> element');
  assert.match(
    match[0],
    /\bclass="[^"]*\bvisually-hidden\b[^"]*"/i,
    "the query label must use the visually-hidden helper so the layout is unchanged",
  );
  assert.match(
    stylesCss,
    /\.visually-hidden\s*\{/i,
    "expected a .visually-hidden rule in public/styles.css",
  );
});
