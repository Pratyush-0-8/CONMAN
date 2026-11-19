# Automated question generation

This is a backend-only implementation. Nothing has been deployed, remotely migrated, scheduled, or written to production automatically.

## Architecture and files

- `migrations/202611180001_question_generation.sql`: shared historical duplicate catalog, persistent FIFO, generation jobs/leases, request budgets and audit tables, transactional publication and rotation. Jobs start **disabled**.
- `functions/generate-questions/index.ts`: one server/operator endpoint with independently claimed actions. A strong invocation secret is required; anon/publishable keys and player JWTs do not authorize it.
- `functions/_shared/questionPrompt.ts`: editable style prompt, structured-batch validation, normalized exact and lexical near-duplicate checks.
- `functions/_shared/cloudflareAI.ts`: reusable Workers AI REST client, bounded context, timeouts, usage/error handling, configurable model.
- `config.toml`: adds only `generate-questions`; gateway JWT verification is disabled because the handler validates the separate invocation secret.
- `cron/activate_question_generation.sql`: opt-in setup template. It registers **inactive** schedules only; activation is a separate manual step.
- `tests/question_generation.sql`, `scripts/question-generation.test.mjs`: rollback-only database checks and mocked client/endpoint tests.

Daily Five still reads `daily_challenges`/`daily_questions` by assigned date. No changes to gameplay, judging, answers, ELO, profiles, or frontend are required.

### Arena compatibility

The inspected schema stores the question text directly in each match; the six original `ranked_questions` rows have stable bigint IDs. The migration renames that table to `ranked_question_bank`, preserving IDs, constraints, identity sequence ownership, and any existing FK references. **`ranked_questions` becomes an automatically updatable active-only compatibility view**, exposing the same `id, question` columns. The matchmaking function itself is unchanged. Retired rows remain in the bank indefinitely; no questions are deleted.

Existing active rows are incorporated. Filling adds ten at a time without retirement while below capacity; the first batch crossing 200 retires only its excess (e.g. 196 + 10 retires six). Later successful rotations add ten and retire ten oldest eligible rows. Questions used by unfinished matches are protected. If too few old rows can safely retire, the transaction rejects the whole change and keeps the old pool. Pairing and rotation share the existing pairing advisory lock, so a new match cannot select a question concurrently being retired. Historical matches retain their snapshots and any FK identities remain valid.

Review your live schema before applying: if other code depends on `ranked_questions` specifically being a table, or joins retired records through that name, update those consumers to use the backing bank. Read-only preflight:

```sql
select conrelid::regclass as referencing_table, conname, pg_get_constraintdef(oid)
from pg_constraint where confrelid='public.ranked_questions'::regclass;
```

## Deployment (manual)

1. Apply only `migrations/202611180001_question_generation.sql`, after the three existing Arena/Daily migrations. Do not rerun or edit earlier migrations. No Cron extensions/jobs or schedules are enabled by this migration.
2. Keep the already-configured `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` secrets. The token needs Workers AI Run access for the chosen account. Generate a separate invocation secret using `openssl rand -hex 32` and store it as `QUESTION_GENERATION_SECRET` in Supabase Edge secrets. Never put any of these values in Vite variables, repository files, URLs, or Cron SQL.
3. Optional server secret: `QUESTION_GENERATION_MODEL` (default `@cf/google/gemma-4-26b-a4b-it`). Pick a JSON-capable Workers AI model permitted by your account/plan. There is no automatic paid fallback or upgrade. The normal Supabase Edge server environment supplies `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
4. Deploy exactly this function:

```sh
supabase functions deploy generate-questions --project-ref YOUR_PROJECT_REF
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

Inspect the count, then repeat deliberately until it reaches 200 (the supplied six-row pool needs 20 successful batches). A full pool returns a skip without calling Cloudflare. `arena_rotate` is the normal scheduled action; an authenticated `"force":true` can run one controlled rotation outside its due window.

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

1. Enable Supabase Cron (`pg_cron`), `pg_net`, and Vault through your dashboard.
2. Create Vault entries **using the dashboard** named `conman_project_url` and `conman_question_generation_secret` (same secret as Edge). Values are never embedded in repository SQL or `cron.job.command`.
3. In one SQL editor session, deliberately execute `set conman.allow_question_cron_setup='yes';`, then the entire `cron/activate_question_generation.sql` template. Its guard prevents accidental setup; all three registered jobs are inactive at commit. Use stop-on-error if executing via psql.
4. Enable and activate only the desired job(s):

```sql
-- A: true 10-hour refill checks, with 5-minute polling/continuation/recovery.
update public.question_generation_jobs set enabled=true where job='daily_refill';
select cron.alter_job((select jobid from cron.job where jobname='conman-daily-refill'),active:=true);
-- B: 23:30 Eastern publication and safe catch-up checks.
update public.question_generation_jobs set enabled=true where job='daily_publish';
select cron.alter_job((select jobid from cron.job where jobname='conman-daily-publish'),active:=true);
-- C: one ten-question rotation each UTC half-hour.
update public.question_generation_jobs set enabled=true where job='arena_rotate';
select cron.alter_job((select jobid from cron.job where jobname='conman-arena-rotate'),active:=true);
```

A's persisted `next_due_at` is ten elapsed hours from the check cycle start, including across midnight; it does **not** use `0 */10 * * *`. An open cycle continues one batch per poll until 35. B polls every five UTC minutes, selects the proper Eastern target, and skips completed publication. C uses `*/30 * * * *` and the next UTC half-hour boundary, not completion time plus thirty minutes; this prevents a slow request from accidentally causing hourly rotations. Leases prevent overlapping workers. Recovery after failures uses a fifteen-minute job cooldown (plus any provider cooldown), with at most three model requests per batch.

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

Cron SQL success only means the HTTP request was queued. Inspect both `cron.job_run_details` and `net._http_response`/Edge logs for HTTP failures:

```sql
select jobid,jobname,schedule,active,command from cron.job where jobname like 'conman-%';
select jobid,status,start_time,end_time,return_message from cron.job_run_details order by start_time desc limit 30;
select id,status_code,timed_out,error_msg,created from net._http_response order by created desc limit 30;
```

Each invocation has a 110-second work budget; it does not start another model attempt without enough time remaining. Leases expire after four minutes. An interrupted worker may have spent a Cloudflare request without committing questions; its reservation still counts. If inventory is low or a rotation fails safety checks, existing questions remain available and unchanged. Operator manual additions and future-day manual seeds are incorporated into the duplicate catalog on the next generation commit. All new batches are checked against the complete historical catalog; only 60 bounded questions are sent as model context. Near-duplicate checks are lexical (normalized content-word overlap), not a promise to detect every semantic paraphrase. Review generated content occasionally; suitability and reasoning quality also depend on the editable prompt and model.

## Local verification and remaining live checks

`node --test scripts/*.test.mjs` runs existing regressions plus structured batches, client payload/response formats, dry-run no-write behavior, auth rejection, retries, quotas, and publication without Cloudflare. `npx tsc --noEmit` checks the application; the generator Edge Function is type-checked separately against Deno's env/serve interface. `tests/question_generation.sql` is a rollback-only suite for a **disposable** database after all migrations: FIFO/manual stock, exact duplicate/near-duplicate rejection, ten-hour gating, DST publication boundaries, idempotent leases/publication, initial 200-question fill, protected match questions, atomic failure, and quota guards. These suites were run with temporary embedded PostgreSQL, not production. Separate-connection race/load testing, actual Cloudflare connectivity/model availability, Supabase Cron/Vault/pg_net dispatch, and live schema compatibility still require staging verification. No schedules were enabled by Codex.

Implementation references: [Cloudflare model/REST example](https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/), [Cloudflare quota/error codes](https://developers.cloudflare.com/workers-ai/platform/errors/), [Supabase scheduling/Vault](https://supabase.com/docs/guides/functions/schedule-functions).

Current workspace regression note: the existing population smoothing test expects the previous narrow kernel, while the current frontend uses a bandwidth of 35. That unrelated assertion fails in the full test run; no population/frontend code was changed to hide it. Generator-specific tests and all SQL suites pass. Concurrent user edits to Arena and the Daily judge were preserved.
