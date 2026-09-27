import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const MAX_OUTPUT_BYTES = 24 * 1024 * 1024;
const CHILD_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "PROGRAMDATA",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "NO_COLOR",
  "SOCAI_CDP_URL",
  "SOCAI_CDP_WS",
  "SOCAI_CHROME_EXECUTABLE",
  "SOCAI_CHROME_PROFILE",
  "SOCAI_CHROME_USER_DATA_DIR",
  "SOCAI_CLOUD_BASE_URL",
  "SOCAI_DOWNLOAD_BASE_URL",
  "SOCAI_HOME",
  "SOCAI_INSTALL_DIR",
  "SOCAI_LLM_PROVIDER",
  "SOCAI_MODEL",
  "SOCAI_MODEL_SYNC_OFFLINE",
  "SOCAI_NO_UPDATE_CHECK",
  "SOCAI_PRO_BASE_URL",
  "SOCAI_RUNS_DIR",
  "SOCAI_SESSIONS_DIR",
  "SOCAI_SKIP_UPDATE_CHECK",
  "SOCAI_TELEMETRY",
  "SOCAI_TELEMETRY_CHAT_TEXT",
  "SOCAI_TELEMETRY_QUERY_TEXT",
  "SOCAI_TRACES_ENDPOINT",
  "SOCAI_WHISPER_CLI",
]);

export function childEnvironment(source = process.env) {
  const child = Object.fromEntries(
    Object.entries(source).filter(
      ([key, value]) => value !== undefined && CHILD_ENV_KEYS.has(key),
    ),
  );
  // socai treats every value outside its opt-out list as enabled. Require Jev
  // Social callers to use the one documented affirmative value so blanks,
  // typos, and inherited surprises remain privacy-off.
  child.SOCAI_TELEMETRY = String(child.SOCAI_TELEMETRY ?? "").trim() === "1" ? "1" : "0";
  return child;
}

export function runProcess(command, args, options = {}) {
  const {
    cwd,
    env = process.env,
    timeoutMs = 5 * 60_000,
    onStderr,
    inherit = false,
    maxOutputBytes = MAX_OUTPUT_BYTES,
    killGraceMs = 1_000,
    signal,
  } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error("Operation aborted.");
      error.name = "AbortError";
      reject(error);
      return;
    }
    let spawnCommand = command;
    let spawnArgs = args;
    if (process.platform === "win32" && /\.[cm]?js$/i.test(command)) {
      spawnCommand = process.execPath;
      spawnArgs = [command, ...args];
    }
    const child = spawn(spawnCommand, spawnArgs, {
      cwd,
      env: childEnvironment(env),
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });

    let forceKillTimer;
    let aborted = false;
    let stopRequested = false;
    const stop = () => {
      stopRequested = true;
      terminateTree(child, "SIGTERM");
      forceKillTimer ||= setTimeout(() => terminateTree(child, "SIGKILL"), killGraceMs);
      forceKillTimer.unref?.();
    };
    const abort = () => {
      aborted = true;
      stop();
    };
    signal?.addEventListener("abort", abort, { once: true });
    const cleanup = (preserveForceKill = false) => {
      signal?.removeEventListener("abort", abort);
      if (!preserveForceKill) clearTimeout(forceKillTimer);
    };

    if (inherit) {
      const timer = setTimeout(stop, timeoutMs);
      child.once("error", (error) => {
        clearTimeout(timer);
        cleanup();
        reject(error);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        cleanup(stopRequested);
        resolve({ code, signal, stdout: "", stderr: "", aborted });
      });
      return;
    }

    const stdout = [];
    const stderr = [];
    const progressDecoder = new StringDecoder("utf8");
    let progressBuffer = "";
    let outputBytes = 0;
    let timedOut = false;
    let overflowed = false;
    const append = (target, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        overflowed = true;
        stop();
        return;
      }
      target.push(chunk);
    };

    child.stdout.on("data", (chunk) => append(stdout, chunk));
    child.stderr.on("data", (chunk) => {
      append(stderr, chunk);
      if (!onStderr) return;
      progressBuffer += progressDecoder.write(chunk);
      const lines = progressBuffer.split(/\r?\n/);
      progressBuffer = lines.pop() || "";
      for (const line of lines) if (line) onStderr(line);
    });
    child.stderr.on("end", () => {
      if (!onStderr) return;
      progressBuffer += progressDecoder.end();
      if (progressBuffer) onStderr(progressBuffer);
      progressBuffer = "";
    });

    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timer);
      cleanup();
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      cleanup(stopRequested);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        overflowed,
        aborted,
      });
    });
  });
}

function terminateTree(child, signal) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    if (signal === "SIGKILL") {
      const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.on("error", () => {});
    } else {
      child.kill("SIGTERM");
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") child.kill(signal);
  }
}

export function formatCommand(command, args) {
  const quote = (value) => {
    const text = String(value);
    if (/^[A-Za-z0-9_./:=+-]+$/.test(text)) return text;
    return `'${text.replaceAll("'", `'"'"'`)}'`;
  };
  return [command, ...args].map(quote).join(" ");
}
