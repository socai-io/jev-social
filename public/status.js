const PLATFORMS = ["instagram", "tiktok", "linkedin"];

export function deriveStatusView(status = {}) {
  const capabilities = status.socai?.capabilities || {};
  const configError = typeof status.configError === "string" ? status.configError.trim() : "";
  if (configError) {
    return {
      error: configError,
      capabilities,
      platforms: platformStatuses(capabilities),
      jev: { ready: false, label: "Configuration unavailable" },
      socai: { ready: false, label: "Configuration unavailable" },
      browser: { ready: false, label: "Configuration unavailable", hint: "" },
    };
  }

  const installed = Boolean(status.socai?.installed);
  const providerError = typeof status.decisionProviderError === "string"
    ? status.decisionProviderError.trim()
    : "";
  const available = PLATFORMS.filter((platform) => capabilities[platform]);
  const allReady = installed && available.length === PLATFORMS.length;
  let socaiLabel = "socai unavailable";
  if (installed) {
    const version = status.socai?.version ? ` v${status.socai.version}` : "";
    if (allReady) socaiLabel = `socai${version} ready`;
    else if (available.length) socaiLabel = `socai${version} (${available.length}/${PLATFORMS.length} ready)`;
    else socaiLabel = `socai${version} (no platforms)`;
  }

  return {
    error: providerError,
    capabilities,
    platforms: platformStatuses(capabilities, status.socai?.readiness?.platforms),
    jev: {
      ready: Boolean(status.jevConfigured),
      label: providerError
        ? "Decision provider unavailable"
        : status.jevConfigured
        ? status.decisionProvider === "local" ? "Local decision model ready" : "Jev ready"
        : "Jev needs a key",
    },
    socai: { ready: allReady, label: socaiLabel },
    browser: browserStatus(status.socai?.readiness, installed),
  };
}

function platformStatuses(capabilities, readinessPlatforms = {}) {
  return Object.fromEntries(PLATFORMS.map((platform) => {
    const loginState = readinessPlatforms[platform]?.loginState;
    return [platform, {
      available: Boolean(capabilities[platform]),
      loginState: ["authenticated", "unauthenticated"].includes(loginState) ? loginState : "unknown",
    }];
  }));
}

function browserStatus(readiness, installed) {
  if (!installed) return { ready: false, label: "Chrome unavailable", hint: "Install socai to enable browser research." };
  if (!readiness || readiness.browserConnected === null) {
    return {
      ready: false,
      label: "Chrome state unknown",
      hint: "Update socai to enable read-only browser diagnostics.",
    };
  }
  if (readiness.browserConnected && readiness.browserState === "connected") {
    const profile = readiness.activeProfileMode || readiness.profileMode;
    const suffix = profile && profile !== "unknown" ? ` · ${profile}` : "";
    return { ready: true, label: `Chrome connected${suffix}`, hint: "" };
  }
  if (readiness.browserState === "connecting") {
    return { ready: false, label: "Chrome connecting", hint: "socai is establishing read-only browser access." };
  }

  const safeGuidance = {
    BROWSER_NOT_CONNECTED: ["Chrome on demand", "A read-only research run will connect Chrome when needed."],
    DAEMON_UNAVAILABLE: ["Chrome on demand", "A read-only research run will start socai when needed."],
    BROWSER_DISCONNECTED: ["Chrome disconnected", "Reconnect from socai before starting research."],
    BROWSER_PERMISSION_REQUIRED: ["Chrome permission needed", "Allow Chrome data access and remote debugging, then try again."],
    BROWSER_ENDPOINT_UNREACHABLE: ["Chrome unavailable", "Start Chrome or choose the managed browser profile, then try again."],
    REMOTE_SESSION_UNAVAILABLE: ["Remote browser unavailable", "Check the remote browser service, then try again."],
    DAEMON_STATUS_UNAVAILABLE: ["Chrome state unknown", "Update or restart socai once to enable browser diagnostics."],
    BROWSER_CONNECTION_FAILED: ["Chrome connection failed", "Check the socai browser setup, then try again."],
  };
  const [label, hint] = safeGuidance[readiness.errorCode] || [
    "Chrome state unknown",
    "Browser access will be checked when research starts.",
  ];
  return { ready: false, label, hint };
}
