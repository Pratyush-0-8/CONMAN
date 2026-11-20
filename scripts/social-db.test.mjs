import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { createLegacyFixture } from "./sql-fixture.mjs";

test("forward-only social migration, RLS and existing Arena/Daily/question SQL regressions", async () => {
  const db = new PGlite();
  try {
    await createLegacyFixture(db);
    // Match production's existing auth profile-creation trigger.
    await db.exec(`create function public.fixture_profile() returns trigger language plpgsql security definer set search_path='' as $$ begin insert into public.profiles(id,username) values(new.id,new.raw_user_meta_data->>'username'); return new; end $$;
      create trigger fixture_profile after insert on auth.users for each row execute function public.fixture_profile();`);
    const migrations = fs
      .readdirSync("supabase/migrations")
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of migrations)
      await db.exec(fs.readFileSync(`supabase/migrations/${file}`, "utf8"));
    for (const file of [
      "ranked.sql",
      "daily_five.sql",
      "daily_population.sql",
      "question_generation.sql",
      "social.sql",
      "answer_sync.sql",
      "daily_reliability.sql",
    ]) {
      await db.exec(fs.readFileSync(`supabase/tests/${file}`, "utf8"));
      console.log(`PASS ${file}`);
    }
    const { rows } =
      await db.query(`select has_function_privilege('anon','public.social_send_challenge(uuid,text)','execute') can_send,
      has_function_privilege('authenticated','public.social_available(uuid)','execute') can_spoof,
      has_column_privilege('authenticated','public.profiles','elo','update') can_rate`);
    assert.deepEqual(rows[0], { can_send: false, can_spoof: false, can_rate: false });
  } finally {
    await db.close();
  }
});
