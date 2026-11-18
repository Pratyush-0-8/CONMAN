# Daily Five deployment

No SQL, Edge Function, or hosting changes have been applied or deployed automatically.

1. Apply **only** `migrations/202611170001_daily_five.sql` after the existing Arena migration. Do not rerun or edit the already-applied Arena migration. All Daily Five tables/functions are new and independent of Arena.
2. Edit `seed_daily_five.sql`: replace its assigned date everywhere and enter five prompts. Run it as the database owner. The assigned date uses `America/New_York`, including DST. To play today, seed today's Eastern date. Publishing requires positions 1–5 and freezes the assignments. Historical assignments/results remain stored. No generation or scheduling is included.
3. Generate a strong secret: `openssl rand -hex 32`. Set it as the Supabase Edge secret `DAILY_TOKEN_SECRET`. Keep it stable. Set `DAILY_ALLOWED_ORIGINS` to the exact comma-separated frontend origins, including production and any local/preview origins you use (for example `https://your-site.example,http://localhost:8443`). Do not use `*`.
4. Keep `GROQ_API_KEY` in Supabase secrets. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are server runtime configuration. No new frontend secret or dependency is needed; retain the existing Vite Supabase URL/publishable key.
5. Deploy only the new function: `supabase functions deploy daily-five --project-ref YOUR_PROJECT_REF`. The added config sets `verify_jwt = false` because Daily Five is public. Ownership is checked using its separate capability token. Preserve the existing Arena function and configuration.
6. Build/publish the frontend through your existing deployment process when ready. Use HTTPS for Voice and clipboard access. Nothing here deploys or pushes automatically.

## Attempt ownership and privacy

A 256-bit creation nonce is saved transactionally in origin-scoped IndexedDB before starting. The server issues a deterministic HMAC credential using that nonce, the assigned date, and `DAILY_TOKEN_SECRET`. Repeating a start after a lost response recovers the same attempt; two tabs share the same stored creation nonce. Supabase stores only the credential's SHA-256 hash. Private API calls require the credential in `X-Daily-Token`; IDs, anon keys, login sessions, and local flags do not grant access. Tokens never go in URLs or application logs.

The deployment calls Supabase on another origin, where third-party HttpOnly cookies are unreliable. IndexedDB is the protected origin-scoped alternative used here; it survives refresh and is independent of Supabase login/logout. It is accessible to JavaScript on the frontend origin, so keep that origin free of injected scripts, use an appropriate CSP, and protect recovery data like any bearer credential. Clearing browser/site data or changing origins/devices loses recovery and permits another anonymous attempt. Perfect anonymous deduplication is deliberately not claimed; no device fingerprint or email is collected. Signing in is optional and does not merge Daily Five attempts into Arena profiles.

Only privileged service RPCs access daily tables. The public database roles have no direct reads/writes or execution privileges for these RPCs. Only aggregated completed scores are returned by the distribution action; other players' answers, tokens, and individual results are never exposed.

## Timing, judging, and abuse controls

Each explicit Start/Next schedules one server start, with a 750ms delivery lead, then 5 seconds of thinking and 15/20 seconds of Voice/Typing. Reloading never resets it. Input closes at the stored deadline. Final delivery grace is bounded to 1.5s for final speech events and 0.5s for typing transport. Drafts save during input; an interruption may lose text not yet received by the server. An abandoned answer expires when the attempt is next accessed. Next does not start automatically.

Each locked answer gets one intended Groq call evaluating all five categories, using the existing Qwen model and integer rubric. No Arena judgment, opponent, winner, or ELO path is invoked. Score finalization is transactional and idempotent. Claims have a 90s crash-recovery lease; retries reuse the saved answer. There are at most three Groq attempts per question, a 15s error cooldown, and a 60s provider-rate-limit cooldown. A process crash can require another external request after the lease expires, but cannot award the score twice. After three failures, the UI preserves the attempt without inventing a score; an operator must investigate/reset that question's retry counter if further recovery is needed.

SQL enforces 600 requests/minute per advisory IP bucket, 10 attempt creations/day per bucket, 2,000 creations/day globally, 50 grading claims/day per bucket, and **1,000 grading claims/day globally**. Daily budgets reset at Eastern midnight. IP values are HMAC-hashed with a daily rotating context and are never stored raw. Forwarded IP headers are only an advisory layer: spoofing/changing one cannot bypass the hard global Groq budget or the per-question retry cap. A missing IP uses a shared conservative bucket. Expired abuse buckets are removed opportunistically on new starts. These limits protect Groq quota but are not a promise to eliminate distributed abuse or Edge invocation costs. Raise production capacity deliberately with a new migration if needed.

The final total is the sum of five saved integer totals. The histogram has 25 real bins (0–9 through 240–250), and percentile uses midpoint ties: `100 * (lower scores + tied scores / 2) / completed attempts`. A single completed attempt has percentile 50, labeled as an early sample. Partial attempts are excluded. Copy Result writes only `String(final_score)`.

## Verification and rollout

Run `node --test scripts/*.test.mjs`, `npx tsc --noEmit`, and `npm run build`. `tests/daily_five.sql` is a rollback-only test suite for a **disposable/test** database after the new migration; it covers progression, private ownership, deadlines, grading claims, score validation, totals, distribution, and budgets. Existing Arena tests remain in place. PostgreSQL suites were exercised locally using a temporary embedded PostgreSQL runtime; mocked HTTP tests do not contact Groq.

Before publishing, test in separate browsers: anonymous and signed-in entry; Voice and Typing; denied microphone permission; refresh during thinking/input/judging; repeated Next/submit; tab switching; network interruption; and mobile/IME input. Finish five questions, verify individual scores sum to the final total, inspect the actual population bins, and paste Copy Result into plain text. Confirm Arena still signs in, matches, judges, and updates ELO. Live Supabase/Groq, real microphones/clipboard permissions, multi-connection load, and visual/mobile browser QA are not claimed as tested when unavailable locally.

## Population UI update

Apply `migrations/202611170002_daily_population_comparison.sql` after the original daily migration. It only adds the exact `below_count` aggregate to the existing service-only distribution function; no Edge Function redeployment is required. The updated UI smooths the actual score buckets, displays `round(100 * below_count / count)` (ties excluded), and hides the curve/comparison until at least two completed results exist. The legacy midpoint percentile field remains in the API for compatibility but is no longer displayed. Deploy this migration with the frontend update; an older endpoint cannot supply the exact comparison, so the UI will show comparison unavailable rather than infer it from bucket centers.
