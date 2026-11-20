import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { createLegacyFixture } from "./sql-fixture.mjs";
import { inputDeadline, roundPhase, savedRoundTiming } from "../src/lib/rankedRules.ts";

test("new mode totals and legacy timing metadata remain stable across refresh/reconnect", () => {
  assert.equal(inputDeadline(0, "typing"), 45000);
  assert.equal(inputDeadline(0, "voice"), 35000);
  for (const mode of ["typing", "voice"]) {
    assert.equal(roundPhase(9999, 0, mode), "think");
    assert.equal(roundPhase(10000, 0, mode), "input");
    const end = inputDeadline(0, mode);
    assert.equal(roundPhase(end - 1, 0, mode), "input");
    assert.equal(roundPhase(end, 0, mode), "waiting");
    const saved = savedRoundTiming(0, end, 10);
    assert.equal(saved.inputStart, 10000);
    assert.equal(saved.answerSeconds, mode === "typing" ? 35 : 25);
  }
  assert.equal(savedRoundTiming(0, 25000).inputStart, 5000);
  assert.equal(savedRoundTiming(0, 25000).answerSeconds, 20);
  assert.equal(savedRoundTiming(0, 20000, 5).answerSeconds, 15);
  assert.equal(roundPhase(6000, 0, "typing", false, 5, 20), "input");
  assert.equal(inputDeadline(0, "voice", 5, 15), 20000);
});

test("forward timer migration preserves existing matches and every question of an already-started Daily attempt", async () => {
  const db = new PGlite();
  try {
    await createLegacyFixture(db);
    const target = "202611200002_gameplay_timers.sql";
    for (const file of fs
      .readdirSync("supabase/migrations")
      .filter((f) => f.endsWith(".sql") && f < target)
      .sort())
      await db.exec(fs.readFileSync("supabase/migrations/" + file, "utf8"));
    await db.exec(`insert into auth.users(id,email,email_confirmed_at) values('70000000-0000-4000-8000-000000000001','legacy-a@example.test',now()),('70000000-0000-4000-8000-000000000002','legacy-b@example.test',now());
   insert into public.profiles(id,username) values('70000000-0000-4000-8000-000000000001','legacy_a'),('70000000-0000-4000-8000-000000000002','legacy_b');
   insert into public.matches(id,player1_id,player2_id,mode,opponent_type,question,status,ranked_state,round_start) values('70000000-0000-4000-8000-000000000010','70000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000002','voice','human','Legacy timing','brainstorming','active',clock_timestamp()+interval '1 hour');
   insert into public.ranked_players(match_id,player_id,username,input_mode,deadline) select m.id,p.id,p.username,'typing',m.round_start+interval '25 seconds' from public.matches m cross join public.profiles p;
   insert into public.daily_challenges(challenge_date) values('2026-01-01');
   insert into public.daily_questions(challenge_date,position,question) select '2026-01-01',i,'Legacy daily '||i from generate_series(1,5) i;
   update public.daily_challenges set published=true where challenge_date='2026-01-01';
   insert into public.daily_attempts(id,token_hash,challenge_date,input_mode) values('70000000-0000-4000-8000-000000000020',repeat('a',64),'2026-01-01','typing');
   insert into public.daily_answers(attempt_id,position,started_at,deadline) values('70000000-0000-4000-8000-000000000020',1,clock_timestamp(),clock_timestamp()+interval '25 seconds');`);
    const query = `select (select jsonb_agg(to_jsonb(m)-'thinking_seconds') from public.matches m) matches,
   (select jsonb_agg(to_jsonb(a)-'thinking_seconds'-'typing_seconds'-'voice_seconds') from public.daily_attempts a) attempts,
   (select jsonb_agg(to_jsonb(r)) from public.ranked_players r) players,(select jsonb_agg(to_jsonb(r)) from public.daily_answers r) answers`;
    const before = (await db.query(query)).rows;
    await db.exec(fs.readFileSync("supabase/migrations/" + target, "utf8"));
    assert.deepEqual((await db.query(query)).rows, before);
    assert.equal(
      (await db.query("select thinking_seconds from public.matches")).rows[0].thinking_seconds,
      5,
    );
    assert.deepEqual(
      (
        await db.query(
          "select thinking_seconds,typing_seconds,voice_seconds from public.daily_attempts",
        )
      ).rows[0],
      { thinking_seconds: 5, typing_seconds: 20, voice_seconds: 15 },
    );
    await db.exec(
      `update public.daily_answers set state='graded',scores='{"Logic":8,"Creativity":8,"Relevance":8,"Clarity":8,"Depth":8}',total=40,locked_at=clock_timestamp() where position=1;select public.daily_next(repeat('a',64),1);`,
    );
    const next = (
      await db.query(
        "select extract(epoch from(deadline-started_at))::integer seconds from public.daily_answers where position=2",
      )
    ).rows[0];
    assert.equal(next.seconds, 25, "the legacy attempt keeps its original rules on Next");
  } finally {
    await db.close();
  }
});

test("actual Daily input renders server-supplied 10/35/25 phases and retains legacy timing", async () => {
  const vm = await import("node:vm"),
    ts = (await import("typescript")).default,
    rules = await import("../src/lib/rankedRules.ts");
  const exports = {},
    nodes = new Map(),
    stub = (name) => {
      if (!nodes.has(name))
        nodes.set(
          name,
          Object.defineProperty(() => {}, "name", { value: name }),
        );
      return nodes.get(name);
    };
  const sync = {
    text: "Editable answer",
    ready: true,
    done: false,
    finalizing: false,
    submitting: false,
    superseded: false,
    error: "",
    change: () => {},
    submit: () => {},
    retry: () => {},
  };
  const require = (name) =>
    name === "react"
      ? {
          useRef: (value) => ({ current: value }),
          useEffect: () => {},
          useState: (initial) => [initial, () => {}],
        }
      : name === "react/jsx-runtime"
        ? { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }
        : name === "../lib/rankedRules"
          ? rules
          : name === "../lib/useAnswerSync"
            ? { useAnswerSync: () => sync }
            : name === "../lib/dailyService"
              ? { dailyAnswerTransport: () => ({}) }
              : new Proxy({}, { get: (_, key) => stub(String(key)) });
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync("src/screens/DailyFive.tsx", "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    }).outputText,
    { exports, require, Date, Math },
  );
  const find = (node, name) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const c of node) {
        const value = find(c, name);
        if (value) return value;
      }
    } else if (node.type?.name === name) return node;
    else return find(node.props?.children, name);
  };
  const render = (mode, now, thinking, end) =>
    exports.DailyInput({
      round: {
        position: 1,
        started_at: new Date(0).toISOString(),
        deadline: new Date(end).toISOString(),
        thinking_seconds: thinking,
        answer_text: "",
      },
      mode,
      now,
      token: "private-test",
      attemptId: "test",
      onRefresh: async () => {},
    });
  assert.equal(find(render("typing", 0, 10, 45000), "CountdownRing").props.total, 10);
  assert.equal(find(render("typing", 10000, 10, 45000), "CountdownRing").props.total, 35);
  assert.equal(find(render("voice", 10000, 10, 35000), "VoiceInput").props.totalSeconds, 25);
  assert.equal(find(render("typing", 5000, 5, 25000), "CountdownRing").props.total, 20);
  assert.equal(find(render("voice", 5000, 5, 20000), "VoiceInput").props.totalSeconds, 15);
});
