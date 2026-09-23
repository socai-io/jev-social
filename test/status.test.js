import assert from "node:assert/strict";
import test from "node:test";
import { deriveStatusView } from "../public/status.js";

test("malformed configuration is surfaced without replacing it with misleading readiness labels", () => {
  const view = deriveStatusView({
    jevConfigured: false,
    configError: "Configuration could not be read.",
    socai: {
      installed: false,
      capabilities: { instagram: false, tiktok: false, linkedin: false },
    },
  });

  assert.equal(view.error, "Configuration could not be read.");
  assert.deepEqual(view.jev, { ready: false, label: "Configuration unavailable" });
  assert.deepEqual(view.socai, { ready: false, label: "Configuration unavailable" });
  assert.doesNotMatch(JSON.stringify(view), /Jev needs a key|socai unavailable/);
});

test("healthy status retains versioned per-platform readiness", () => {
  const view = deriveStatusView({
    jevConfigured: true,
    socai: {
      installed: true,
      version: "0.6.0",
      capabilities: { instagram: true, tiktok: true, linkedin: false },
    },
  });

  assert.equal(view.error, "");
  assert.deepEqual(view.jev, { ready: true, label: "Jev ready" });
  assert.deepEqual(view.socai, { ready: false, label: "socai v0.6.0 (2/3 ready)" });
});
