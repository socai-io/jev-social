import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { stripMarkup } from "../test-support/text.js";

const indexHtml = await readFile(
  new URL("../public/index.html", import.meta.url),
  "utf8",
);

function attr(tagHtml, name) {
  const match = tagHtml.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return match ? match[1] : null;
}

function elementById(html, id) {
  const match = html.match(
    new RegExp(`<([a-z0-9]+)\\b[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)</\\1>`, "i"),
  );
  return match ? match[2] : null;
}

test("the evidence table has a non-empty accessible name built from the existing heading", () => {
  const sectionMatch = indexHtml.match(
    /<section\b[^>]*\bid="evidence-table"[^>]*>([\s\S]*?)<\/section>/i,
  );
  assert.ok(sectionMatch, 'expected a <section id="evidence-table"> element');
  const section = sectionMatch[1];

  const tableMatch = section.match(/<table\b[^>]*>/i);
  assert.ok(tableMatch, "expected a <table> inside the evidence-table section");
  const tableTag = tableMatch[0];

  const labelledBy = attr(tableTag, "aria-labelledby");
  assert.ok(
    labelledBy,
    "the evidence table must have an aria-labelledby attribute referencing its heading",
  );

  const ids = labelledBy.trim().split(/\s+/);
  assert.ok(ids.length >= 1, "aria-labelledby must reference at least one id");

  const resolvedName = ids
    .map((id) => {
      const content = elementById(indexHtml, id);
      assert.ok(content !== null, `expected an element with id="${id}" referenced by aria-labelledby`);
      return stripMarkup(content).trim();
    })
    .join(" ")
    .trim();

  assert.notEqual(resolvedName, "", "the resolved accessible name must be non-empty");
  assert.match(resolvedName, /COMPLETE TABLE/i, "the accessible name should include the visible heading text");
});

test("the evidence table accessible-name fix does not change visible copy or dynamic hooks", () => {
  assert.match(
    indexHtml,
    /<p class="eyebrow"[^>]*>COMPLETE TABLE<\/p>/i,
    "the visible COMPLETE TABLE text must be unchanged",
  );
  assert.match(
    indexHtml,
    />All returned records<\/span>/i,
    "the visible 'All returned records' text must be unchanged",
  );
  assert.match(
    indexHtml,
    /<thead\b[^>]*\bid="table-head"[^>]*><\/thead>/i,
    "#table-head must remain intact for dynamic rendering",
  );
  assert.match(
    indexHtml,
    /<tbody\b[^>]*\bid="table-body"[^>]*><\/tbody>/i,
    "#table-body must remain intact for dynamic rendering",
  );
});

test("the evidence table scroll region is named, keyboard-focusable, and visibly outlined", async () => {
  const section = indexHtml.match(
    /<section\b[^>]*\bid="evidence-table"[^>]*>([\s\S]*?)<\/section>/i,
  )?.[1];
  assert.ok(section, "expected the evidence-table section");
  const container = section.match(
    /<div\b[^>]*\bclass="[^"]*\btable-scroll\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
  );
  assert.ok(container, "expected the table-scroll container");
  const openingTag = container[0].match(/^<div\b[^>]*>/i)[0];
  assert.equal(attr(openingTag, "tabindex"), "0");
  assert.equal(attr(openingTag, "role"), "region");
  assert.equal(
    attr(openingTag, "aria-labelledby"),
    "evidence-table-heading evidence-table-desc",
  );
  for (const id of ["evidence-table-heading", "evidence-table-desc"]) {
    const content = elementById(section, id);
    assert.ok(content !== null, `missing region label: ${id}`);
    assert.notEqual(stripMarkup(content).trim(), "", `empty region label: ${id}`);
  }
  const tableTag = container[1].match(/<table\b[^>]*>/i)?.[0];
  assert.ok(tableTag, "the region must contain the evidence table");
  assert.equal(
    attr(tableTag, "aria-labelledby"),
    "evidence-table-heading evidence-table-desc",
  );
  assert.match(container[1], /<thead\b[^>]*\bid="table-head"[^>]*>/i);
  assert.match(container[1], /<tbody\b[^>]*\bid="table-body"[^>]*>/i);

  const css = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  const focusRule = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(
    ([, selectors]) => selectors.split(",").some(
      (selector) => selector.trim() === ".table-scroll:focus-visible",
    ),
  );
  assert.ok(focusRule, "missing keyboard-focus rule for the scroll region");
  assert.match(focusRule[2], /(?:^|;)\s*outline:\s*[2-9]px solid var\(--ink\)\s*(?:;|$)/);
  assert.match(focusRule[2], /(?:^|;)\s*outline-offset:\s*2px\s*(?:;|$)/);
});
