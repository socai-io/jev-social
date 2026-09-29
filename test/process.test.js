import assert from "node:assert/strict";
import test from "node:test";
import { childEnvironment, formatCommand, runProcess } from "../src/process.js";

test("formatCommand shell-quotes substitutions in its display string", () => {
  assert.equal(formatCommand("socai", ["instagram", "search", "$(echo injected)"]), "socai instagram search '$(echo injected)'");
  assert.equal(formatCommand("socai", ["instagram", "search", "it's here"]), "socai instagram search 'it'\"'\"'s here'");
});

test("runProcess preserves signal termination without fabricating an exit code", async () => {
  if (process.platform === "win32") return;
  const result = await runProcess(process.execPath, ["-e", 'process.kill(process.pid, "SIGTERM")']);
  assert.equal(result.code, null);
  assert.equal(result.signal, "SIGTERM");
});

test("childEnvironment forwards socai/runtime settings but strips API credentials", () => {
  const value = childEnvironment({
    PATH: "/bin",
    HOME: "/tmp/home",
    SOCAI_HOME: "/tmp/socai",
    SOCAI_TELEMETRY: "0",
    SOCAI_TELEMETRY_QUERY_TEXT: "off",
    SOCAI_TELEMETRY_CHAT_TEXT: "false",
    SOCAI_API_KEY: String(1),
    SOCAI_SESSION_TOKEN: String(2),
    TYPESAFE_API_KEY: String(3),
    OPENROUTER_API_KEY: String(4),
  });
  assert.deepEqual(value, {
    PATH: "/bin",
    HOME: "/tmp/home",
    SOCAI_HOME: "/tmp/socai",
    SOCAI_TELEMETRY: "0",
    SOCAI_TELEMETRY_QUERY_TEXT: "off",
    SOCAI_TELEMETRY_CHAT_TEXT: "false",
  });
});

test("childEnvironment disables socai telemetry unless the caller explicitly opts in", () => {
  for (const value of [undefined, "", " ", "garbage", "0", "off", "true"]) {
    const source = value === undefined ? { PATH: "/bin" } : { PATH: "/bin", SOCAI_TELEMETRY: value };
    assert.deepEqual(childEnvironment(source), { PATH: "/bin", SOCAI_TELEMETRY: "0" });
  }
  assert.equal(childEnvironment({ SOCAI_TELEMETRY: "1" }).SOCAI_TELEMETRY, "1");
});

test("runProcess force-kills a child that ignores SIGTERM", async () => {
  const startedAt = Date.now();
  const result = await runProcess(
    process.execPath,
    ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],
    { timeoutMs: 80, killGraceMs: 80 },
  );
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - startedAt < 3_000, "timeout should settle after the force-kill grace period");
});

test("runProcess force-kills output that exceeds the configured limit", async () => {
  const result = await runProcess(
    process.execPath,
    ["-e", "process.stdout.write('x'.repeat(10000)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],
    { timeoutMs: 5_000, killGraceMs: 80, maxOutputBytes: 100 },
  );
  assert.equal(result.overflowed, true);
});

test("runProcess kills resistant descendants after the group leader exits", async () => {
  if (process.platform === "win32") return;
  const controller = new AbortController();
  let abortStartedAt;
  const parent = `
    const { spawn } = require("node:child_process");
    spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); console.error('ready'); setInterval(()=>{},1000)"], {
      stdio: ["ignore", "inherit", "inherit"]
    });
    process.on("SIGTERM", () => process.exit(0));
    setInterval(() => {}, 1000);
  `;
  const result = await runProcess(process.execPath, ["-e", parent], {
    signal: controller.signal,
    timeoutMs: 5_000,
    killGraceMs: 80,
    onStderr(line) {
      if (line !== "ready" || abortStartedAt) return;
      abortStartedAt = Date.now();
      controller.abort();
    },
  });
  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);
  assert.match(result.stderr, /ready/);
  assert.ok(Date.now() - abortStartedAt < 2_000, "descendant should be killed with the original process group");
});

test("runProcess frames UTF-8 stderr progress by complete lines", async () => {
  const progress = [];
  const script = `
    const value = Buffer.from("progress ✓\\nlast ✓", "utf8");
    for (const byte of value) process.stderr.write(Buffer.from([byte]));
  `;
  const result = await runProcess(process.execPath, ["-e", script], {
    onStderr: (line) => progress.push(line),
  });
  assert.equal(result.code, 0);
  assert.deepEqual(progress, ["progress ✓", "last ✓"]);
});

test("runProcess terminates the process tree when aborted", async () => {
  if (process.platform === "win32") return;
  const controller = new AbortController();
  const script = `
    const { spawn } = require("node:child_process");
    const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], {
      stdio: "ignore"
    });
    console.log(descendant.pid);
    process.on("SIGTERM", () => process.exit(0));
    setInterval(() => {}, 1000);
  `;
  const pending = runProcess(
    process.execPath,
    ["-e", script],
    { signal: controller.signal, killGraceMs: 60, timeoutMs: 5_000 },
  );
  setTimeout(() => controller.abort(), 180);
  const result = await pending;
  assert.equal(result.aborted, true);
  const descendantPid = Number(result.stdout.trim());
  await new Promise((resolve) => setTimeout(resolve, 140));
  assert.throws(() => process.kill(descendantPid, 0), { code: "ESRCH" });
});
