import assert from "node:assert/strict";
import test from "node:test";
import { classifySearch } from "../src/classifier.js";

test("classifySearch routes a search with Jev's structured answer", async () => {
  let request;
  const client = {
    async systemOne(value) {
      request = value;
      return {
        model: "jev-test",
        answers: {
          route: {
            type: "choice",
            choice: "tiktok_search",
            confidence: 0.91,
            probabilities: { instagram_search: 0.04, tiktok_search: 0.94, unsupported: 0.02 },
          },
        },
      };
    },
  };

  const result = await classifySearch({
    goal: "find AI creators",
    requestedPlatform: "tiktok",
    client,
  });

  assert.equal(result.platform, "tiktok");
  assert.equal(result.route, "tiktok_search");
  assert.equal(request.state.requested_platform, "tiktok");
  assert.equal(request.questions.route.type, "choice");
});

test("classifySearch calls OpenRouter's Decisions endpoint", async () => {
  let url;
  let options;
  const result = await classifySearch({
    goal: "search Instagram for design systems",
    apiKey: String(101),
    fetchImpl: async (nextUrl, nextOptions) => {
      url = nextUrl;
      options = nextOptions;
      return new Response(
        JSON.stringify({
          model: "typesafe/jev-test",
          answers: { route: { type: "choice", choice: "instagram_search", confidence: 0.9 } },
          usage: {},
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });
  assert.equal(url, "https://openrouter.ai/api/alpha/decisions");
  assert.match(options.headers.Authorization, /^Bearer /);
  assert.equal(JSON.parse(options.body).model, "~typesafe/jev-latest");
  assert.equal(result.platform, "instagram");
});

test("classifySearch routes LinkedIn through the same typed choice", async () => {
  const client = {
    async systemOne() {
      return {
        answers: {
          route: {
            type: "choice",
            choice: "linkedin_search",
            confidence: 0.88,
            probabilities: { instagram_search: 0.04, tiktok_search: 0.03, linkedin_search: 0.88, unsupported: 0.05 },
          },
        },
      };
    },
  };
  const result = await classifySearch({
    goal: "find AI product managers in San Francisco",
    requestedPlatform: "linkedin",
    client,
  });
  assert.equal(result.platform, "linkedin");
  assert.equal(result.route, "linkedin_search");
});

test("classifySearch rejects unknown platforms before any model call", async () => {
  await assert.rejects(
    classifySearch({ goal: "query", requestedPlatform: "youtube", client: {} }),
    (error) => error.code === "INVALID_PLATFORM",
  );
});

test("classifySearch preserves Jev unsupported decisions", async () => {
  const client = {
    async systemOne() {
      return {
        answers: {
          route: {
            type: "choice",
            choice: "unsupported",
            confidence: 0.8,
            probabilities: { instagram_search: 0.1, tiktok_search: 0.1, unsupported: 0.8 },
          },
        },
      };
    },
  };
  const result = await classifySearch({ goal: "send a message", client });
  assert.equal(result.platform, null);
  assert.equal(result.route, "unsupported");
});

test("classifySearch never lets Jev override an explicit platform", async () => {
  const client = {
    async systemOne() {
      return {
        answers: {
          route: {
            type: "choice",
            choice: "tiktok_search",
            confidence: 0.9,
            probabilities: { instagram_search: 0.05, tiktok_search: 0.9, unsupported: 0.05 },
          },
        },
      };
    },
  };
  await assert.rejects(
    classifySearch({ goal: "find creators", requestedPlatform: "instagram", client }),
    (error) => error.code === "JEV_ROUTE_MISMATCH",
  );
});

test("classifySearch fails closed on a malformed Jev decision", async () => {
  const client = {
    async systemOne() {
      return { answers: { route: { type: "choice", choice: "tiktok_search" } } };
    },
  };
  await assert.rejects(
    classifySearch({ goal: "find creators", client }),
    (error) => error.code === "INVALID_JEV_RESPONSE",
  );
});

test("classifySearch dynamically filters workflows and route criteria based on capability set", async () => {
  let request;
  const client = {
    async systemOne(value) {
      request = value;
      return {
        answers: {
          route: { type: "choice", choice: "instagram_search", confidence: 0.9 },
        },
      };
    },
  };

  const capabilities = { instagram: true, tiktok: false, linkedin: false };
  const result = await classifySearch({
    goal: "find creators",
    requestedPlatform: "auto",
    capabilities,
    client,
  });

  assert.equal(result.platform, "instagram");
  assert.deepEqual(request.state.supported_workflows, [
    "Read-only Instagram search via the socai CLI",
  ]);
  assert.deepEqual(Object.keys(request.questions.route.criteria), [
    "instagram_search",
    "unsupported",
  ]);
});

test("classifySearch throws SOCAI_CAPABILITY_MISSING when requested platform is disabled in capabilities", async () => {
  let called = false;
  const client = {
    async systemOne() {
      called = true;
      return { answers: { route: { type: "choice", choice: "linkedin_search", confidence: 0.9 } } };
    },
  };

  const capabilities = { instagram: true, tiktok: true, linkedin: false };
  await assert.rejects(
    classifySearch({
      goal: "find product managers",
      requestedPlatform: "linkedin",
      capabilities,
      client,
    }),
    (error) => {
      assert.equal(error.code, "SOCAI_CAPABILITY_MISSING");
      assert.equal(error.details?.platform, "linkedin");
      return true;
    },
  );
  assert.equal(called, false, "Model must not be called when platform is not in capabilities");
});
