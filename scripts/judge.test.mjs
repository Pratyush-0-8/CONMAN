import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as providers from '../supabase/functions/_shared/judgeProvider.ts';
import * as judge from "../supabase/functions/_shared/judge.ts";

const matchId = "10000000-0000-4000-8000-000000000001";
const scores = { Logic: 8, Creativity: 7, Relevance: 8, Clarity: 7, Depth: 8 };
function endpoint({
  claim = {},
  malformed = false,
  groqFailure = false,
  finalizationRetry = false,
} = {}) {
  let handler,
    groqCalls = 0,
    finalized = 0,
    failed = 0;
  const content = fs.readFileSync(
    new URL("../supabase/functions/clever-action/index.ts", import.meta.url),
    "utf8",
  );
  const code = ts.transpileModule(content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, {
    exports: {},
    require: (name) => name.endsWith('/judgeProvider.ts') ? providers : judge,
    Response,
    Request,
    AbortSignal,
    Deno: {
      env: { get: (key) => ({ SUPABASE_URL:'https://test.supabase.co', AZURE_OPENAI_ENDPOINT:'https://test.services.ai.azure.com', AZURE_OPENAI_DEPLOYMENT:'gpt-4.1-mini' }[key] || 'test-secret') },
      serve: (fn) => {
        handler = fn;
      },
    },
    fetch: async (url, options) => {
      if (url.endsWith("/auth/v1/user"))
        return Response.json({ id: "player1", email_confirmed_at: "2026-01-01" });
      if (url.includes("/ranked_players?")) return Response.json([{ match_id: matchId }]);
      if (url.endsWith("/ranked_claim"))
        return Response.json({
          answers_confirmed: true,
          token: "token",
          player1_id: "player1",
          player2_id: "player2",
          question: "Question?",
          answers: { player1: "real first", player2: "real second" },
          ...claim,
        });
      if (url.includes("api.groq.com") || url.includes("services.ai.azure.com")) {
        groqCalls++;
        assert.equal(JSON.parse(options.body).model, url.includes("api.groq.com") ? judge.MODEL : "gpt-4.1-mini");
        return groqFailure
          ? new Response("", { status: 429 })
          : Response.json({
              choices: [
                {
                  message: {
                    content: malformed
                      ? '{"winner":"player1"}'
                      : JSON.stringify({ player1: { scores }, player2: { scores } }),
                  },
                },
              ],
            });
      }
      if (url.endsWith("/ranked_finalize")) {
        const body = JSON.parse(options.body);
        for (const value of [body.p_scores1, body.p_scores2]) {
          assert.deepEqual(Object.keys(value).sort(), [...judge.CATEGORIES].sort());
          assert.ok(
            Object.values(value).every(
              (score) => Number.isInteger(score) && score >= 0 && score <= 10,
            ),
          );
        }
        finalized++;
        if (finalizationRetry && finalized === 1) return new Response("", { status: 503 });
        return Response.json({
          model: judge.MODEL,
          winner: "draw",
          player1: { scores, total: 38 },
          player2: { scores, total: 38 },
          decisiveCategory: "Balanced",
        });
      }
      if (url.endsWith("/ranked_judge_failed")) {
        failed++;
        return Response.json(null);
      }
      throw new Error("Unexpected fetch");
    },
  });
  return {
    call: (body) =>
      handler(
        new Request("https://test/clever-action", {
          method: "POST",
          headers: { Authorization: "Bearer user-token", "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      ),
    counts: () => ({ groqCalls, finalized, failed }),
  };
}
test("one joint primary request and database-only retry", async () => {
  const api = endpoint({ finalizationRetry: true });
  const response = await api.call({ matchId });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).winner, "draw");
  assert.deepEqual(api.counts(), { groqCalls: 1, finalized: 2, failed: 0 });
});
test("completed and claimed matches never call a provider again", async () => {
  for (const claim of [{ complete: true, result: { winner: "draw" } }, { busy: true }]) {
    const api = endpoint({ claim });
    await api.call({ matchId });
    assert.equal(api.counts().groqCalls, 0);
  }
});
test("malformed output or rate limits do not finalize or fabricate scores", async () => {
  for (const options of [{ malformed: true }, { groqFailure: true }]) {
    const api = endpoint(options);
    assert.equal((await api.call({ matchId })).status, 503);
    assert.deepEqual(api.counts(), { groqCalls: options.groqFailure ? 2 : 1, finalized: 0, failed: 1 });
  }
});
test("arbitrary frontend answers are rejected", async () => {
  const api = endpoint();
  assert.equal((await api.call({ matchId, player1Answer: "untrusted" })).status, 400);
  assert.equal(api.counts().groqCalls, 0);
});

test("Arena refuses an unconfirmed or missing persisted final instead of grading a fabricated empty answer", async () => {
  for (const claim of [
    { answers_confirmed: false },
    { answers: { player1: null, player2: "real" } },
    { answers: { player1: "real" } },
  ]) {
    const api = endpoint({ claim });
    assert.equal((await api.call({ matchId })).status, 503);
    assert.equal(api.counts().groqCalls, 0);
    assert.equal(api.counts().finalized, 0);
  }
});
