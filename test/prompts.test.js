import test from "node:test";
import assert from "node:assert/strict";
import {
  SUPPORTED_PLATFORMS,
  RESEARCH_PROMPT_EXAMPLES,
  getPromptForPlatform,
  applyPromptSelection,
  bindPromptButtons,
} from "../public/prompts.js";

test("RESEARCH_PROMPT_EXAMPLES provides exactly one concise example for each supported platform", () => {
  assert.equal(SUPPORTED_PLATFORMS.length, 3);
  assert.deepEqual([...SUPPORTED_PLATFORMS].sort(), ["instagram", "linkedin", "tiktok"]);
  assert.equal(RESEARCH_PROMPT_EXAMPLES.length, 3);

  for (const platform of SUPPORTED_PLATFORMS) {
    const matching = RESEARCH_PROMPT_EXAMPLES.filter((p) => p.platform === platform);
    assert.equal(matching.length, 1, `Expected exactly 1 prompt for platform: ${platform}`);
    const prompt = matching[0];
    assert.ok(prompt.query && prompt.query.trim().length > 0, `Query missing for ${platform}`);
    assert.ok(prompt.title && prompt.title.trim().length > 0, `Title missing for ${platform}`);
    assert.ok(prompt.platformLabel && prompt.platformLabel.trim().length > 0, `Platform label missing for ${platform}`);
  }
});

test("getPromptForPlatform finds prompt case-insensitively and returns null for unknown platforms", () => {
  assert.equal(getPromptForPlatform("instagram")?.platform, "instagram");
  assert.equal(getPromptForPlatform("INSTAGRAM")?.platform, "instagram");
  assert.equal(getPromptForPlatform("TikTok")?.platform, "tiktok");
  assert.equal(getPromptForPlatform("LINKEDIN")?.platform, "linkedin");
  assert.equal(getPromptForPlatform("youtube"), null);
  assert.equal(getPromptForPlatform(""), null);
  assert.equal(getPromptForPlatform(null), null);
});

test("applyPromptSelection populates query and platform, and focuses the query field", () => {
  let focused = false;
  let inputDispatched = false;
  let changeDispatched = false;

  const mockQuery = {
    value: "",
    focus() {
      focused = true;
    },
    dispatchEvent(event) {
      if (event?.type === "input") inputDispatched = true;
    },
  };

  const mockPlatform = {
    value: "auto",
    dispatchEvent(event) {
      if (event?.type === "change") changeDispatched = true;
    },
  };

  const prompt = RESEARCH_PROMPT_EXAMPLES[0];
  const result = applyPromptSelection(prompt, {
    queryElement: mockQuery,
    platformElement: mockPlatform,
  });

  assert.equal(result, true);
  assert.equal(mockQuery.value, prompt.query);
  assert.equal(mockPlatform.value, prompt.platform);
  assert.equal(focused, true);
  assert.equal(inputDispatched, true);
  assert.equal(changeDispatched, true);
});

test("applyPromptSelection handles missing or minimal parameters gracefully", () => {
  assert.equal(applyPromptSelection(null), false);
  assert.equal(applyPromptSelection(undefined), false);

  const mockQuery = { value: "" };
  assert.equal(applyPromptSelection("Plain query text", { queryElement: mockQuery }), true);
  assert.equal(mockQuery.value, "Plain query text");
});

test("bindPromptButtons registers click listeners, prevents default submit, and supports cleanup", () => {
  let clickListener = null;
  const mockButton = {
    dataset: {
      platform: "tiktok",
      query: "Find emerging AI creators and inspect their most engaging videos",
    },
    addEventListener(type, listener) {
      if (type === "click") clickListener = listener;
    },
    removeEventListener(type, listener) {
      if (type === "click" && clickListener === listener) {
        clickListener = null;
      }
    },
  };

  let focused = false;
  const mockQuery = {
    value: "",
    focus() {
      focused = true;
    },
  };
  const mockPlatform = { value: "auto" };
  let selectedPrompt = null;

  const cleanup = bindPromptButtons({
    buttons: [mockButton],
    queryElement: mockQuery,
    platformElement: mockPlatform,
    onSelect(prompt) {
      selectedPrompt = prompt;
    },
  });

  assert.ok(typeof clickListener === "function");

  let defaultPrevented = false;
  clickListener({
    preventDefault() {
      defaultPrevented = true;
    },
  });

  assert.equal(defaultPrevented, true);
  assert.equal(mockQuery.value, "Find emerging AI creators and inspect their most engaging videos");
  assert.equal(mockPlatform.value, "tiktok");
  assert.equal(focused, true);
  assert.equal(selectedPrompt?.platform, "tiktok");

  cleanup();
  assert.equal(clickListener, null);
});

test("updatePromptButtons visibly disables unsupported platforms with accessible explanations", async () => {
  const { updatePromptButtons } = await import("../public/prompts.js");
  const attributes = new Map();
  const mockButton = {
    dataset: { platform: "linkedin", query: "find PMs" },
    disabled: false,
    setAttribute(name, value) {
      attributes.set(name, value);
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
    getAttribute(name) {
      return attributes.get(name);
    },
  };

  updatePromptButtons([mockButton], { instagram: true, tiktok: true, linkedin: false });
  assert.equal(mockButton.disabled, true);
  assert.equal(mockButton.title, "LinkedIn search isn't available in this socai build");
  assert.equal(attributes.get("aria-description"), "LinkedIn search isn't available in this socai build");
  assert.equal(attributes.get("aria-disabled"), "true");

  let clicked = false;
  const mockQuery = { value: "" };
  const mockPlatform = { value: "auto" };
  let listener = null;
  mockButton.addEventListener = (_type, cb) => {
    listener = cb;
  };
  mockButton.removeEventListener = () => {
    listener = null;
  };

  bindPromptButtons({
    buttons: [mockButton],
    queryElement: mockQuery,
    platformElement: mockPlatform,
    onSelect() {
      clicked = true;
    },
  });

  listener({ preventDefault() {} });
  assert.equal(clicked, false, "Disabled button click must not trigger onSelect");
  assert.equal(mockQuery.value, "", "Disabled button must not set query value");

  updatePromptButtons([mockButton], { instagram: true, tiktok: true, linkedin: true });
  assert.equal(mockButton.disabled, false);
  assert.equal(mockButton.title, "");
  assert.equal(attributes.has("aria-description"), false);
  assert.equal(attributes.has("aria-disabled"), false);
});
