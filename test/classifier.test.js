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
  assert.equal(result.modelVerified, true);
  assert.ok(Number.isSafeInteger(result.elapsedMs));
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
  const result = await classifySearch({ goal: "write a poem about social media", client });
  assert.equal(result.platform, null);
  assert.equal(result.route, "unsupported");
});

test("classifySearch constrains auto routing when the goal names one available platform", async () => {
  let request;
  const client = {
    async systemOne(value) {
      request = value;
      return {
        model: "laya:en",
        answers: {
          route: {
            type: "choice",
            choice: "tiktok_search",
            confidence: 0.61,
          },
        },
      };
    },
  };

  const result = await classifySearch({
    goal: "Research viral camera reviews on TikTok",
    requestedPlatform: "auto",
    client,
  });

  assert.equal(request.state.requested_platform, "tiktok");
  assert.equal(result.platform, "tiktok");
});

test("classifySearch leaves ambiguous, topical, and negated platform mentions for the decision provider", async () => {
  const goals = [
    "Compare creator reactions on TikTok and Instagram",
    "Search LinkedIn for posts about TikTok",
    "Do not use TikTok; find emerging creators",
    "I do not want you to search TikTok; find emerging creators",
    "Do not ever research LinkedIn; find founders",
    "Research TikTok trends on Instagram",
  ];
  const expectedRequestedPlatforms = ["auto", "linkedin", "auto", "auto", "auto", "instagram"];

  for (const [index, goal] of goals.entries()) {
    let request;
    const client = {
      async systemOne(value) {
        request = value;
        return {
          answers: {
            route: {
              type: "choice",
              choice: "unsupported",
              confidence: 0.82,
            },
          },
        };
      },
    };

    const result = await classifySearch({
      goal,
      requestedPlatform: "auto",
      client,
    });

    assert.equal(request.state.requested_platform, expectedRequestedPlatforms[index], goal);
    assert.equal(result.platform, null);
  }
});

test("a named but unavailable platform fails before any model call", async () => {
  let called = false;
  await assert.rejects(
    classifySearch({
      goal: "Find AI founders on LinkedIn",
      requestedPlatform: "auto",
      capabilities: { instagram: true, tiktok: true, linkedin: false },
      client: {
        async systemOne() {
          called = true;
          throw new Error("must not run");
        },
      },
    }),
    (error) => error.code === "SOCAI_CAPABILITY_MISSING" && error.details?.platform === "linkedin",
  );
  assert.equal(called, false);
});

test("classifySearch rejects clear account-changing requests before any model call", async () => {
  for (const goal of [
    "Post a promotional comment on Instagram",
    "Post photos on Instagram",
    "Publish to Instagram",
    "Please like this TikTok video",
    "Follow creators on TikTok",
    "Find the creator, then follow their account",
    "I want you to message this LinkedIn user",
    "Delete my Instagram post",
    "Repost this TikTok video",
    "Connect with this person on LinkedIn",
    "Update my Instagram bio",
    "Find the creator, then send them a DM",
    "Find the creator and leave a comment on their latest post",
    "Could you give this post a like?",
    "Please create a post on Instagram",
    "请帮我关注这个 Instagram 创作者",
  ]) {
    let called = false;
    await assert.rejects(
      classifySearch({
        goal,
        client: {
          async systemOne() {
            called = true;
            throw new Error("must not run");
          },
        },
      }),
      (error) => error.code === "UNSUPPORTED_TASK",
      goal,
    );
    assert.equal(called, false, goal);
  }
});

test("read-only post and comment nouns do not trigger the mutation guard", async () => {
  for (const goal of [
    "Find posts and comments about AI creators on Instagram",
    "Post performance and comment sentiment on Instagram",
    "Follow the discussion about AI creators on Instagram",
    "Follow creators' posting frequency on Instagram",
    "Research posts about how to publish on Instagram",
    "Like analytics reports, research creators on Instagram",
    "Post reach and engagement metrics on Instagram",
    "Post impressions by creator on Instagram",
  ]) {
    let called = false;
    const result = await classifySearch({
      goal,
      client: {
        async systemOne() {
          called = true;
          return {
            answers: {
              route: {
                type: "choice",
                choice: "instagram_search",
                confidence: 0.9,
              },
            },
          };
        },
      },
    });

    assert.equal(called, true, goal);
    assert.equal(result.platform, "instagram");
  }
});

test("an unsupported decision is preserved even when a positive platform hint exists", async () => {
  const result = await classifySearch({
    goal: "Research Instagram in a way the provider cannot support",
    client: {
      async systemOne() {
        return {
          answers: {
            route: { type: "choice", choice: "unsupported", confidence: 0.91 },
          },
        };
      },
    },
  });

  assert.equal(result.route, "unsupported");
  assert.equal(result.platform, null);
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
  await assert.rejects(classifySearch({ goal: "find creators", client }), (error) => {
    assert.equal(error.code, "INVALID_JEV_RESPONSE");
    assert.ok(Number.isSafeInteger(error.details?.elapsedMs));
    assert.equal(error.details?.model, "~typesafe/jev-latest");
    return true;
  });
});

test("failed Jev calls preserve monotonic attempt time without leaking provider details", async () => {
  await assert.rejects(
    classifySearch({
      goal: "find creators",
      model: "typesafe/jev-pinned",
      client: { async systemOne() { throw new Error("private provider detail"); } },
    }),
    (error) => {
      assert.equal(error.code, "JEV_UNAVAILABLE");
      assert.ok(Number.isSafeInteger(error.details?.elapsedMs));
      assert.equal(error.details?.model, "typesafe/jev-pinned");
      assert.equal(error.details?.modelVerified, false);
      return true;
    },
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
