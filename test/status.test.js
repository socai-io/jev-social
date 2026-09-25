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
  assert.deepEqual(view.browser, { ready: false, label: "Configuration unavailable", hint: "" });
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
  assert.deepEqual(view.browser, {
    ready: false,
    label: "Chrome state unknown",
    hint: "Update socai to enable read-only browser diagnostics.",
  });
});

test("connected browser readiness names the active profile without exposing connection details", () => {
  const view = deriveStatusView({
    jevConfigured: true,
    socai: {
      installed: true,
      version: "0.7.0",
      capabilities: { instagram: true, tiktok: true, linkedin: true },
      readiness: {
        browserConnected: true,
        browserState: "connected",
        profileMode: "managed",
        activeProfileMode: "existing",
        errorCode: null,
      },
    },
  });

  assert.deepEqual(view.browser, { ready: true, label: "Chrome connected · existing", hint: "" });
  assert.deepEqual(view.platforms.instagram, { available: true, loginState: "unknown" });
});

test("platform login state remains separate from CLI capability and browser connection", () => {
  const view = deriveStatusView({
    jevConfigured: true,
    socai: {
      installed: true,
      capabilities: { instagram: true, tiktok: true, linkedin: false },
      readiness: {
        browserConnected: true,
        browserState: "connected",
        profileMode: "existing",
        activeProfileMode: "existing",
        errorCode: null,
        platforms: {
          instagram: { available: true, loginState: "authenticated", operations: ["search"] },
          tiktok: { available: true, loginState: "unauthenticated", operations: ["search"] },
        },
      },
    },
  });

  assert.deepEqual(view.platforms, {
    instagram: { available: true, loginState: "authenticated" },
    tiktok: { available: true, loginState: "unauthenticated" },
    linkedin: { available: false, loginState: "unknown" },
  });
});

for (const [errorCode, expected] of [
  ["BROWSER_PERMISSION_REQUIRED", ["Chrome permission needed", "Allow Chrome data access and remote debugging, then try again."]],
  ["BROWSER_ENDPOINT_UNREACHABLE", ["Chrome unavailable", "Start Chrome or choose the managed browser profile, then try again."]],
  ["REMOTE_SESSION_UNAVAILABLE", ["Remote browser unavailable", "Check the remote browser service, then try again."]],
]) {
  test(`browser readiness maps ${errorCode} to safe local guidance`, () => {
    const view = deriveStatusView({
      jevConfigured: true,
      socai: {
        installed: true,
        capabilities: { instagram: true, tiktok: true, linkedin: true },
        readiness: {
          browserConnected: false,
          browserState: "disconnected",
          profileMode: errorCode === "REMOTE_SESSION_UNAVAILABLE" ? "remote" : "existing",
          activeProfileMode: null,
          errorCode,
        },
      },
    });

    assert.deepEqual(view.browser, { ready: false, label: expected[0], hint: expected[1] });
    assert.equal(view.error, "", "browser diagnostics must not trigger the global error toast");
  });
}
