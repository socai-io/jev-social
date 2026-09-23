# Troubleshooting

Jev Social directs your Chrome browser through the [socai](https://github.com/socai-io/socai) CLI to collect evidence visible to the active browser session. This guide explains how to identify and resolve common setup, connection, and platform access barriers while preserving the project's honest browser boundary.

> [!WARNING]
> **Data Retention & Privacy Notice**:
> - **Archived Runs & Artifacts**: Two distinct storage locations persist data that may survive cancellation or process termination:
>   1. **Jev Social Runs**: Running, interrupted, and finalized runs persist sanitized evidence cards, action status, timing, and the partial or final report to `${JEV_SOCIAL_HOME:-~/.jev-social}/runs/<id>.json`. Raw CLI stdout, cookies, DOM snapshots, and local filesystem paths are not stored in these checkpoints.
>   2. **`socai` Command Artifacts**: The underlying CLI writes tool inputs, outputs, downloaded media, and execution artifacts following the precedence: `SOCAI_RUNS_DIR` environment override $\rightarrow$ configured `runs.dir` (`socai config get runs.dir`) $\rightarrow$ default `~/.socai/runs/`.
> - **Locating & Inspecting Effective Stores**:
>   To inspect your active artifact storage locations without modifying files:
>   ```bash
>   # macOS / Linux (inspect paths)
>   echo "Jev Social runs: ${JEV_SOCIAL_HOME:-$HOME/.jev-social}/runs"
>   SOCAI_CONFIG_RUNS="$(/path/from-status config get runs.dir 2>/dev/null)"
>   echo "socai artifacts: ${SOCAI_RUNS_DIR:-${SOCAI_CONFIG_RUNS:-$HOME/.socai/runs}}"
>   ```
>   ```powershell
>   # Windows PowerShell (inspect paths)
>   $jevDir = if ($env:JEV_SOCIAL_HOME) { Join-Path $env:JEV_SOCIAL_HOME "runs" } else { "$HOME\.jev-social\runs" }
>   $configuredRuns = (& /path/from-status config get runs.dir 2>$null)
>   $socaiDir = if ($env:SOCAI_RUNS_DIR) { $env:SOCAI_RUNS_DIR } elseif ($configuredRuns) { $configuredRuns } else { "$HOME\.socai\runs" }
>   Write-Host "Jev Social runs: $jevDir"
>   Write-Host "socai artifacts: $socaiDir"
>   ```
> - **Retention & Manual Removal Guidance**:
>   - Review directory contents (e.g. `ls "$DIR"` or `Get-ChildItem $dir`) before removing any stored data.
>   - To clear individual runs or prune old artifacts, delete specific target files manually from the verified store directories rather than running unvalidated recursive shell recipes across dynamic or environment-supplied paths.
>   - Note: configured `runs.dir` paths may use custom directory names; always verify the exact resolved target directory before manual removal.
> - **Review Before Sharing**: Exported `report.md` files and run checkpoints can still preserve access-restricted post text, private account connections, author names, bio/experience data, comments, and direct URLs from your active session. Always review and redact sensitive data before sharing reports or diagnostic files publicly.

---

## Local Browser Boundary

By default (using `existing` or `managed` Chrome modes without external endpoint overrides), Jev Social operates strictly within your local Chrome browser environment:
- **No authentication bypasses**: It does not bypass login screens, CAPTCHAs, bot challenges, or platform rate limits.
- **No credential injection**: It does not store passwords, scrape private cookies, or use rotating proxy pools.
- **Honest failure reporting**: When a site gates content behind a login wall or rate limit, Jev Social halts visibly and returns partial results rather than inventing data or claiming false success.

*(Note on non-local execution: Users can explicitly provide external debugging endpoints via `SOCAI_CDP_URL` / `SOCAI_CDP_WS`. Additionally, `socai` supports a hosted `remote` mode (`chrome.profile remote`), which requires socai Pro and provisions ephemeral cloud browser sessions through `socai-server`. Hosted remote sessions run without interactive desktop access, so users cannot solve CAPTCHAs or login gates in hosted `remote` mode; authoritative socai guidance is to retry later or switch to local `existing` or `managed` mode to authenticate interactively.)*

---

## Distinguishing Failure & Result States

| State | What Happened | What You See | How to Resolve |
| --- | --- | --- | --- |
| **Missing `socai` executable** | The `socai` CLI is not installed or not discoverable at the resolved binary path. | Status indicator displays `socai unavailable`, or terminal reports `spawn ENOENT` / command not found. | On macOS and Windows, run `npx --yes github:socai-io/jev-social onboard` (or `npm start -- onboard`). On Linux, install the CLI package from source via Cargo (`cargo install --git https://github.com/socai-io/socai.git socai-cli`) and set `SOCAI_BIN`. |
| **Browser connection failure** | `socai` cannot connect to Chrome or its DevTools protocol (CDP) endpoint. | Error indicates connection refusal (e.g. `ECONNREFUSED 127.0.0.1:9222`), socket error, or browser launch timeout. | Follow your active connection mode below. Ensure the target Chrome instance is running with remote debugging enabled and accept any remote-debugging permission prompts. Avoid blanket process-killing commands. |
| **Login-required / challenge gate** | The platform blocked unauthenticated access with a login modal, redirect (e.g. `authwall`), or CAPTCHA. | Status displays a partial result notice with the specific gate reason (for example, `Partial results · The platform requires attention: login_required`). | Open the platform in the specific user-accessible Chrome session or profile selected by `socai` (`existing` or `managed` mode), complete authentication or challenges, and verify browsing before re-running. (If using hosted `remote` mode, switch to `existing` or `managed` mode to authenticate interactively.) |
| **Valid empty result** | The platform loaded successfully and the search executed cleanly, but returned 0 matching records. | Evidence cards, table, and heading remain hidden. Depending on subsequent decisions, the run can finalize as `partial` (`Partial results · Jev stopped without usable evidence.`), `step_limit` (if max steps are reached), or `decision_failed` (if a subsequent model decision call fails). | The initial search executed cleanly without matching records on the platform. Broaden or rephrase your search query. (If a subsequent decision failed, verify model API connectivity). |
| **Early decision or classification failure** | Jev encountered an error during classification or the very first action decision before any browser operations ran. | Classification failures emit an error before a run exists. A first action-decision failure saves a failed checkpoint with no captured posts. | Ensure your query is a supported read-only social research goal, specify `--platform` explicitly, or check your OpenRouter key and network connection. |
| **Mid-run decision failure (`decision_failed`)** | A model decision call failed after one or more actions had already executed. | Status displays `Partial results · <error message>` with status `decision_failed`; collected evidence prior to the failure is preserved. | Check OpenRouter API connectivity, ensure model quota is available, or retry the request. |

---

## Safe Diagnostics

Run these diagnostic commands to verify readiness without exposing API credentials or browser secrets:

### 1. Check Configuration & Capabilities

Jev Social resolves your OpenRouter key from `OPENROUTER_API_KEY`, lowercase `openrouter` in `.env`, or saved onboarding config (`config.json`). Checking only `$OPENROUTER_API_KEY` in your shell can falsely report "missing" when a key is already configured.

Query the local status endpoint to verify the effective `jevConfigured` state and platform capabilities:

```bash
curl -s http://127.0.0.1:8766/api/status
```

The browser API endpoint `/api/status` returns sanitized status and omits local filesystem paths:

```json
{
  "jevConfigured": true,
  "jevModel": "~typesafe/jev-latest",
  "socai": {
    "installed": true,
    "version": "0.6.0",
    "capabilities": {
      "instagram": true,
      "tiktok": true,
      "linkedin": true
    }
  }
}
```

*(Note: Platform capabilities are build-dependent. The official social CLI requires `v0.6+` or a development build with social subcommands enabled; older tagged releases such as `v0.5.6` registered only `xhs` and `dy`, so `instagram`, `tiktok`, and `linkedin` will all probe `false`. On `v0.6+` builds, `linkedin` evaluates to `true` or `false` depending on whether that specific build enables the LinkedIn subcommand.)*

For local operator diagnostics including the resolved configuration file path and binary path, run the CLI status command:

```bash
npm start -- status
```

Expected output:

```json
{
  "jevConfigured": true,
  "jevModel": "~typesafe/jev-latest",
  "configPath": "/home/user/.jev-social/config.json",
  "socai": {
    "installed": true,
    "bin": "/home/user/.socai/bin/socai",
    "version": "0.6.0",
    "capabilities": {
      "instagram": true,
      "tiktok": true,
      "linkedin": true
    }
  }
}
```

> [!NOTE]
> **Privacy note:** `npm start -- status` outputs `configPath` and `socai.bin` for local operator diagnostics. If sharing CLI output in public issues or chat, redact these local filesystem paths. The browser API endpoint (`/api/status`) automatically keeps paths sanitized.

### 2. Verify the Resolved `socai` Binary

Jev Social resolves the `socai` binary in the following order:
1. `SOCAI_BIN` environment variable or `socaiBin` in `~/.jev-social/config.json`.
2. Standard installation path at `~/.socai/bin/socai` (or `socai.exe` on Windows).
3. Local development build candidates (`target/debug` or `target/release`).
4. System `PATH`.

Because resolution is not pinned to a single binary and may differ from what is on your current shell `PATH`, test the exact binary resolved by Jev Social (found in the `socai.bin` field of `npm start -- status`, represented as `/path/from-status` below):

```bash
# Replace /path/from-status with your resolved binary path from `npm start -- status`:
/path/from-status --version
```

### 3. Installing or Reinstalling `socai`

- **macOS & Windows**: Run automated onboarding to download and install the official release:
  ```bash
  npx --yes github:socai-io/jev-social onboard
  # or from a repository checkout:
  npm start -- onboard
  ```
- **Linux & Source Builds**: Prebuilt installer downloads currently support macOS and Windows. On Linux, `socai` is a virtual Cargo workspace; install the `socai-cli` package via Cargo or build it from source:
  ```bash
  # Install via Cargo:
  cargo install --git https://github.com/socai-io/socai.git socai-cli

  # Or build from source:
  git clone https://github.com/socai-io/socai.git
  cd socai && cargo build --release -p socai-cli
  export SOCAI_BIN="$(pwd)/target/release/socai"
  ```

---

## Browser Connection & Session Modes

`socai` manages its Chrome connection mode and profile directory through configuration commands. To configure which browser session `socai` uses:

```bash
# Select profile connection mode: existing, managed, auto, or remote (requires Pro)
/path/from-status config set chrome.profile existing

# Select a custom Chrome profile / user data directory (applies to managed and auto modes):
/path/from-status config set chrome.profile_dir /path/to/profile/dir

# Stop the running daemon so new chrome.* settings take effect:
/path/from-status stop

# Inspect active configuration:
/path/from-status config get
```

### Connection Modes & Precedence in `socai v0.6.0`

- **CDP Precedence**: Explicit `SOCAI_CDP_WS` or `SOCAI_CDP_URL` environment variables take precedence in **all profile modes except `managed`** (including `existing`, `auto`, and `remote`). If `chrome.profile` is set to `remote` while an explicit CDP endpoint is provided, `socai` connects to that endpoint rather than provisioning a Pro-hosted cloud session. Only `managed` mode (`chrome.profile managed`) deliberately ignores external CDP endpoints to launch or reuse its isolated managed profile.
- **`existing`**: `socai` attaches to an already-running Chrome instance (e.g. started with `--remote-debugging-port=9222` or reachable at `SOCAI_CDP_URL`). Note: `chrome.profile_dir` is ignored for `existing` mode since it connects directly to the active browser process.
- **`managed`**: `socai` starts and controls a dedicated Chrome process. By default, it uses the persistent profile directory at `~/.socai/chrome-profile` (or `chrome.profile_dir` if configured), preserving login credentials and cookies across runs.
- **`auto`**: `socai` tries managed launch first, then falls back to connecting to an existing Chrome instance (`core/src/cdp/lifecycle.rs:403-411`).
- **`remote` (Hosted)**: A hosted cloud browser mode that requires **socai Pro** and provisions temporary remote sessions via `socai-server` (unless an explicit `SOCAI_CDP_*` endpoint override is set). Because hosted remote containers lack local GUI interaction, users cannot interactively solve login gates or CAPTCHAs in hosted `remote` mode; authoritative `socai` guidance is to retry later or switch to `existing` or `managed` mode to authenticate.

> [!TIP]
> If changing `chrome.*` configuration while the background `socai` daemon or browser is running, run `/path/from-status stop` (or `socai stop`) so the daemon reloads settings on the next run.

Jev Social forwards connection overrides (`SOCAI_CDP_URL`, `SOCAI_CDP_WS`, `SOCAI_CHROME_USER_DATA_DIR`, and `SOCAI_CHROME_EXECUTABLE`) to child processes during runtime discovery. (Note: `socai` does not read `SOCAI_CHROME_PROFILE`; use `socai config set chrome.profile` to configure the connection mode.)

### Working with Browser Sessions Safely

1. **Authenticate User-Accessible Profiles**: When logging into social platforms or solving challenges, ensure you are interacting with the session selected by `socai`:
   - For **`existing` mode**: Authenticate within the running Chrome instance discovered through CDP (e.g. on `--remote-debugging-port=9222` or `SOCAI_CDP_URL`). Note: `chrome.profile_dir` is completely ignored in `existing` mode.
   - For **`managed` or `auto` mode**: Authenticate within the designated profile directory (`chrome.profile_dir` or default `~/.socai/chrome-profile`).
   Logging into an everyday, unlinked browser profile will not share cookies or sessions with `socai`. If using hosted `remote` mode without an explicit CDP override, switch to `existing` or `managed` mode on your local machine to authenticate interactively.
2. **Existing-Profile Remote Debugging Permission**: If attaching `socai` to an existing Chrome profile via remote debugging (e.g. `--remote-debugging-port=9222`), Chrome may display an infobar or confirmation prompt requesting permission for remote debugging/automation. Confirm that this permission is granted.
3. **Avoid Blanket Process Termination**: Do not use blanket commands such as `pkill chrome` or `killall chrome`. Arbitrarily closing processes can destroy the exact running Chrome session, debugging port, or authenticated state that `socai` is configured to reuse.

---

## Platform-Specific Troubleshooting

### Instagram
- **Issue**: Instagram frequently prompts with a login modal or redirects unauthenticated queries to `/accounts/login/`.
- **Resolution**: Open `https://www.instagram.com` within a user-accessible Chrome session/profile selected by `socai` (`existing` or `managed` mode; switch to `existing` or `managed` if on hosted `remote` mode), log into your account, and verify you can browse posts without a login modal. Then re-run Jev Social.

### TikTok
- **Issue**: TikTok may present an interactive puzzle/slider challenge or restrict video detail and comments for unauthenticated sessions.
- **Resolution**: Complete any active puzzle verification within a user-accessible Chrome session/profile selected by `socai` (`existing` or `managed` mode). Test direct platform access using the resolved `socai` executable:
  ```bash
  /path/from-status tiktok search "wearable AI" --num 4 --pretty
  ```

### LinkedIn
- **Issue**: LinkedIn redirects unauthenticated searches for people, content, or companies to `linkedin.com/authwall`.
- **Capability Prerequisite**: Binary resolution is dynamic and depends on the active `socai` executable. Direct LinkedIn CLI commands require an executable with LinkedIn support enabled (e.g. a LinkedIn-capable `v0.6+` build or setting `SOCAI_BIN` to a capable executable).
- **Supported Diagnostics**:
  - Check platform capability via the local status endpoint:
    ```bash
    curl -s http://127.0.0.1:8766/api/status
    ```
    Confirm that `socai.capabilities.linkedin` evaluates to `true` (it evaluates to `false` on builds without the LinkedIn subcommand enabled).
  - Test subcommand availability directly on the resolved executable:
    ```bash
    /path/from-status linkedin --help
    ```
- **Resolution**: Sign into LinkedIn within a user-accessible Chrome session/profile selected by `socai` (`existing` or `managed` mode; switch to `existing` or `managed` if on hosted `remote` mode). Once your authenticated session is active and `socai.capabilities.linkedin` is `true`, run research through Jev Social:
  ```bash
  npm start -- search "find AI product managers in San Francisco on LinkedIn" --platform auto --limit 4
  ```
  On builds where the `linkedin` subcommand is supported by the resolved binary:
  ```bash
  /path/from-status linkedin search "AI product managers" --num 4 --pretty
  ```

---

## Working with Partial Evidence

Understanding how Jev Social handles runs that stop before completing all requested steps:

### Completed Partial Runs (Step Exhaustion & Login Gates)

When a run naturally halts at a barrier—such as a login or challenge wall (`status: blocked`) or reaching the configured decision step limit (`status: step_limit` via `--max-steps`)—**all collected evidence is preserved and finalized**:

1. **Finalized Report Generation**: The backend executes `evidenceReport()` and persists the run with `saveRun()`.
2. **Captured Post Cards**: Any posts, profiles, or video cards retrieved before the stopping point remain rendered in the UI.
3. **Records Table**: The structured evidence table retains all extracted rows.
4. **Action History**: The "Steps chosen by Jev" list displays each operation executed along with its status (`${step.action.label} · ${step.status}`).
5. **Report Export**: The generated Markdown summary is displayed, and the **Download report.md** button is fully accessible to export the captured evidence.

### Manual Cancellation

When a run is manually cancelled (e.g. by navigating back to search, clicking back, or closing the stream connection):
- **Shutdown Behavior**:
  - During the model request phase (classification or action choice via OpenRouter), the in-flight HTTP request is cancelled via `AbortSignal` with no child process signals involved.
  - During a running `socai` child operation, process tree termination is requested immediately: on Unix (macOS / Linux), `SIGTERM` is sent to the process group followed by `SIGKILL` after a one-second grace period; on Windows, `child.kill("SIGTERM")` is sent followed by `taskkill.exe /pid <pid> /t /f` after the one-second grace period.
  - Detached background browser sessions or the standalone `socai` daemon may remain running.
- **Observable Guarantee**: Cancellation stops active work and may end without a newly rendered run view or downloadable report in the UI. While an abort during the decision loop bypasses report compilation and run persistence, a disconnect during or after persistence can leave a saved run on disk while suppressing the final UI event.
