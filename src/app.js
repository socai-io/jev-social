import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { classifySearch } from "./classifier.js";
import { availableActions, chooseAction } from "./actions.js";
import { evidenceReport, extractEvidence, mergeEvidence, publicEvidence, resultObservation } from "./evidence.js";
import { AppError } from "./errors.js";
import { readConfig, resolveApiKey } from "./config.js";
import { resolveDecisionProvider } from "./decision-provider.js";
import { extractSearchQuery } from "./query.js";
import {
  buildGroundedResearchReport,
  requestOpenRouterResearchReport,
  splitReportChunks,
  synthesizeResearchReport,
} from "./report.js";
import { saveRun } from "./runs.js";
import { actionCapabilities, probeSocai, runSocaiAction, sanitizeCliErrorText } from "./socai.js";

const privateRunMedia = new WeakMap();

export function getPrivateRunMedia(run) {
  return privateRunMedia.get(run);
}

export async function runSearch(
  { query, platform = "auto", limit = 4, maxSteps = 12 },
  {
    env = process.env,
    client,
    onEvent,
    signal,
    synthesizer,
    reportChunkDelayMs = 18,
    reportFetchImpl = fetch,
    decisionFetchImpl = fetch,
  } = {},
) {
  const request = query?.trim();
  if (!request) throw new AppError("Search query cannot be empty.", { code: "EMPTY_QUERY" });
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AppError("limit must be between 1 and 100.", { code: "INVALID_LIMIT" });
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 30) throw new AppError("maxSteps must be between 1 and 30.", { code: "INVALID_STEP_LIMIT" });

  const deliveryAborted = () => {
    const error = new Error("The client disconnected while results were being delivered.");
    error.name = "AbortError";
    return error;
  };
  const emit = async (event) => {
    if (!onEvent) return true;
    const delivered = await onEvent(event);
    if (delivered === false) throw deliveryAborted();
    return true;
  };
  let pendingProgress;
  let progressTask;
  let progressFailure;
  const queueProgress = (event) => {
    pendingProgress = event;
    if (progressTask || progressFailure) return;
    progressTask = (async () => {
      while (pendingProgress) {
        const next = pendingProgress;
        pendingProgress = undefined;
        await emit(next);
      }
    })().catch((error) => {
      progressFailure ||= error;
    }).finally(() => {
      progressTask = undefined;
      if (pendingProgress && !progressFailure) queueProgress(pendingProgress);
    });
  };
  const flushProgress = async () => {
    while (progressTask) await progressTask;
    if (progressFailure) throw progressFailure;
  };

  const normalizedPlatform = (platform || "auto").toLowerCase();
  if (normalizedPlatform !== "auto" && !["instagram", "tiktok", "linkedin"].includes(normalizedPlatform)) {
    throw new AppError(`Unsupported platform: ${platform}`, { code: "INVALID_PLATFORM" });
  }

  const config = await readConfig(env);
  const probe = await probeSocai(config, env, signal);
  const capabilities = probe.capabilities || { instagram: false, tiktok: false, linkedin: false };

  if (normalizedPlatform !== "auto") {
    if (!probe.installed || !capabilities[normalizedPlatform]) {
      throw new AppError(
        `The installed socai CLI does not support ${normalizedPlatform} search. Install a compatible build or set SOCAI_BIN.`,
        {
          code: "SOCAI_CAPABILITY_MISSING",
          details: { platform: normalizedPlatform },
        },
      );
    }
  } else {
    if (!probe.installed || !Object.values(capabilities).some(Boolean)) {
      throw new AppError(
        "No supported social search platforms are available in the installed socai CLI.",
        {
          code: "SOCAI_CAPABILITY_MISSING",
        },
      );
    }
  }

  const apiKey = resolveApiKey(config, env);
  const provider = resolveDecisionProvider(env);
  if (!apiKey && !client && provider.kind !== "local") {
    throw new AppError("Set OPENROUTER_API_KEY first.", { code: "ONBOARDING_REQUIRED" });
  }
  const startedAt = Date.now();
  const model = provider.model;
  const decisionOptions = { apiKey, model, provider, client, fetchImpl: decisionFetchImpl, signal };
  await emit({ stage: "classifying", message: "Jev is choosing the social platform…" });
  const classification = await classifySearch({
    goal: request,
    requestedPlatform: normalizedPlatform,
    capabilities,
    ...decisionOptions,
  });
  if (!classification.platform) throw new AppError("This request is not a supported read-only social task.", { code: "UNSUPPORTED_TASK" });
  if (classification.confidence < 0.35) throw new AppError("Jev is uncertain about the platform. Select one explicitly.", { code: "LOW_CLASSIFICATION_CONFIDENCE" });
  const selectedPlatform = classification.platform;
  const commands = await actionCapabilities({ config, env, platform: selectedPlatform, signal, capabilities });
  const searchQuery = extractSearchQuery(request);
  const createdAt = new Date().toISOString();
  const id = `${createdAt.replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomBytes(3).toString("hex")}`;
  let items = [];
  const actions = [];
  const executions = [];
  let status = "running";
  let stopReason = "Research is still in progress.";
  let activeEntry;
  let finalReport = "";
  let reportKind = "evidence";
  let reportModel;
  let reportStatus = "pending";
  const reportInput = () => ({
    request,
    platform: selectedPlatform,
    items,
    actions,
    status,
    stopReason,
  });

  const checkpoint = async () => {
    const publicRequest = publicEvidence(request);
    const publicQuery = publicEvidence(searchQuery);
    const publicItems = publicEvidence(items);
    const publicStopReason = publicEvidence(stopReason);
    const report = finalReport || evidenceReport({ request: publicRequest, platform: selectedPlatform, items: publicItems, actions, status, stopReason: publicStopReason });
    const run = {
      id, createdAt, updatedAt: new Date().toISOString(), request: publicRequest, query: publicQuery,
      requestedPlatform: platform, platform: selectedPlatform,
      classification: publicEvidence(classification),
      actions: actions.map(({ command: _command, ...entry }) => publicEvidence(entry)),
      status, stopReason: publicStopReason, maxSteps,
      socaiExitCode: executions.at(-1)?.exitCode ?? null,
      socaiElapsedMs: executions.reduce((sum, execution) => sum + execution.elapsedMs, 0),
      jevElapsedMs: classification.elapsedMs + actions.reduce((sum, entry) => sum + (entry.jevElapsedMs || 0), 0),
      elapsedMs: Date.now() - startedAt,
      result: { ok: status === "completed", query: publicQuery, items: publicItems },
      report,
      finalSocaiOutput: report,
      reportKind,
      reportStatus,
      ...(reportModel ? { reportModel } : {}),
    };
    await saveRun(run, env);
    return run;
  };

  await checkpoint();
  await emit({ stage: "started", run: { id, createdAt, query: searchQuery, platform: selectedPlatform, status } });

  // Every operation, including which exact result to open, is chosen from the
  // current observation. The model never supplies executable shell or JS.
  try {
    for (let step = 0; step < maxSteps; step += 1) {
      signal?.throwIfAborted();
      const candidates = availableActions({ platform: selectedPlatform, query: searchQuery, goal: request, items, history: actions, commands, limit });
      await emit({ stage: "planning", message: "Jev is choosing the next operation…", step: step + 1 });
      let decision;
      try {
        decision = await chooseAction({ goal: request, platform: selectedPlatform, actions: candidates, history: actions, items, limit, remainingSteps: maxSteps - step, ...decisionOptions });
      } catch (error) {
        if (!actions.length || signal?.aborted) throw error;
        status = "decision_failed";
        stopReason = safeProgress(error.message) || "Jev could not choose another safe operation.";
        break;
      }
      const action = decision.action;
      const entry = {
        step: step + 1, action, confidence: decision.confidence,
        model: decision.model, usage: decision.usage, jevElapsedMs: decision.elapsedMs,
        status: "selected",
      };
      activeEntry = entry;
      actions.push(entry);
      if (action.kind === "finish") {
        entry.status = "completed";
        status = items.length && !actions.some((item) => item.status === "failed") ? "completed" : "partial";
        stopReason = items.length ? "Jev chose to finish with the evidence captured so far." : "Jev stopped without usable evidence.";
        await checkpoint();
        activeEntry = undefined;
        break;
      }
      await checkpoint();
      const stage = action.downloadMedia ? "downloading" : action.kind === "search" ? "searching" : "reading";
      await emit({ stage, message: action.label, step: step + 1, action: { kind: action.kind, target: action.target } });
      try {
        const execution = await runSocaiAction({
          action, config, env, signal,
          onProgress: (message) => {
            const clean = safeProgress(message);
            if (clean) queueProgress({ stage, message: clean });
          },
        });
        await flushProgress();
        executions.push(execution);
        const captured = extractEvidence(execution.data, action);
        items = mergeEvidence(items, captured);
        const observation = resultObservation(execution.data, captured);
        Object.assign(entry, { command: execution.command, elapsedMs: execution.elapsedMs, observation, status: observation.ok ? "completed" : "failed" });
        if (observation.blocked) {
          status = "blocked";
          stopReason = `The platform requires attention: ${observation.reason || observation.status || "login or access check"}.`;
        }
        await checkpoint();
        if (captured.length) await emit({ stage: "evidence", items: publicEvidence(items), message: `Captured ${items.length} records.` });
        activeEntry = undefined;
        if (observation.blocked) break;
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        signal?.throwIfAborted();
        Object.assign(entry, { status: "failed", observation: { ok: false, code: error.code, error: safeProgress(error.message) || "Browser operation failed." } });
        await checkpoint();
        activeEntry = undefined;
        await emit({ stage: "planning", message: "The operation failed. Jev is considering the remaining options." });
      }
    }
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") {
      if (activeEntry?.status === "selected") activeEntry.status = "interrupted";
      status = "interrupted";
      stopReason = "The browser stream closed before this run completed.";
      reportStatus = "interrupted";
      reportKind = "fallback";
      finalReport = buildGroundedResearchReport(reportInput());
      await checkpoint();
      throw error;
    }
    if (activeEntry?.status === "selected") activeEntry.status = "failed";
    status = "failed";
    stopReason = safeProgress(error.message) || "The research run failed before completion.";
    reportStatus = "failed";
    reportKind = "fallback";
    finalReport = buildGroundedResearchReport(reportInput());
    await checkpoint();
    throw error;
  }
  if (status === "running") {
    status = "step_limit";
    stopReason = `Reached the limit of ${maxSteps} operations before Jev chose to finish.`;
  }

  reportStatus = "generating";
  finalReport = buildGroundedResearchReport(reportInput());
  await checkpoint();
  await emit({
    stage: "researching",
    message: "Comparing captured claims, comments, engagement, and coverage gaps.",
  });
  try {
    const configuredModel = String(env.OPENROUTER_REPORT_MODEL || "openai/gpt-4o-mini").trim();
    const liveSynthesizer = typeof synthesizer === "function"
      ? synthesizer
      : apiKey && !client && configuredModel.toLowerCase() !== "off"
        ? (safeInput) => requestOpenRouterResearchReport(safeInput, {
            apiKey,
            model: configuredModel,
            fetchImpl: reportFetchImpl,
            signal,
          })
        : undefined;
    const synthesis = await synthesizeResearchReport(reportInput(), { synthesizer: liveSynthesizer });
    finalReport = synthesis.report;
    reportKind = synthesis.kind;
    reportModel = synthesis.model;
    reportStatus = "streaming";
    await checkpoint();

    const chunks = splitReportChunks(finalReport);
    for (const [index, chunk] of chunks.entries()) {
      signal?.throwIfAborted();
      await emit({
        stage: "report",
        message: "Writing the evidence-grounded report.",
        chunk,
        index: index + 1,
        total: chunks.length,
        kind: reportKind,
        ...(reportModel ? { model: reportModel } : {}),
      });
      signal?.throwIfAborted();
      if (onEvent && index < chunks.length - 1 && reportChunkDelayMs > 0) {
        await delay(Math.min(250, Number(reportChunkDelayMs) || 0), undefined, { signal });
      }
    }
    reportStatus = "completed";
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") {
      status = "interrupted";
      stopReason = "The browser stream closed while the report was being delivered.";
      reportStatus = "interrupted";
      reportKind = "fallback";
      reportModel = undefined;
      finalReport = buildGroundedResearchReport(reportInput());
      await checkpoint();
      throw error;
    }
    status = "failed";
    stopReason = safeProgress(error.message) || "The research report could not be delivered.";
    reportStatus = "failed";
    reportKind = "fallback";
    reportModel = undefined;
    finalReport = buildGroundedResearchReport(reportInput());
    await checkpoint();
    throw error;
  }
  const stored = await checkpoint();
  privateRunMedia.set(stored, { items });
  await emit({ stage: "complete", status, message: status === "completed" ? "Evidence ready." : `Partial evidence saved. ${stopReason}` });
  return stored;
}

function safeProgress(message) {
  const raw = String(message || "").trim();
  if (!raw || raw.startsWith("@@SOCAI_EVENT@@") || /^[{[]/.test(raw)) return "";
  if (/^\d{4}-\d{2}-\d{2}T\S+\s+(?:TRACE|DEBUG|INFO|WARN|ERROR)\b/.test(raw)) return "";
  if (/^at\s+(?:<anonymous>|[\w.]+)(?::|\s|$)/.test(raw)) return "";
  const sanitized = sanitizeCliErrorText(raw);
  if (/^(?:run_dir|report_path|local_path|output_dir|artifact_path)\s*[:=]\s*\[path\]$/i.test(sanitized)) return "";
  return sanitized;
}
