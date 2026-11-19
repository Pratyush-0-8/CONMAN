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
