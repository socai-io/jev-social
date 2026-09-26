import { AppError } from "./errors.js";
import { requestDecision } from "./decision-provider.js";
import { performance } from "node:perf_hooks";

export const SUPPORTED_PLATFORMS = new Set(["instagram", "tiktok", "linkedin"]);
const ROUTE_TO_PLATFORM = {
  instagram_search: "instagram",
  tiktok_search: "tiktok",
  linkedin_search: "linkedin",
};
const PLATFORM_PATTERN_SOURCE = "(?:instagram|insta|tiktok|tik[\\s-]?tok|linked[\\s-]?in)";
const DIRECT_PLATFORM_ROUTE = new RegExp(
  `\\b(?:search|research|explore|browse|scan|monitor|track|investigate|analy[sz]e|review|find|discover|look\\s+up)\\s+(?:on\\s+|in\\s+|from\\s+|via\\s+|using\\s+)?(?<platform>${PLATFORM_PATTERN_SOURCE})\\b`,
  "giu",
);
const PREPOSITION_PLATFORM_ROUTE = new RegExp(
  `\\b(?:search|research|explore|browse|scan|monitor|track|investigate|analy[sz]e|review|find|discover|look\\s+up)\\b[^.;!?\\n]{0,100}?\\b(?:on|in|from|via|using)\\s+(?<platform>${PLATFORM_PATTERN_SOURCE})\\b`,
  "giu",
);
const COORDINATED_PLATFORM_ROUTE = new RegExp(
  `\\b(?:on|in|from|via|using)\\s+${PLATFORM_PATTERN_SOURCE}\\s*(?:,|and|or|/)\\s*${PLATFORM_PATTERN_SOURCE}\\b`,
  "iu",
);
const MUTATION_ACTIONS = [
  /^(?:post|publish|upload)\b(?!\s+(?:performance|reach|impressions?|analytics?|metrics?|engagement|sentiment|data|statistics?|trends?|frequency|rates?|activity|history|volume|cadence|timing|topics?|formats?|length|quality|distribution|demographics?)\b)/iu,
  /^create\s+(?:(?:a|an|the|this|that|new)\s+)?(?:posts?|comments?|repl(?:y|ies)|stories|reels?|messages?|dms?|content)\b/iu,
  /^(?:delete|remove|edit|update|repost|reshare|share)\s+(?:(?:a|an|the|this|that|my|our|their|his|her|new)\s+)?(?:(?:instagram|insta|tiktok|tik[\s-]?tok|linked[\s-]?in)\s+)?(?:posts?|photos?|videos?|comments?|repl(?:y|ies)|messages?|stories|reels?|content|updates?|bios?|profiles?|captions?|accounts?|it|them)\b/iu,
  /^(?:follow|unfollow)\s+(?:@[\w.-]+|(?:(?:a|an|the|this|that|my|our|their|his|her)\s+)?(?:(?:instagram|insta|tiktok|tik[\s-]?tok|linked[\s-]?in)\s+)?(?:creators?|users?|accounts?|profiles?|people|persons?|influencers?|brands?|companies?|him|her|them|me))\b/iu,
  /^(?:like|unlike|react\s+to)\s+(?:@[\w.-]+|(?:(?:a|an|the|this|that|my|our|their|his|her)\s+)?(?:(?:instagram|insta|tiktok|tik[\s-]?tok|linked[\s-]?in)\s+)?(?:posts?|photos?|videos?|comments?|reels?|stories|content|updates?|accounts?|it|them))\b/iu,
  /^(?:message|dm)\s+(?:@[\w.-]+|(?:(?:a|an|the|this|that|my|our|their|his|her)\s+)?(?:(?:instagram|insta|tiktok|tik[\s-]?tok|linked[\s-]?in)\s+)?(?:creators?|users?|accounts?|profiles?|people|persons?|influencers?|him|her|them|me))\b/iu,
  /^send\s+(?:(?:a|an|the|this|that|my|our|their)\s+)?(?:messages?|dms?|repl(?:y|ies)|comments?|invites?)\b/iu,
  /^send\s+(?:@[\w.-]+|them|him|her|me|(?:(?:the|this|that)\s+)?(?:creators?|users?|people|persons?))\s+(?:(?:a|an|the)\s+)?(?:messages?|dms?|repl(?:y|ies)|comments?|invites?)\b/iu,
  /^comment\s+(?:on|under)\b/iu,
  /^comment\s+(?:this|that|something|text|content|an?\s+emoji)\s+(?:on|under)\b/iu,
  /^(?:leave|write)\s+(?:(?:a|an|the|this|that)\s+)?(?:comments?|repl(?:y|ies)|messages?|dms?)\b/iu,
  /^give\s+(?:(?:a|an|the|this|that|their|his|her)\s+)?(?:posts?|photos?|videos?|comments?|reels?|stories|content)\s+(?:(?:a|an|the)\s+)?(?:like|reaction)\b/iu,
  /^reply\s+(?:to|on|under)\b/iu,
  /^(?:connect\s+with|invite|subscribe\s+to|block|unblock|mute|unmute)\b/iu,
];
const CHINESE_MUTATION_ACTION = /^(?:(?:请|麻烦|帮我|请帮我|可以帮我|我想|我要|我需要你|能否|可以)\s*)?(?:发布|发帖|上传|删除|转发|点赞|关注|取消关注|评论|回复|私信|发消息|拉黑|屏蔽|修改(?:我的)?(?:简介|个人资料))/u;
const READ_ONLY_ANALYTICS_ACTION = /^follow\b[^.;!?]{0,80}\b(?:posting\s+frequency|activity|trends?|metrics?|performance|growth|changes?|updates?)\b/iu;

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

function normalizePlatformMention(value) {
  const normalized = value.toLowerCase().replace(/[\s-]/gu, "");
  if (normalized === "instagram" || normalized === "insta") return "instagram";
  if (normalized === "tiktok") return "tiktok";
  if (normalized === "linkedin") return "linkedin";
  return null;
}

function isNegatedRouteMatch(goal, match) {
  const before = goal.slice(Math.max(0, match.index - 80), match.index);
  const matchedPrefix = match[0].slice(0, match[0].lastIndexOf(match.groups.platform));
  return /\b(?:do\s+not|don't|never|avoid|exclude|without|not)\b[^,;.!?\n]{0,60}$/iu.test(before)
    || /\b(?:not|never|avoid|exclude|without)\b[^.;!?\n]*$/iu.test(matchedPrefix);
}

function routeMatches(goal, pattern) {
  pattern.lastIndex = 0;
  return [...goal.matchAll(pattern)]
    .filter((match) => !isNegatedRouteMatch(goal, match))
    .map((match) => normalizePlatformMention(match.groups.platform))
    .filter(Boolean);
}

function inferGoalPlatform(goal) {
  if (COORDINATED_PLATFORM_ROUTE.test(goal)) return null;

  const preposition = [...new Set(routeMatches(goal, PREPOSITION_PLATFORM_ROUTE))];
  if (preposition.length === 1) return preposition[0];
  if (preposition.length > 1) return null;

  const direct = [...new Set(routeMatches(goal, DIRECT_PLATFORM_ROUTE))];
  return direct.length === 1 ? direct[0] : null;
}

function mutationClauses(goal) {
  const clauses = [goal.trim()];
  const suffixes = /(?:[.;!?]\s*|\b(?:then|and\s+then|after\s+that)\s+|(?:然后|再))([^.;!?]+)/giu;
  for (const match of goal.matchAll(suffixes)) clauses.push(match[1].trim());
  const conjunctions = /\band\s+((?:please\s+)?(?:post|publish|upload|create|delete|remove|edit|update|repost|reshare|share|follow|unfollow|like|unlike|react|message|dm|send|comment|reply|leave|write|give|connect|invite|subscribe|block|unblock|mute|unmute)\b[^.;!?]*)/giu;
  for (const match of goal.matchAll(conjunctions)) clauses.push(match[1].trim());
  return clauses;
}

function stripRequestPrefix(value) {
  return value.replace(
    /^(?:(?:please|kindly)\s+|(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)|(?:i\s+(?:want|need|would\s+like)\s+(?:you\s+)?to\s+))+/iu,
    "",
  );
}

function hasClearMutationRequest(goal) {
  return mutationClauses(goal).some((clause) => {
    const command = stripRequestPrefix(clause.trim());
    if (READ_ONLY_ANALYTICS_ACTION.test(command)) return false;
    return CHINESE_MUTATION_ACTION.test(command)
      || MUTATION_ACTIONS.some((pattern) => pattern.test(command));
  });
}

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
  if (hasClearMutationRequest(goal)) {
    throw new AppError("This request is not a supported read-only social task.", {
      code: "UNSUPPORTED_TASK",
    });
  }

  const activePlatforms = [...SUPPORTED_PLATFORMS].filter((p) => capabilities?.[p] !== false);
  const goalPlatform = inferGoalPlatform(goal);

  if (normalizedPlatform !== "auto" && !activePlatforms.includes(normalizedPlatform)) {
    throw new AppError(`The installed socai CLI does not support ${normalizedPlatform} search.`, {
      code: "SOCAI_CAPABILITY_MISSING",
      details: { platform: normalizedPlatform },
    });
  }
  if (normalizedPlatform === "auto" && goalPlatform && !activePlatforms.includes(goalPlatform)) {
    throw new AppError(`The installed socai CLI does not support ${goalPlatform} search.`, {
      code: "SOCAI_CAPABILITY_MISSING",
      details: { platform: goalPlatform },
    });
  }
  const effectivePlatform = normalizedPlatform === "auto"
    ? goalPlatform || "auto"
    : normalizedPlatform;

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
      requested_platform: effectivePlatform,
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
  if (selected !== "unsupported" && effectivePlatform !== "auto" && platform !== effectivePlatform) {
    throw new AppError(
      `Jev route '${selected}' conflicts with the ${effectivePlatform} platform constraint.`,
      {
        code: "JEV_ROUTE_MISMATCH",
        details: {
          requestedPlatform: effectivePlatform,
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
