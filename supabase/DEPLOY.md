# Human-only matchmaking release — November 20, 2026

Applied `202611200003_matchmaking_timeout.sql` directly to confirmed project **CONMAN (`qoonotocfbwarkjqjxwl`)**, following its existing SQL-editor migration workflow. The project still has no migration ledger; do not bulk-replay migrations with `db push`.

Search starts immediately with a `00:00` display. On the first server evaluation at/after 20 seconds, PostgreSQL samples an integer 1–10 once and persists a deadline 21–30 seconds after the original join. Clients wake at the 20-second boundary and final deadline, poll each second, and recover through Realtime/focus/online events. UI expiry requires server confirmation; an offline client may show its reconnect error until it can confirm state. No AI opponents are created.

Pairing, expiry, cancellation and friend acceptance share the existing arbitration lock. Every candidate is checked for expiry immediately before match creation. A committed match wins against cancellation or timeout. Expired/disconnected queue membership is removed on the next matchmaking/state operation and can never be selected after its deadline. One bounded terminal receipt per player restores the timeout screen across refresh; attempt IDs and compare-and-swap retries prevent stale tabs from cancelling or reviving a newer search. Closing the browser relies on the existing 25-second reconnect lease plus the hard search deadline; refresh deliberately restores the same attempt. Explicit cancel/home and browser back/forward cancel only that attempt. Existing open legacy clients retain their RPC signatures; refresh them to get the new timeout UI and token-scoped controls.

The new screen provides **Try Again** and **Back to Home**. Retry preserves the timed-out input mode even after refresh. Voice preflight now checks Web Speech recognition before joining, so unsupported browsers cannot enter a voice match just because microphone permission succeeded.

## Verification and production preservation

- `npm test`: 84 passing tests, including the nine rollback-only SQL suites, upgrade preservation, timeout UI/transport/navigation, voice preflight and speech lifecycle, Daily restoration, final-answer synchronization, scoring and social regressions.
- `npm run typecheck`, strict Edge TypeScript checks using the Deno env/serve declaration, and `npm run build`: pass. Deno itself is unavailable; this is TypeScript checking against its used runtime interface, not a Deno runtime test. Existing Vite configuration/chunk-size warnings remain nonblocking.
- `scripts/multiplayer-concurrency.mjs` on a fresh disposable native PostgreSQL database: pass. Separate connections overlap duplicate joins, timeout versus arrival across the deadline, retry versus stale cancellation, committed match recovery, friend acceptance, answer saves/finalization, judge claims, exactly-once scoring, ranked Elo and unranked preservation. The test's fixed ±16 expectation was corrected to use the existing Elo formula when consecutive matches have unequal ratings; product Elo logic was unchanged.
- Before/after production fingerprints were identical for profiles, matches, players, answers/drafts, Daily attempts/answers, follows, invitations, question history and inventory. All eight deployed function bodies matched the migration exactly. New receipt RLS, RPC privileges, internal-helper denial, queue publication and browser Elo write denial were inspected read-only. No production test users or matches were created.
- No Edge Function source changed or was deployed. Existing ACTIVE versions: `clever-action` 18, `daily-five` 12, `generate-questions` 8.
- Read-only production scheduling inspection found **35 unused Daily questions**, **150 active Arena questions**, five published questions for November 20 and each of the three preceding days, all three jobs enabled, authenticated dispatch HTTP 200, successful ten-question Arena rotations at 06:00/12:00/18:00 UTC, and the nightly publication at 04:30 UTC (23:30 Eastern). Daily request usage was 7/80 at inspection, with no exhausted quota, current cooldown or job error. Schedules, provider settings, generation functions and published challenges were unchanged; no model generation was triggered for testing.

No browser was available in this session. Desktop/mobile layout, physical microphone behavior and real two-account Realtime gameplay remain manual release checks. Automatic approval review rejected active backend HTTP probes over possible write/model side effects; production verification used read-only SQL metadata and frontend GET requests instead. Passing local tests does not establish live end-to-end gameplay.

## Prioritized two-account checks

1. Refresh both browsers. In Typing, search alone to timeout; refresh during search and on timeout, retry, and return home. Test a second tab and Back. With the other account, join immediately, after 10 seconds, and after 20 seconds: both must receive one shared human match. Repeat near expiry.
2. Complete ranked games with typing edits, one refresh/reconnect and a brief network outage. Verify private answers, exact final text, one result/history entry per user, and Elo changing once. Play a mutual-friend challenge and verify no Elo changes; exercise invitation decline/cancel/expiry and Realtime delivery.
3. Finish all five Daily questions and refresh results. Confirm current Eastern date, 10-second thinking and 35-second typing, persisted scores, paste/drop rejection, and historical recovery only for its own date.
4. On desktop and a real phone, complete voice rounds in Daily/ranked/friend play: allow/deny mic, verify 25-second capture, final transcription, failed/empty recognition messaging, input visibility with the keyboard open, buttons, timers, navigation and results. Unsupported browsers should reject Voice before play.

---

# Ranked Phase 1 deployment

For the current editable, versioned multiplayer answer protocol and its forward migration, see [MULTIPLAYER_SYNC.md](MULTIPLAYER_SYNC.md). The initial rollout notes below are historical; do not replay already-applied migrations.

Nothing in this repository has been applied to live Supabase by Codex.

1. Review and run `migrations/202611160001_ranked_multiplayer.sql` once, in that order (there is one migration), using the SQL editor or your existing Supabase migration workflow.
2. Deploy/update `clever-action`: `supabase functions deploy clever-action --project-ref YOUR_PROJECT_REF`. The included function configuration disables gateway JWT verification; the handler verifies the bearer token with Supabase Auth and requires verified match membership before every claim. Keep that handler check.
3. Keep the existing `GROQ_API_KEY` secret. `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are Edge-only runtime configuration. Never put a service-role key or Groq key in Vite variables. The frontend keeps its existing `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`.
4. The migration adds `ranked_players` and `ranked_queue` to the existing `supabase_realtime` publication. If that publication does not exist, enable Postgres Changes for those two tables in the dashboard. Polling also recovers missed events. Preserve existing auth redirects and email confirmation settings. Serve the app over HTTPS for Voice.

## Existing-schema assumptions

- Existing IDs and player foreign keys are UUIDs. `matches.id` and `match_answers.id` generate IDs by default. Existing creation timestamps have defaults.
- Legacy `matches.mode` accepts `voice`; `opponent_type` accepts `human`. The confirmed `status` CHECK allows `waiting`, `brainstorming`, `speaking`, `judging`, and `completed`; ranked insertion explicitly uses `brainstorming` without relying on a default. Per-player modes and authoritative lifecycle live in the new tables/columns, so cross-mode matches do not require changing a legacy mode enum.
- Existing account-creation triggers insert `profiles(id, username, ...)`. They remain in place; a new profile trigger enforces 500 ELO and zero starting statistics. Existing ratings and records are preserved. Profiles' statistics and match tables become read-only to browser roles; ranked writes use the restricted RPCs. If the live database has older custom SECURITY DEFINER functions that let clients change ratings, revoke those separately; none were supplied here.
- The deployed judge source was not supplied. The replacement preserves the specified model and five-category scoring contract, returning `model`, `player1: { scores, total }`, `player2: { scores, total }`, `winner` (`player1`, `player2`, `draw`), and `decisiveCategory`. Confirm these field names against any consumers outside this app before replacing the function.

## Two-account test

Use two separately signed-in browsers with confirmed accounts. Select Voice on one and Typing on the other, then Find Match (allow the Voice microphone). Both should see the same question, a shared 5-second thinking period, then 15/20 seconds of input. Voice waits when its time ends. Try early submission, refresh, an empty answer, and a temporary network interruption. Typing supports backspace, deletion, and replacement while rejecting paste and drop; test your target mobile/IME keyboards too.

Once both answers lock, verify judging, category scores → totals → winner → ELO, and one completed history entry per user. Refresh both results and retry requests: ratings/statistics must remain unchanged. Repeat with Voice/Voice, Typing/Typing, and queue cancellation. A worker failure or invalid Groq output must leave judging recoverable without awarding ELO; Retry becomes available after the server cooldown.

Input controls close at the server deadlines. Final payload delivery has bounded grace (Voice 1.5s for final transcription, Typing 0.5s for transport). Drafts save during input; refresh/disconnection can lose words not yet received by the server. An abandoned match advances when a participant reconnects; no background scheduler or forfeits are added. Only one worker can judge at a time; after failure or an expired worker lease, recovery may retry the external Groq request. A completed judgment and rating updates are persisted exactly once.

## Local verification

`node --test scripts/ranked.test.mjs scripts/judge.test.mjs`, `npx tsc --noEmit`, and `npm run build` check the pure rules, mocked judge failures/claims, types, and production bundle. `tests/ranked.sql` exercises pairing, privacy, versioned answer ownership, duplicate claims/finalization, ELO, draws, and expiry; run it only against a disposable database after the migration. Its fixtures roll back. The migration and SQL suite were exercised using temporary embedded PostgreSQL against a representative legacy schema, not the live project. Live Groq/Supabase, Realtime delivery, concurrent multi-connection load, real microphones, and mobile/IME behavior still need the two-account test above.
