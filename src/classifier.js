import { AppError } from "./errors.js";
import { requestDecision } from "./decision-provider.js";
import { performance } from "node:perf_hooks";

export const SUPPORTED_PLATFORMS = new Set(["instagram", "tiktok", "linkedin"]);
const ROUTE_TO_PLATFORM = {
  instagram_search: "instagram",
  tiktok_search: "tiktok",
  linkedin_search: "linkedin",
};

const WORKFLOW_DEFINITIONS = {
  instagram: {
    workflow: "Read-only Instagram search via the socai CLI",
    route: "instagram_search",
    criterion: "Search or research Instagram content, profiles, posts, or reels.",
  },
  tiktok: {
    workflow: "Read-only TikTok search via the socai CLI",
    route: "tiktok_search",
    criterion: "Search or research TikTok content, creators, or videos.",
  },
  linkedin: {
    workflow: "Read-only LinkedIn search via the socai CLI",
    route: "linkedin_search",
    criterion: "Search or research LinkedIn people, companies, posts, or professional experience.",
  },
};

export async function classifySearch({
  goal,
  requestedPlatform = "auto",
  capabilities = { instagram: true, tiktok: true, linkedin: true },
  apiKey,
  model,
  provider,
  client,
  fetchImpl = fetch,
  signal,
}) {
  const decisionModel = model || provider?.model || process.env.OPENROUTER_JEV_MODEL || "~typesafe/jev-latest";
  const normalizedPlatform = (requestedPlatform || "auto").toLowerCase();
  if (normalizedPlatform !== "auto" && !SUPPORTED_PLATFORMS.has(normalizedPlatform)) {
    throw new AppError(`Unsupported platform: ${requestedPlatform}`, {
      code: "INVALID_PLATFORM",
    });
  }
  if (!goal?.trim()) {
    throw new AppError("Search query cannot be empty.", { code: "EMPTY_QUERY" });
  }

  const activePlatforms = [...SUPPORTED_PLATFORMS].filter((p) => capabilities?.[p] !== false);

  if (normalizedPlatform !== "auto" && !activePlatforms.includes(normalizedPlatform)) {
    throw new AppError(`The installed socai CLI does not support ${normalizedPlatform} search.`, {
      code: "SOCAI_CAPABILITY_MISSING",
      details: { platform: normalizedPlatform },
    });
  }

  const supportedWorkflows = activePlatforms.map((p) => WORKFLOW_DEFINITIONS[p].workflow);
  const routeCriteria = {};
  for (const p of activePlatforms) {
    routeCriteria[WORKFLOW_DEFINITIONS[p].route] = WORKFLOW_DEFINITIONS[p].criterion;
  }
  routeCriteria.unsupported = "Anything else, including posting, liking, following, messaging, or an ambiguous auto route.";

  const request = {
    model: decisionModel,
    state: {
      request: goal.trim(),
      requested_platform: normalizedPlatform,
      supported_workflows: supportedWorkflows,
    },
    questions: {
      route: {
        type: "choice",
        instructions: {
          task: "Choose the one supported workflow that should execute this request.",
          rules: [
            "Honor an explicit requested_platform.",
            "Choose unsupported when the request is not a read-only social search.",
            "Do not invent another platform or an action that changes remote state.",
          ],
        },
        criteria: routeCriteria,
      },
    },
  };
  const decision = await requestChoice({ request, key: "route", apiKey, provider, client, fetchImpl, signal });
  const selected = decision.choice;
  const platform = ROUTE_TO_PLATFORM[selected] || null;
  if (normalizedPlatform !== "auto" && platform !== normalizedPlatform) {
    throw new AppError(
      `Jev route '${selected}' conflicts with the explicitly selected ${normalizedPlatform} platform.`,
      {
        code: "JEV_ROUTE_MISMATCH",
        details: {
          requestedPlatform: normalizedPlatform,
          selectedRoute: selected,
          elapsedMs: decision.elapsedMs,
          model: decision.model,
          modelVerified: decision.modelVerified,
        },
      },
    );
  }
  return { ...decision, route: selected, platform };
}

export async function requestChoice({ request, key, apiKey, provider, client, fetchImpl = fetch, signal }) {
  signal?.throwIfAborted();
  const startedAt = performance.now();
  let response;
  try {
    response = client
      ? await client.systemOne(request, { signal })
      : await requestDecision({ provider, apiKey, request, fetchImpl, signal });
  } catch (error) {
    const details = {
      elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
      model: request.model,
      modelVerified: false,
    };
    if (signal?.aborted || error?.name === "AbortError") {
      const interrupted = new AppError("Jev decision was interrupted.", {
        code: "JEV_ABORTED",
        status: 499,
        details,
      });
      interrupted.name = "AbortError";
      throw interrupted;
    }
    throw new AppError(`Jev decision failed: ${error.message}`, {
      code: "JEV_UNAVAILABLE",
      status: 502,
      details,
    });
  }
  if (signal?.aborted) {
    const interrupted = new AppError("Jev decision was interrupted.", {
      code: "JEV_ABORTED",
      status: 499,
      details: {
        elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
        model: request.model,
        modelVerified: false,
      },
    });
    interrupted.name = "AbortError";
    throw interrupted;
  }
  const elapsedMs = Math.max(0, Math.round(performance.now() - startedAt));
  const resolvedModel = typeof response?.model === "string" && response.model.trim()
    ? response.model.trim()
    : request.model;
  const modelVerified = typeof response?.model === "string" && Boolean(response.model.trim());
  const answer = response?.answers?.[key];
  const selected = answer?.choice;
  const confidence = answer?.confidence;
  const probabilities = answer?.probabilities;
  const probabilitiesValid =
    probabilities === undefined ||
    (probabilities &&
      typeof probabilities === "object" &&
      !Array.isArray(probabilities) &&
      Object.values(probabilities).every(
        (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1,
      ));
  if (
    answer?.type !== "choice" ||
    !Object.hasOwn(request.questions[key].criteria, selected) ||
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1 ||
    !probabilitiesValid
  ) {
    throw new AppError("Jev returned an invalid decision response.", {
      code: "INVALID_JEV_RESPONSE",
      status: 502,
      details: { elapsedMs, model: resolvedModel, modelVerified },
    });
  }
  return {
    choice: selected,
    confidence,
    probabilities,
    model: resolvedModel,
    modelVerified,
    usage: response.usage || {},
    elapsedMs,
  };
}
