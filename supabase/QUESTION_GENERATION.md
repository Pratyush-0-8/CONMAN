# Automated question generation

Backend-only question supply for CONMAN (`qoonotocfbwarkjqjxwl`). The original migration was applied previously; the operator reported successful five/ten-question Cloudflare dry runs. Those calls did not insert inventory.

## Verified deployment status — November 18, 2026 (Eastern)

- Applied only `202611180002_question_rotation.sql` to CONMAN using the authenticated administrative SQL API. Live definitions confirm the 150-question cap, six-hour gate, and shared pairing lock. Earlier migrations were neither edited nor replayed.
- Deployed only `generate-questions`, now **version 4 / ACTIVE**. Its unauthenticated endpoint returns HTTP 401. Authenticated dry runs of this version and real question-variety review remain pending.
- Live inventory: **0 unused Daily questions; 6 active Arena questions**. Published November 17, 18, and 19 challenges each contain five questions; they were preserved.
- All three application jobs remain **disabled**. Vault is installed but empty; `pg_cron` and `pg_net` are not installed. No Cron schedules or nightly automatic publication are active. No Cloudflare requests were made during this deployment, and the recorded request count is zero; authoritative account usage was not inspected.
- **Immediate blocker:** save the existing Edge `QUESTION_GENERATION_SECRET` in CONMAN Vault as `conman_question_generation_secret` using the dashboard. Edge secrets cannot be read back from the management API. Do not paste the value into chat or SQL source, change it independently, or substitute a client key. Also create Vault `conman_project_url` with `https://qoonotocfbwarkjqjxwl.supabase.co`. Then perform the authenticated dry runs, incremental fills, and checked activation below. The pipeline is deployed but launch is incomplete.
- The live project has **no `supabase_migrations.schema_migrations` ledger** (earlier changes used SQL-editor deployment). This update followed that same targeted SQL workflow. Do not run a broad `db push`: first reconcile recorded migration history against the actual schema. No earlier versions were speculatively marked applied.

These are point-in-time observations; rerun the inventory and monitoring queries before resuming launch.

## Architecture and files

- `migrations/202611180001_question_generation.sql`: shared historical duplicate catalog, persistent FIFO, generation jobs/leases, request budgets and audit tables, transactional publication and rotation. Jobs start **disabled**.
- `migrations/202611180002_question_rotation.sql`: forward-only replacement of the Arena claim/commit functions: 150 active questions and six-hour UTC boundaries. Updates an existing known Cron schedule in place, preserving its active state; creates/enables no jobs and retires no inventory during migration.
- `functions/generate-questions/index.ts`: one server/operator endpoint with independently claimed actions. A strong invocation secret is required; anon/publishable keys and player JWTs do not authorize it.
- `functions/_shared/questionPrompt.ts`: editable style prompt, six small local inspiration palettes sampled afresh per model attempt, structured-batch validation, normalized exact and lexical near-duplicate checks. Inspiration is optional; the prompt mixes choices, inventions, predictions, explanations, and persuasion instead of repeating business puzzles.
- `functions/_shared/cloudflareAI.ts`: reusable Workers AI REST client, bounded context, timeouts, usage/error handling, configurable model. Preserve the verified Gemma payload: thinking disabled, `max_tokens: 4096`, `temperature: 0.7`, and a 70-second fetch timeout.
- `config.toml`: adds only `generate-questions`; gateway JWT verification is disabled because the handler validates the separate invocation secret.
- `cron/activate_question_generation.sql`: opt-in setup template. It registers **inactive** schedules only; activation is a separate manual step.
- `tests/question_generation.sql`, `tests/question_rotation_upgrade.sql`, `scripts/question-generation.test.mjs`: rollback-only database checks and mocked client/endpoint tests.

Daily Five still reads `daily_challenges`/`daily_questions` by assigned date. No changes to gameplay, judging, answers, ELO, profiles, or frontend are required.

### Arena compatibility

The inspected schema stores the question text directly in each match; the six original `ranked_questions` rows have stable bigint IDs. The migration renames that table to `ranked_question_bank`, preserving IDs, constraints, identity sequence ownership, and any existing FK references. **`ranked_questions` becomes an automatically updatable active-only compatibility view**, exposing the same `id, question` columns. The matchmaking function itself is unchanged. Retired rows remain in the bank indefinitely; no questions are deleted.

Existing active rows are incorporated. Filling adds ten at a time without retirement while below capacity; the first batch crossing 150 retires only its excess (e.g. 146 + 10 retires six). Later successful rotations add ten and retire ten oldest eligible rows. If a legacy pool already exceeds 150, the first successful rotation must retire its excess plus ten; it fails atomically if that cannot be done safely. Inspect such a pool before launch. The migration itself never trims it. Questions used by unfinished matches are protected. If too few old rows can safely retire, the transaction rejects the whole change and keeps the old pool. Pairing and rotation share the existing pairing advisory lock, so a new match cannot select a question concurrently being retired. Historical matches retain their snapshots and any FK identities remain valid.

Review your live schema before applying: if other code depends on `ranked_questions` specifically being a table, or joins retired records through that name, update those consumers to use the backing bank. Read-only preflight:

```sql
select conrelid::regclass as referencing_table, conname, pg_get_constraintdef(oid)
from pg_constraint where confrelid='public.ranked_questions'::regclass;
```

## Deployment to CONMAN

1. Confirm the linked/live project is **CONMAN, `qoonotocfbwarkjqjxwl`**. Inspect the live `qgen_claim`, `qgen_commit_batch`, `ranked_queue_match`, bank/view, foreign keys, migration history, inventory, published challenges, and all existing Cron commands before writing. The original `202611180001_question_generation.sql` is already applied: **do not edit or rerun it**. Apply only `migrations/202611180002_question_rotation.sql`. With CLI migration history, first use `supabase migration list --linked` and `supabase db push --linked --dry-run`; proceed with `supabase db push --linked` only if the sole pending migration is `202611180002_question_rotation.sql`. If earlier SQL-editor migrations are absent from history, reconcile their applied status against the actual schema first; never let `db push` replay them. The new migration preserves function identities/grants, all question/match/FIFO data, leases and quotas. It changes the Arena due gate and the known Cron job's timing, if installed.
2. Keep the already-configured `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` secrets. The token needs Workers AI Run access for the chosen account. Reuse the existing `QUESTION_GENERATION_SECRET` in Supabase Edge secrets. Do not rotate it independently of the corresponding Vault entry. Never put any of these values in Vite variables, repository files, URLs, or Cron SQL.
3. Optional server secret: `QUESTION_GENERATION_MODEL` (default `@cf/google/gemma-4-26b-a4b-it`). Pick a JSON-capable Workers AI model permitted by your account/plan. There is no automatic paid fallback or upgrade. The normal Supabase Edge server environment supplies `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
4. Deploy exactly this function:

```sh
supabase functions deploy generate-questions --project-ref qoonotocfbwarkjqjxwl
```

No Cloudflare Worker deployment or Groq function update is needed.

## Safe connectivity and dry-run test

Use local environment variables `CONMAN_PROJECT_URL` and `CONMAN_GENERATION_SECRET` populated securely with your project URL and invocation secret. Do not commit their values.

```sh
curl --fail-with-body "$CONMAN_PROJECT_URL/functions/v1/generate-questions" \
  -H "Authorization: Bearer $CONMAN_GENERATION_SECRET" \
  -H 'Content-Type: application/json' \
  --data '{"action":"dry_run","target":"daily"}'
```

Use `"target":"arena"` for ten questions. Inspect `questions`, `model`, and `usage`. Dry-run makes **one** intended Cloudflare call and does not insert questions, claim jobs, write logs, or modify any database table. It reads the recorded budget/cooldown first. **Because strict dry-run writes nothing, it does not increment the persisted request counter or record a new provider quota error.** It still consumes real Cloudflare allocation. Keep manual dry-run calls controlled; normal scheduled/manual insertion jobs reserve and audit every request atomically. Live model/JSON support and plan access must be verified using this test, not inferred from mocked tests.

## Manual FIFO insertion and inspection

Use the SQL editor as the database owner (or a secure service connection), never browser roles. The following example inserts one unassigned question; replace it if it is already in your catalog:

```sql
select public.qgen_enqueue_manual(jsonb_build_array(
  'Why might a town paint its busiest crossroads differently each week, despite the extra work?'
));
```

You may pass 1–50 questions in one array. The entire array must validate and be distinct from the historical catalog. FIFO IDs determine order, including ties in timestamps. Consumed rows are retained; manual stock may exceed 35 and is never trimmed.

```sql
-- Unused inventory, oldest first.
select q.id, c.question, q.enqueued_at, q.source
from public.daily_question_queue q join public.question_catalog c on c.id=q.catalog_id
where q.consumed_date is null order by q.id;
select count(*) as unused from public.daily_question_queue where consumed_date is null;
-- Historical assignments remain inspectable.
select q.id,q.consumed_date,q.consumed_position,c.question
from public.daily_question_queue q join public.question_catalog c on c.id=q.catalog_id
where q.consumed_date is not null order by q.consumed_date,q.consumed_position;
```

## Controlled initial filling

Enabling an application job permits manual invocations; it does not create/activate Cron:

```sql
update public.question_generation_jobs set enabled=true where job='arena_rotate';
```

Trigger **one** ten-question initial-fill batch:

```sh
curl --fail-with-body "$CONMAN_PROJECT_URL/functions/v1/generate-questions" \
  -H "Authorization: Bearer $CONMAN_GENERATION_SECRET" -H 'Content-Type: application/json' \
  --data '{"action":"arena_fill"}'
```

Inspect the count, then repeat deliberately until it reaches 150 (a six-row pool needs 15 successful batches). A full pool returns a skip without calling Cloudflare. `arena_rotate` is the normal scheduled action; an authenticated `"force":true` can run one controlled rotation outside its due window.

```sql
select count(*) as active from public.ranked_questions;
select id,question from public.ranked_questions order by id;
select id,question,created_at,retired_at from public.ranked_question_bank
where retired_at is not null order by retired_at desc,id;
```

For initial Daily inventory, enable `daily_refill`, then invoke `{"action":"daily_refill","force":true}` in the same curl command. Each invocation adds at most one batch of five; repeat up to seven successful batches from empty. At 35 or more it skips with no API call. A partially filled reserve persists an open refill cycle, continued by subsequent five-minute scheduler invocations.

## Publishing and recovery

Publishing requires `daily_publish` enabled and never calls Cloudflare. Its normal action is `{"action":"daily_publish"}`. At/after **23:30 Eastern** it targets tomorrow. Before 23:30 it checks today's challenge as a safe recovery of the previous night's failure. UTC/DST offsets are derived in PostgreSQL using `America/New_York`; no hardcoded UTC offset is used.

If the selected date already has five published questions, it succeeds/skips without changes. Otherwise one transaction consumes the five oldest unused questions, writes positions 1–5, and publishes the complete date. Retries and simultaneous calls cannot consume them twice. Fewer than five fails without any partial assignment. To recover: replenish or manually enqueue, then retry publishing. A manually started but unpublished challenge with existing questions is left untouched and must be finished manually.

For explicit operator recovery/preparation of today or tomorrow, use `{"action":"daily_publish","force":true,"date":"YYYY-MM-DD"}`. Complete published challenges are never overwritten. The FIFO publisher does not backfill new historical challenges or change completed attempts/scores.

## Activate three independent schedules (only after testing)

1. Enable Supabase Cron (`pg_cron`), `pg_net`, and Vault through your dashboard after authenticating and reviewing the deployed dry runs. Vault is already installed in CONMAN.
2. Create missing Vault entries **using the dashboard** named `conman_project_url` and `conman_question_generation_secret` (same secret as Edge). Values are never embedded in repository SQL or `cron.job.command`.
3. In one SQL editor session, deliberately execute `set conman.allow_question_cron_setup='yes';`, then the entire `cron/activate_question_generation.sql` template. Its guard prevents accidental setup; all three registered jobs are inactive at commit. Use stop-on-error if executing via psql.
4. Enable and activate only the desired job(s):

```sql
-- A: true 10-hour refill checks, with 5-minute polling/continuation/recovery.
update public.question_generation_jobs set enabled=true where job='daily_refill';
select cron.alter_job((select jobid from cron.job where jobname='conman-daily-refill'),active:=true);
-- B: 23:30 Eastern publication and safe catch-up checks.
update public.question_generation_jobs set enabled=true where job='daily_publish';
select cron.alter_job((select jobid from cron.job where jobname='conman-daily-publish'),active:=true);
-- C: one ten-question rotation every six hours, at 00:00/06:00/12:00/18:00 UTC.
update public.question_generation_jobs set enabled=true where job='arena_rotate';
select cron.alter_job((select jobid from cron.job where jobname='conman-arena-rotate'),active:=true);
```

A's persisted `next_due_at` is ten elapsed hours from the check cycle start, including across midnight; it does **not** use `0 */10 * * *`. An open cycle continues one batch per poll until 35. B polls every five UTC minutes, selects the proper Eastern target, and skips completed publication. C uses `0 */6 * * *` and the next six-hour UTC boundary, independent of request completion time. It adds ten per scheduled invocation, filling without premature retirement until the 150 cap, then rotating ten. The initial fill remains an explicitly paced manual operation rather than a faster recurring schedule. Leases prevent overlapping workers. Recovery after failures uses a fifteen-minute job cooldown (plus any provider cooldown), with at most three model requests per batch.

Pause any job independently by setting its `enabled=false` and/or its Cron `active=false`. Disabling generation does not delete stock, archive questions, or unpublish challenges.

## Limits and monitoring

The account-wide default is **80 model requests per UTC day**, including failed/network attempts reserved before fetch. Configure it without a code deploy:

```sql
update public.question_generation_settings set daily_request_limit=80 where singleton;
select * from public.question_generation_jobs;
select * from public.question_generation_settings;
select job,model,status,started_at,finished_at,inserted_count,error,details
from public.question_generation_runs order by started_at desc limit 30;
select model,started_at,finished_at,http_status,generated_count,accepted_count,usage,error,provider_request_id
from public.question_generation_requests order by started_at desc limit 50;
select (started_at at time zone 'UTC')::date as utc_day,model,count(*) as requests,
       sum(accepted_count) as inserted_questions
from public.question_generation_requests group by 1,2 order by 1 desc;
```

Cloudflare daily allocation errors stop all recorded model requests until the next UTC day; 429/capacity errors persist a shared cooldown. HTTP auth/plan/model errors fail without aggressive retries or paid fallback. Actual neuron/token usage depends on model/account availability; usage is saved when supplied, otherwise remains null. Inspect the Cloudflare dashboard for the authoritative allocation/billing totals. Request count limits are not a currency/neuron cost guarantee.

Before activating Cron, run one authenticated Daily dry run and one Arena dry run against the deployed function and inspect their actual content for variety. Then read inventory and existing published challenges:

```sql
select public.qgen_context();
select challenge_date,published,count(q.position) as questions
from public.daily_challenges c left join public.daily_questions q using(challenge_date)
group by challenge_date,published order by challenge_date desc limit 10;
select jobid,jobname,schedule,active,command from cron.job;
```

Enable the application jobs, then fill incrementally using `daily_refill` with `force:true` (five per invocation) and `arena_fill` (ten per invocation). Inspect counts after each successful response; pause at least five seconds between invocations. Stop on quota, billing/auth, unexpected database or provider failures; do not keep forcing retries or raise limits. At most seven Daily and fifteen Arena successful batches are needed from empty/six; skip generation if stock is sufficient. Existing reserves need fewer calls. Leave manual inventory above 35 intact.

With correct Vault entries already provisioned through the dashboard, install the guarded Cron template (or inspect/alter existing jobs instead of adding duplicates). Activate only the three checked jobs. Check the authenticated Cron path using `select public.qgen_cron_invoke('daily_publish');`, then verify the returned request ID in `net._http_response` has HTTP 200 and the expected publication/already-published response. This controlled call publishes today's challenge only if absent, or tomorrow after 23:30 Eastern, using FIFO; it does not overwrite a published challenge. Refill toward 35 again if publication consumed five. A full-reserve controlled `daily_refill` invocation should skip without model usage. Confirm active schedules and the latest generation run/inventory, and inspect a subsequent real Cron execution before declaring scheduled dispatch verified.

Cron SQL success only means the HTTP request was queued. Inspect both `cron.job_run_details` and `net._http_response`/Edge logs for HTTP failures:

```sql
select jobid,jobname,schedule,active,command from cron.job where jobname like 'conman-%';
select jobid,status,start_time,end_time,return_message from cron.job_run_details order by start_time desc limit 30;
select id,status_code,timed_out,error_msg,created from net._http_response order by created desc limit 30;
```

Each invocation has a 110-second work budget; it does not start another model attempt without enough time remaining. Leases expire after four minutes. An interrupted worker may have spent a Cloudflare request without committing questions; its reservation still counts. If inventory is low or a rotation fails safety checks, existing questions remain available and unchanged. Operator manual additions and future-day manual seeds are incorporated into the duplicate catalog on the next generation commit. All new batches are checked against the complete historical catalog; only 60 bounded questions are sent as model context. Near-duplicate checks are lexical (normalized content-word overlap), not a promise to detect every semantic paraphrase. Review generated content occasionally; suitability and reasoning quality also depend on the editable prompt and model.

## Local verification and remaining live checks

`node --test scripts/*.test.mjs` runs existing regressions plus structured batches, client payload/response formats, dry-run no-write behavior, auth rejection, retries, quotas, and publication without Cloudflare. `npx tsc --noEmit` checks the application; the generator Edge Function is type-checked separately against Deno's env/serve interface. `tests/question_rotation_upgrade.sql` verifies an existing 200-question pool transitions to 150 while preserving historical rows/completed matches and protecting an unfinished match. `tests/question_generation.sql` is a rollback-only suite for a **disposable** database after all migrations: FIFO/manual stock, exact duplicate/near-duplicate rejection, ten-hour gating, DST publication boundaries, idempotent leases/publication, initial 150-question fill, six-hour due gates, protected match questions, atomic failure, and quota guards. Run SQL suites with all five migrations against disposable PostgreSQL (the local verification used PGlite with a representative legacy schema). Separate-connection race/load testing and actual Supabase Cron/Vault/pg_net dispatch still require live verification; embedded PostgreSQL cannot exercise those extensions. The matchmaking function must retain its shared advisory lock `214734601`, also acquired by `qgen_commit_batch`. Additional isolated contract tests with mocked Cron/Vault/net interfaces verified inactive registration, exact schedules, duplicate rejection, bearer-header construction, target guarding, and migration preservation of an existing Cron active state. They do not establish live extension/network behavior. A populated 200-row pre-migration snapshot also remained identical after the forward migration, with function identity and execute grants preserved. No live activation is implied by passing local tests.

Implementation references: [Cloudflare model/REST example](https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/), [Cloudflare quota/error codes](https://developers.cloudflare.com/workers-ai/platform/errors/), [Supabase scheduling/Vault](https://supabase.com/docs/guides/functions/schedule-functions).

Current workspace regression note: the existing population smoothing test expects the previous narrow kernel, while the current frontend uses a bandwidth of 35. That unrelated assertion fails in the full test run; no population/frontend code was changed to hide it. Generator-specific tests and all SQL suites pass. This change is scoped to the question supply pipeline.
