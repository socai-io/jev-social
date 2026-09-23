const PLATFORMS = ["instagram", "tiktok", "linkedin"];

export function deriveStatusView(status = {}) {
  const capabilities = status.socai?.capabilities || {};
  const configError = typeof status.configError === "string" ? status.configError.trim() : "";
  if (configError) {
    return {
      error: configError,
      capabilities,
      jev: { ready: false, label: "Configuration unavailable" },
      socai: { ready: false, label: "Configuration unavailable" },
    };
  }

  const installed = Boolean(status.socai?.installed);
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
    error: "",
    capabilities,
    jev: {
      ready: Boolean(status.jevConfigured),
      label: status.jevConfigured ? "Jev ready" : "Jev needs a key",
    },
    socai: { ready: allReady, label: socaiLabel },
  };
}
