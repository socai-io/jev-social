import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

function productionFunction(name, nextName) {
  const start = appSource.indexOf(`function ${name}(`);
  const end = appSource.indexOf(`\nfunction ${nextName}(`, start);
  assert.notEqual(start, -1, `expected production function ${name}`);
  assert.notEqual(end, -1, `expected production function ${nextName} after ${name}`);
  return appSource.slice(start, end).trim();
}

function element(tagName, className, text = "") {
  return {
    tagName,
    className,
    text,
    id: "",
    children: [],
    append(...children) {
      this.children.push(...children);
    },
    replaceChildren(...children) {
      this.children = children;
    },
  };
}

function descendants(node) {
  return [node, ...(node.children || []).flatMap(descendants)];
}

test("the evidence detail dialog is labelled by its current visible title", () => {
  const dialogTag = html.match(/<dialog\b[^>]*id="detail-dialog"[^>]*>/u)?.[0] || "";
  assert.match(dialogTag, /aria-labelledby="detail-title"/u);
  assert.match(html, /id="close-detail"[^>]*aria-label="Close"/u);

  const detail = element("div", "");
  const dialog = { showModalCalls: 0, showModal() { this.showModalCalls += 1; } };
  const showDetail = vm.runInNewContext(
    `(() => { ${productionFunction("showDetail", "localVideoSource")} return showDetail; })()`,
    {
      elements: { detail, dialog },
      element,
      renderMediaPreview() {},
      firstString(item, keys) {
        return keys.map((key) => item[key]).find((value) => typeof value === "string" && value);
      },
      authorName: () => "",
      isHttpUrl: () => false,
      Array,
    },
  );

  showDetail({ description: "First description" }, "First result");
  let headings = descendants(detail).filter((node) => node.id === "detail-title");
  assert.equal(headings.length, 1);
  assert.equal(headings[0].tagName, "h3");
  assert.equal(headings[0].text, "First result");

  showDetail({ description: "Second description" }, "Second result");
  headings = descendants(detail).filter((node) => node.id === "detail-title");
  assert.equal(headings.length, 1, "replacing a record must not leave duplicate title IDs");
  assert.equal(headings[0].text, "Second result");
  assert.equal(dialog.showModalCalls, 2);
});
