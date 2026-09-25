import assert from "node:assert/strict";
import test from "node:test";
import {
  requestDecision,
  resolveDecisionProvider,
} from "../src/decision-provider.js";
import { classifySearch } from "../src/classifier.js";

const request = {
  model: "kev-latest",
  state: "Choose a platform",
  questions: {
    route: {
      type: "choice",
      criteria: { instagram_search: "Instagram", unsupported: "Unsupported" },
    },
  },
};

test("local System One provider accepts only an explicit loopback endpoint", () => {
  assert.deepEqual(
    resolveDecisionProvider({
      JEV_SOCIAL_SYSTEM_ONE_URL: "http://127.0.0.1:8009/v1/systemone",
      JEV_SOCIAL_SYSTEM_ONE_MODEL: "kev-latest",
      OPENROUTER_JEV_MODEL: "~typesafe/jev-latest",
    }),
    {
      kind: "local",
      endpoint: "http://127.0.0.1:8009/v1/systemone",
      model: "kev-latest",
      timeoutMs: 120_000,
    },
  );

  for (const endpoint of [
    "https://127.0.0.1:8009/v1/systemone",
    "http://example.com/v1/systemone",
    "http://127.0.0.1.evil.test/v1/systemone",
    "http://user:pass@127.0.0.1:8009/v1/systemone",
    "http://127.0.0.1:8009/other",
    "http://127.0.0.1:8009/v1/systemone?token=secret",
  ]) {
    assert.throws(
      () => resolveDecisionProvider({ JEV_SOCIAL_SYSTEM_ONE_URL: endpoint }),
      (error) => error.code === "INVALID_DECISION_PROVIDER",
      endpoint,
    );
  }

  assert.throws(
    () => resolveDecisionProvider({
      JEV_SOCIAL_SYSTEM_ONE_URL: "http://127.0.0.1:8009/v1/systemone",
      JEV_SOCIAL_SYSTEM_ONE_TIMEOUT_MS: "120001",
    }),
    (error) => error.code === "INVALID_DECISION_PROVIDER",
  );
});

test("classifySearch defaults to the resolved local provider model", async () => {
  const provider = resolveDecisionProvider({
    JEV_SOCIAL_SYSTEM_ONE_URL: "http://127.0.0.1:8009/v1/systemone",
    JEV_SOCIAL_SYSTEM_ONE_MODEL: "kev-local-test",
  });
  let sent;
  const result = await classifySearch({
    goal: "find art creators on Instagram",
    provider,
    fetchImpl: async (_url, options) => {
      sent = JSON.parse(options.body);
      return Response.json({
        model: "kev-local-test",
        answers: { route: { type: "choice", choice: "instagram_search", confidence: 0.99 } },
      });
    },
  });

  assert.equal(sent.model, "kev-local-test");
  assert.equal(result.model, "kev-local-test");
});

test("local System One requests never forward OpenRouter credentials", async () => {
  const provider = resolveDecisionProvider({
    JEV_SOCIAL_SYSTEM_ONE_URL: "http://localhost:8009/v1/systemone",
    JEV_SOCIAL_SYSTEM_ONE_MODEL: "kev-latest",
  });
  let observed;
  const response = await requestDecision({
    provider,
    apiKey: "must-not-be-forwarded",
    request,
    fetchImpl: async (url, options) => {
      observed = { url, options };
      return new Response(JSON.stringify({
        model: "kev-latest",
        answers: {
          route: { type: "choice", choice: "instagram_search", confidence: 0.92 },
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  assert.equal(observed.url, "http://localhost:8009/v1/systemone");
  assert.equal(observed.options.headers.Authorization, undefined);
  assert.equal(observed.options.redirect, "error");
  assert.deepEqual(JSON.parse(observed.options.body), request);
  assert.equal(response.model, "kev-latest");
});

test("decision providers fail closed on HTTP, JSON, and size errors", async () => {
  const provider = resolveDecisionProvider({
    JEV_SOCIAL_SYSTEM_ONE_URL: "http://[::1]:8009/v1/systemone",
  });
  const cases = [
    new Response(JSON.stringify({ error: { message: "unavailable" } }), { status: 503 }),
    new Response("not-json", { status: 200 }),
    new Response("x".repeat(256 * 1024 + 1), { status: 200 }),
  ];

  for (const response of cases) {
    await assert.rejects(
      requestDecision({ provider, request, fetchImpl: async () => response }),
      /unavailable|HTTP 503|invalid JSON|oversized response/,
    );
  }
});

test("local decision errors do not expose provider paths", async () => {
  const provider = resolveDecisionProvider({
    JEV_SOCIAL_SYSTEM_ONE_URL: "http://127.0.0.1:8009/v1/systemone",
  });

  await assert.rejects(
    requestDecision({
      provider,
      request,
      fetchImpl: async () => Response.json(
        { error: { message: "model failed at /Users/alice/.cache/kev/model.bin" } },
        { status: 500 },
      ),
    }),
    (error) => {
      assert.equal(error.message, "Local System One returned HTTP 500");
      assert.doesNotMatch(error.message, /Users|alice|model\.bin/);
      return true;
    },
  );
});

test("OpenRouter remains the default decision provider", () => {
  assert.deepEqual(resolveDecisionProvider({ OPENROUTER_JEV_MODEL: "typesafe/jev-test" }), {
    kind: "openrouter",
    model: "typesafe/jev-test",
  });
});

test("local decision requests retain a bounded timeout", async () => {
  const provider = resolveDecisionProvider({
    JEV_SOCIAL_SYSTEM_ONE_URL: "http://127.0.0.1:8009/v1/systemone",
  });
  await assert.rejects(
    requestDecision({
      provider,
      request,
      timeoutMs: 5,
      fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      }),
    }),
    (error) => error?.name === "TimeoutError",
  );
});

test("local decision timeout can exceed the OpenRouter limit but remains bounded", async () => {
  const provider = resolveDecisionProvider({
    JEV_SOCIAL_SYSTEM_ONE_URL: "http://127.0.0.1:8009/v1/systemone",
    JEV_SOCIAL_SYSTEM_ONE_TIMEOUT_MS: "30000",
  });
  assert.equal(provider.timeoutMs, 30_000);
  const response = await requestDecision({
    provider,
    request,
    fetchImpl: async () => Response.json({ answers: {} }),
  });
  assert.deepEqual(response, { answers: {} });
});
