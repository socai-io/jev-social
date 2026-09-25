import crypto from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { getHomeDir } from "./config.js";
import { buildGroundedResearchReport } from "./report.js";

const writeQueues = new Map();

function runsDir(env = process.env) {
  return path.join(getHomeDir(env), "runs");
}

export async function saveRun(run, env = process.env) {
  if (!run?.id || !/^[A-Za-z0-9_.-]+$/.test(run.id)) throw new Error("Run id contains invalid characters.");
  const directory = runsDir(env);
  const target = path.join(directory, `${run.id}.json`);
  const previous = writeQueues.get(target) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, target);
      return target;
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  });
  writeQueues.set(target, operation);
  try {
    return await operation;
  } finally {
    if (writeQueues.get(target) === operation) writeQueues.delete(target);
  }
}

export async function listRuns(env = process.env, limit = 30) {
  let files;
  try {
    files = await readdir(runsDir(env));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const selected = files
    .filter((name) => name.endsWith(".json"))
    .sort()
    .reverse()
    .slice(0, limit);
  const runs = [];
  for (const name of selected) {
    try {
      const run = JSON.parse(await readFile(path.join(runsDir(env), name), "utf8"));
      runs.push({
        id: run.id,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        query: run.query,
        platform: run.platform,
        status: run.status,
        stopReason: run.stopReason,
        elapsedMs: run.elapsedMs,
        itemCount: countItems(run.result),
      });
    } catch {
      // Ignore a partial or manually edited history entry.
    }
  }
  return runs;
}

export async function markInterruptedRuns(env = process.env) {
  let files;
  try {
    files = await readdir(runsDir(env));
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
  let changed = 0;
  for (const name of files.filter((value) => value.endsWith(".json"))) {
    let run;
    try {
      run = JSON.parse(await readFile(path.join(runsDir(env), name), "utf8"));
    } catch {
      continue;
    }
    const reportInProgress = ["pending", "generating", "streaming"].includes(run.reportStatus);
    if (run.status !== "running" && !reportInProgress) continue;
    const stopReason = "The local process stopped before this run completed.";
    const report = buildGroundedResearchReport({
      request: run.request || run.query,
      platform: run.platform,
      items: run.result?.items,
      actions: run.actions,
      status: "interrupted",
      stopReason,
    });
    await saveRun({
      ...run,
      updatedAt: new Date().toISOString(),
      status: "interrupted",
      stopReason,
      result: { ...(run.result || {}), ok: false },
      report,
      finalSocaiOutput: report,
      reportKind: "fallback",
      reportStatus: "interrupted",
    }, env);
    changed += 1;
  }
  return changed;
}

export async function readRun(id, env = process.env) {
  if (!/^[A-Za-z0-9_.-]+$/.test(id)) return null;
  try {
    return JSON.parse(await readFile(path.join(runsDir(env), `${id}.json`), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function countItems(value) {
  if (Array.isArray(value)) return value.length;
  if (!value || typeof value !== "object") return 0;
  for (const key of ["results", "items", "videos", "posts", "data"]) {
    if (Array.isArray(value[key])) return value[key].length;
  }
  return 0;
}
