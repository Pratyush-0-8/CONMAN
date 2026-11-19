# Social MVP

For the later editable-answer synchronization fix and native multiplayer concurrency verification, see [MULTIPLAYER_SYNC.md](MULTIPLAYER_SYNC.md). The launch evidence below records the original social rollout.

Friends lives at `/friends`; public profiles use permanent `/players/<profile UUID>` links. Profiles show username, optional editable display name, ranked ELO/record, social counts and relationship actions. Search is a literal, case-insensitive username prefix (at least two characters), with 30-player pages. Names are case-insensitively unique; the migration aborts on pre-existing ambiguous names instead of renaming players.

Following is directed. A friendship is derived from two follows, never stored separately. Unfollowing immediately breaks friendship and cancels pending invitations on the server. Public RPCs explicitly allowlist profile fields; emails and presence session identifiers are excluded.

Friend challenges use the existing `matches`, `ranked_players`, `ranked_drafts`, question pool, server clocks, answer RPCs, `clever-action` judge and results/history. `matches.is_ranked=false` leaves ELO and all ranked wins/losses/draws unchanged. The new migration replaces only `ranked_state`, `ranked_history` and `ranked_finalize` to return that marker and skip ranked statistics for friend matches. Existing matches default to ranked. No Edge Function changes are needed.

Invitations last 60 seconds. Only verified mutual friends who are available can send/accept. One pending invitation per involved player is enforced inside the same advisory transaction lock as ranked pairing and follow changes. Recipient-only acceptance, sender-only cancellation, expiration, mutual friendship, queue and active membership are checked on the server. Repeated acceptance returns the original match ID. The existing unique active-player index also prevents conflicting matches. Pairwise pending uniqueness and immutable participant fields are database-enforced; clients have no direct table writes.

Presence uses one UUID per mounted browser tab, a 10-second heartbeat, and a 35-second server stale cutoff. Hidden/unmounted tabs mark their own sessions unavailable; a second live tab can keep the player available. Active/unacknowledged matches and fresh ranked queues make a player busy regardless of their heartbeat. Presence sessions cannot be read/written directly by browser roles. Stale own sessions are cleaned on later heartbeats.

Recent declined/cancelled/expired invitations also appear as dismissible status notifications outside Friends. Invitation Postgres Changes subscriptions are protected by participant RLS, with a five-second polling fallback. Arena's existing two-second polling restores the authoritative match after acceptance, reconnection and refresh. Social lists refresh every ten seconds. Expiration is enforced at every mutation and materialized lazily on invitation reads; it needs no scheduler. Existing abandoned-match behavior is preserved: saved drafts lock at their deadlines when a participant reconnects; judging remains recoverable through the existing worker lease/retry flow.

## Files

- `migrations/202611190001_social.sql`: additive profile/match metadata, graph, presence, invitations, RPCs, RLS, grants, Realtime registration and compatible match finalization.
- `tests/social.sql`: rollback-only disposable database assertions, including actual anonymous/authenticated roles.
- `../src/lib/socialService.ts`, `../src/lib/useSocial.ts`: typed RPCs, subscriptions, presence, expiry clocks and recovery.
- `../src/components/Social.tsx`, `../src/screens/Social.tsx`: player lists/profiles, follow actions, input choice and invitation controls.
- `../src/App.tsx`, `../src/components/Nav.tsx`, `../src/lib/navigation.ts`: navigation, global invitations and Arena handoff, including from Daily Five.
- `../src/lib/auth.ts`: literal underscore handling in username availability checks.
- `../src/lib/matchService.ts`, `../src/lib/game.ts`, `../src/components/lists.tsx`, `../src/screens/Arena.tsx`, `../src/screens/Results.tsx`: unranked metadata and labels.
- `../scripts/social.test.mjs`, `../scripts/social-db.test.mjs`, `../scripts/sql-fixture.mjs`, `../scripts/daily.test.mjs`: social/hook/component/navigation coverage and repeatable disposable PostgreSQL regressions.
- `../scripts/population.test.mjs`: correct the stale peak/valley assertion for the already-existing 35-point smoothing. Population runtime behavior is unchanged.
- `../package.json` and both lockfiles: PGlite test dependency, `test` and `typecheck` scripts.
- `../vercel.json`: SPA fallback so direct public profile/Friends/Arena URLs and refreshes work. Uses [Vercel's documented Vite SPA rewrite](https://vercel.com/docs/frameworks/frontend/vite#using-vite-to-make-spas).

## Validation

Run with Node 22.18+ (native TypeScript stripping) or Node 24:

```sh
npm ci
npm test
npm run typecheck
npm run build
```

The suite runs 45 Node tests, including five SQL suites (`ranked.sql`, `daily_five.sql`, `daily_population.sql`, `question_generation.sql`, `social.sql`) on an ephemeral in-memory PostgreSQL/PGlite instance with representative legacy tables and an auth profile-creation trigger. Never run the fixture or SQL test files on production. The migration and SQL tests cover follows, mutuality/removal, uniqueness, search, role privileges/RLS, spoofing rejection, invitations, expiry/cancel/decline, duplicate acceptance, stale/hidden sessions, queue conflicts, exact two-player match recovery and unranked finalization idempotence. Existing Arena/Daily/judging/generator tests pass.

Frontend hook/component tests mock Supabase and browser events. PGlite serializes requests; these tests do not establish independent-connection load/race behavior or actual Realtime delivery. A connected browser was unavailable in the agent environment, so visual/mobile/microphone and full two-account end-to-end verification remain manual. Build succeeds with the existing bundle-size and future Vite-config compatibility warnings.

## Production status

The authorized target was verified as **CONMAN (`qoonotocfbwarkjqjxwl`)**. Only `202611190001_social.sql` was applied, in one transaction. This project had no `supabase_migrations.schema_migrations` history before deployment; older migrations were not replayed or marked as newly applied. Do not run an unreviewed bulk `db push` against it. Subsequent changes must be new forward migrations.

Before/after fingerprints confirmed preservation of all pre-existing profile fields, match fields and Daily attempts: **3 profiles, 3 matches, 11 Daily attempts and 15 assigned Daily questions** at deployment. Legacy matches retained `is_ranked=true`. Every question-generation function body, the three enabled generator jobs, and all Cron names/schedules/active flags were unchanged. Cron remains: Arena rotation `0 */6 * * *`; Daily publish/refill `*/5 * * * *`. No generator or Edge Function was redeployed.

Live checks confirmed RLS on all three social tables, publication registration for invitations/follows alongside existing Arena tables, denied direct client writes and rating/finalizer access, and denied presence-session reads. Public profile/search and anonymous invitation access denials passed through the actual Supabase HTTP API using the existing publishable key. No production users, matches or questions were created for testing.

The frontend implementation was committed and pushed to `origin/main` through the existing Git/Vercel workflow. Production at **https://conman-pi.vercel.app** was verified to serve the social client and return HTTP 200 with the application shell for `/`, `/friends`, `/arena`, and `/players/<UUID>`. Public routes and deployed JavaScript were checked over HTTP; this does not replace the two-account browser test below.

## Two-account acceptance test

1. Open the deployed website in two separate browser profiles (or normal/incognito). Sign in to two different verified accounts, A and B. Keep both tabs visible. Finish any existing match and click Return home before testing.
2. On A, open **Friends → Find players**. Enter B's username prefix, open B's profile and click **Follow**. Check that B shows A in Followers, and that A has no friend/challenge access yet.
3. On B, find A and click **Follow back**. Refresh the Friends view or wait up to ten seconds. Both should see each other as friends and available. Confirm profile counts and open the permanent profile URL directly, including a page refresh.
4. Choose **Typing** for the first test. On A, click **Challenge**. A should see a pending invitation/countdown. On B, accept the incoming invitation; both should enter the same match/question. Refresh one tab and confirm the same match is restored.
5. Submit answers on both accounts. Confirm normal judging and result/history, the **Unranked** label, and unchanged ELO and ranked record. Click Return home on both accounts. Repeat using Voice on one side, allowing microphone access before sending/accepting.
6. Repeat invitations with **Decline**, sender **Cancel invitation**, and no response for over 60 seconds. Each must reach its corresponding state without creating a match. Try accepting twice/refreshing rapidly: one match only.
7. Close B's tabs or disconnect it. Wait at least 35 seconds plus the list refresh interval; B must become unavailable. Reopen B and confirm availability returns. During a match or ranked queue, verify a friend cannot start a conflicting match.
8. Unfollow B on A. Friendship and challenge access must disappear; any pending invitation must be cancelled. A one-way follow may remain from B. Confirm existing ranked Arena and Daily Five still work.
