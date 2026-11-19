// Explicit opt-in only: this script requires a NEW EMPTY, disposable localhost database.
// Example: CONMAN_TEST_DATABASE_URL=postgres://.../conman_multiplayer_test npm run test:concurrency
import assert from "node:assert/strict";
import fs from "node:fs";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { createLegacyFixture } from "./sql-fixture.mjs";

const url = new URL(process.env.CONMAN_TEST_DATABASE_URL || "postgres://invalid");
assert.ok(
  ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
  "Only disposable localhost databases are permitted",
);
assert.match(
  url.pathname,
  /^\/conman_multiplayer_test(?:_[a-zA-Z0-9]+)?$/,
  "Database name must begin conman_multiplayer_test",
);
const connections = [],
  admin = new Client({ connectionString: url.href, application_name: "conman-test-admin" });
await admin.connect();
connections.push(admin);
const sql = async (text, args = []) => (await admin.query(text, args)).rows;
const connect = async (id, name, role = "authenticated") => {
  const client = new Client({ connectionString: url.href, application_name: name });
  await client.connect();
  connections.push(client);
  await client.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  await client.query(`set role ${role}`);
  return {
    client,
    name,
    rpc: async (name, args = []) =>
      (
        await client.query(
          `select public.${name}(${args.map((_, i) => "$" + (i + 1)).join(",")}) result`,
          args,
        )
      ).rows[0].result,
  };
};
const waitForLocks = async (names) => {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const [{ count }] = await sql(
      "select count(*)::int from pg_stat_activity where application_name=any($1) and state='active' and wait_event_type='Lock'",
      [names],
    );
    if (count === names.length) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error("Requests did not overlap on independent PostgreSQL connections");
};
const overlap = async (names, lock, operations) => {
  await admin.query("begin");
  await admin.query(lock);
  const requests = operations.map((fn) => fn());
  // Attach rejection handlers immediately; still assert each result after releasing the barrier.
  const results = Promise.all(requests);
  try {
    await waitForLocks(names);
  } finally {
    await admin.query("commit");
  }
  return results;
};
try {
  assert.equal(
    (
      await sql(
        "select count(*)::int count from information_schema.tables where table_schema in ('public','auth')",
      )
    )[0].count,
    0,
    "Refuse to run fixtures on a populated database",
  );
  await createLegacyFixture({ exec: (query) => admin.query(query) });
  await admin.query(`create function public.fixture_profile() returns trigger language plpgsql security definer set search_path='' as $$ begin insert into public.profiles(id,username) values(new.id,new.raw_user_meta_data->>'username'); return new; end $$;
 create trigger fixture_profile after insert on auth.users for each row execute function public.fixture_profile();`);
  for (const file of fs
    .readdirSync("supabase/migrations")
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await admin.query(fs.readFileSync("supabase/migrations/" + file, "utf8"));
  for (const file of [
    "ranked.sql",
    "daily_five.sql",
    "daily_population.sql",
    "question_generation.sql",
    "social.sql",
    "answer_sync.sql",
  ]) {
    await admin.query(fs.readFileSync("supabase/tests/" + file, "utf8"));
    console.log("PASS native PostgreSQL suite", file);
  }
  const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
  for (const [id, name] of [
    [a, "concurrent_a"],
    [b, "concurrent_b"],
    [c, "concurrent_c"],
  ])
    await admin.query(
      "insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values($1,$2,now(),$3)",
      [id, name + "@example.test", JSON.stringify({ username: name })],
    );
  const A = await connect(a, "conman-test-a"),
    A2 = await connect(a, "conman-test-a2"),
    B = await connect(b, "conman-test-b"),
    B2 = await connect(b, "conman-test-b2"),
    C = await connect(c, "conman-test-c");
  const S1 = await connect(a, "conman-test-service1", "service_role"),
    S2 = await connect(b, "conman-test-service2", "service_role");
  await A.rpc("social_follow", [b, true]);
  await B.rpc("social_follow", [a, true]);
  await A.rpc("social_heartbeat", [randomUUID(), true]);
  await B.rpc("social_heartbeat", [randomUUID(), true]);
  const cid = await A.rpc("social_send_challenge", [b, "typing"]);
  const [one, two] = await overlap([B.name, B2.name], "select pg_advisory_xact_lock(214734601)", [
    () => B.rpc("social_respond_challenge", [cid, "accept", "voice"]),
    () => B2.rpc("social_respond_challenge", [cid, "accept", "voice"]),
  ]);
  assert.equal(one, two);
  assert.ok(one);
  assert.equal(
    (await sql("select count(*)::int count from public.ranked_players where match_id=$1", [one]))[0]
      .count,
    2,
  );
  console.log("PASS concurrent friend acceptance: exactly one shared two-player match");
  const [{ question }] = await sql("select question from public.matches where id=$1", [one]);
  assert.equal((await A.rpc("ranked_state")).match.question, question);
  assert.equal((await B.rpc("ranked_state")).match.question, question);
  assert.equal(await A.rpc("ranked_queue_match", ["typing", true]), one);
  const finish = async (mid, ranked) => {
    const before = await sql(
      "select id,elo,wins,losses,draws from public.profiles where id=any($1) order by id",
      [[a, b]],
    );
    const wa = randomUUID(),
      wb = randomUUID();
    await A.rpc("ranked_begin_answer", [mid, wa, null]);
    await B.rpc("ranked_begin_answer", [mid, wb, null]);
    await admin.query(
      "update public.matches set round_start=clock_timestamp()-interval '6 seconds' where id=$1",
      [mid],
    );
    const rowLock = `select id from public.matches where id='${mid}' for update`;
    await overlap([A.name, A2.name], rowLock, [
      () => A.rpc("ranked_answer_v2", [mid, "Newest draft", false, 2, wa]),
      () => A2.rpc("ranked_answer_v2", [mid, "Delayed old draft", false, 1, wa]),
    ]);
    assert.equal(
      (
        await sql(
          "select answer_text from public.ranked_drafts where match_id=$1 and player_id=$2",
          [mid, a],
        )
      )[0].answer_text,
      "Newest draft",
    );
    await overlap([A.name, A2.name], rowLock, [
      () => A.rpc("ranked_answer_v2", [mid, "Latest final edit", true, 4, wa]),
      () => A2.rpc("ranked_answer_v2", [mid, "Older autosave", false, 3, wa]),
    ]);
    await A.rpc("ranked_answer_v2", [mid, "Conflicting final retry", true, 5, wa]);
    assert.equal(
      (
        await sql(
          "select count(*)::int count,min(answer_text) answer_text from public.match_answers where match_id=$1 and player_id=$2",
          [mid, a],
        )
      )[0].count,
      1,
    );
    assert.equal(
      (
        await sql(
          "select answer_text from public.ranked_drafts where match_id=$1 and player_id=$2",
          [mid, a],
        )
      )[0].answer_text,
      "Latest final edit",
    );
    const state = await B.rpc("ranked_state", [mid]);
    assert.equal(state.match.players.find((p) => p.player_id === a).answer_text, null);
    await B.rpc("ranked_answer_v2", [mid, "Own independent answer", true, 1, wb]);
    const claims = await overlap([S1.name, S2.name], rowLock, [
      () => S1.rpc("ranked_claim", [mid, a]),
      () => S2.rpc("ranked_claim", [mid, b]),
    ]);
    assert.equal(claims.filter((x) => x.token).length, 1);
    assert.equal(claims.filter((x) => x.busy).length, 1);
    const token = claims.find((x) => x.token).token,
      scores1 = { Logic: 8, Creativity: 8, Relevance: 8, Clarity: 8, Depth: 8 },
      scores2 = { Logic: 6, Creativity: 6, Relevance: 6, Clarity: 6, Depth: 6 };
    const finalized = await overlap([S1.name, S2.name], rowLock, [
      () => S1.rpc("ranked_finalize", [mid, token, scores1, scores2, "test"]),
      () => S2.rpc("ranked_finalize", [mid, token, scores1, scores2, "test"]),
    ]);
    assert.deepEqual(finalized[0], finalized[1]);
    const after = await sql(
      "select id,elo,wins,losses,draws from public.profiles where id=any($1) order by id",
      [[a, b]],
    );
    if (!ranked) assert.deepEqual(after, before);
    else {
      const [{ player1_id }] = await sql("select player1_id from public.matches where id=$1", [
        mid,
      ]);
      for (const row of after) {
        const old = before.find((p) => p.id === row.id),
          win = row.id === player1_id;
        assert.equal(row.elo, old.elo + (win ? 16 : -16));
        assert.equal(row.wins, old.wins + (win ? 1 : 0));
        assert.equal(row.losses, old.losses + (win ? 0 : 1));
      }
    }
    assert.equal((await A.rpc("ranked_state")).match.state, "complete");
    assert.equal((await B.rpc("ranked_state")).match.state, "complete");
    await A.rpc("ranked_release", [mid]);
    await B.rpc("ranked_release", [mid]);
    console.log(
      `PASS ${ranked ? "ranked" : "unranked"} concurrent draft/final ordering, privacy, one judge claim, one finalization, ELO and both-player recovery`,
    );
  };
  await finish(one, false);
  await A.rpc("ranked_queue_match", ["typing", true]);
  const ranked = await B.rpc("ranked_queue_match", ["voice", true]);
  assert.ok(ranked);
  await finish(ranked, true);
  // Ranked pairing and accepting a pending friend invite share the same global arbitration lock.
  await A.rpc("social_heartbeat", [randomUUID(), true]);
  await B.rpc("social_heartbeat", [randomUUID(), true]);
  const competing = await A.rpc("social_send_challenge", [b, "typing"]);
  await C.rpc("ranked_queue_match", ["typing", true]);
  const [queueResult, challengeResult] = await overlap(
    [A.name, B.name],
    "select pg_advisory_xact_lock(214734601)",
    [
      () => A.rpc("ranked_queue_match", ["typing", true]),
      () => B.rpc("social_respond_challenge", [competing, "accept", "typing"]),
    ],
  );
  const active = await sql(
    "select match_id from public.ranked_players where player_id=$1 and released_at is null",
    [a],
  );
  assert.equal(active.length, 1);
  assert.equal(active[0].match_id, queueResult);
  if (challengeResult) assert.equal(challengeResult, queueResult);
  console.log(
    "PASS ranked pairing versus friend acceptance: one active match under overlapping requests",
  );
  console.log(
    "PASS all native multiplayer concurrency checks (independent PostgreSQL connections)",
  );
} finally {
  await Promise.allSettled(connections.map((client) => client.end()));
}
