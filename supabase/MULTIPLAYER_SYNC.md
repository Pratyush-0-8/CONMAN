# Editable multiplayer answer synchronization

## Root cause

`AppendInput` in `src/screens/Arena.tsx` already allowed backspace, deletion, and replacements. Both ranked games and friend challenges used `ranked_answer(uuid,text,boolean)`, whose deployed body still contained:

```sql
if p.input_mode='typing' and left(p_text,char_length(previous)) is distinct from previous
then raise exception 'Typing answers must be append-only'; end if;
```

Consequently, replacing any saved prefix made autosave and final submission fail. The old `acceptsAppend` helper and ranked tests also encoded the obsolete contract. The three-argument RPC returned `void`, so a late no-op could be mistaken for a successful final. The frontend serialized its final behind in-flight autosaves, could use text from a render preceding the last input event, and the draft-error Retry button submitted the answer early.

## Protocol and frontend

Only the new forward migration `202611190002_answer_sync.sql` changes the database. Earlier applied migrations are untouched.

- `ranked_drafts.revision` orders complete text snapshots independently for each participant. `writer_id` identifies the current editor.
- `ranked_begin_answer` uses a compare-and-swap of the previous writer ID to restore the canonical text/revision and fence an older tab or pre-refresh session. Acquisition retries with the same token are idempotent. A delayed acquisition cannot steal a newer session.
- `ranked_answer_v2` accepts full text replacements, including an empty string. Under the existing match row lock, it checks membership, writer token, increasing revision, length, thinking period, input deadline, and final delivery grace. Old revisions and fenced writers do not mutate any answer. After locking, every repeated/conflicting request returns the saved immutable answer.
- Every response reports status, saved text/revision, and `locked_at`; the client does not infer final success from a void/no-op result. `ranked_state` exposes the writer/revision only to that participant and continues withholding the opponent's answer until both answers lock.
- The unversioned three-argument RPC now requires a reload instead of permitting unordered writes. **Refresh any old browser tabs after deployment.** It still checks sign-in and match ownership before returning that instruction.
- `useAnswerSync` restores the editor before enabling input, updates its latest-text reference synchronously on input, and throttles autosaves without an unbounded request queue. Final submission bypasses pending autosaves with a higher revision. Once submitted, the captured text/revision remain fixed across retries, even if a response is lost. Input remains frozen while that final is unresolved.
- Old autosave responses cannot clear a newer final's error/status. Draft Retry saves a draft; final Retry resends the same final. Online/focus events retry the appropriate operation. Requests have a five-second transport timeout rather than leaving draft synchronization permanently blocked by an unresolved request.
- A recovered voice editor does not start a microphone after the deadline. An already-running voice input still stops recognition and includes its final transcript using the original bounded grace.

Paste/drop blocking remains in the actual shared browser input. The server cannot attest how client-supplied text was produced; it enforces ownership, ordering, length, timing and locking.

Input periods remain five seconds to think, then 20 seconds to type or 15 seconds to speak. The existing final transport grace is unchanged: 500 ms typing / 1500 ms voice. A network outage extending beyond that grace cannot make unreceived edits eligible; the server locks the last received real draft and the UI reports a mismatch if this tab still has unsent edits. Refresh recovers server-received text, not text never delivered. A newer editor takes control of the same player's answer; a superseded tab must reload rather than silently overwrite it.

Friend invitations, matchmaking, question selection, timer authority, judge claims/finalization, ranked ELO and unranked exemptions continue using the same existing game engine. No Edge Function or question-generation configuration changes are needed.

## Tests

```sh
npm ci
npm test
npm run typecheck
npm run build
```

The full suite has **56 passing Node tests**, including the six rollback-only SQL suites in an ephemeral PGlite database. `scripts/answer-sync.test.mjs` exercises the actual synchronization hook and Arena input/UI handlers with mocked transport/browser events. `supabase/tests/answer_sync.sql` covers full replacements, revision order, invalid/stale requests, membership, editor takeover/recovery, two-player isolation/privacy, voice updates, thinking/deadline/grace checks, immutable finals, legacy-client rejection, and direct-write/anonymous privilege denials. The ranked regression suite now uses versioned writes and verifies legal edits instead of expecting their rejection. Social, Daily, judging, population, and question-generation regressions continue to pass.

For real independent PostgreSQL connections, create a **new empty database on a dedicated disposable local PostgreSQL server**, named `conman_multiplayer_test` (or with an alphanumeric suffix), and run:

```sh
CONMAN_TEST_DATABASE_URL=postgres://USER:PASSWORD@127.0.0.1:PORT/conman_multiplayer_test npm run test:concurrency
```

`pg` is a development dependency. The script rejects remote hostnames and unrelated database names and refuses populated databases. It installs the representative legacy schema/migrations only inside that empty test database. Do not point it at a normal development or production database. PostgreSQL roles are cluster-wide, so use a dedicated test cluster. The verification run used a temporary native PostgreSQL 18.6 cluster under `/private/tmp`, bound to loopback, and stopped/removed that cluster afterward. The portable server binaries were installed only in the temporary harness, not added to application dependencies.

The native run passed all six SQL suites plus overlapping-connection tests. Lock barriers and `pg_stat_activity` confirm both requests are actually waiting concurrently before release. Tests verify: exactly one match from concurrent friend acceptance; one active match when ranked pairing races challenge acceptance; increasing draft/final order; immutable duplicate finals; opponent privacy; exactly one judge claim and idempotent concurrent finalization; unchanged unranked ELO/statistics; ranked K=32 changes applied once; and both players restoring the same question/results.

## Production verification

Deploy only `migrations/202611190002_answer_sync.sql` to confirmed project **CONMAN (`qoonotocfbwarkjqjxwl`)**, then push the tested frontend to `origin/main` for the existing Vercel workflow. This project previously used direct SQL migration application and has no migration-history table; do not bulk-replay old migrations with an unreviewed `db push`.

Capture before/after counts and row fingerprints for profiles, matches, answers/drafts, Daily attempts/answers, follows, invitations and question inventory. Exclude only the two newly added draft metadata fields from the historical draft comparison. Confirm question-generation configuration, quotas, schedules, inventory and all unrelated function bodies remain unchanged. Verify new RPC grants, default metadata, private-helper access denial and opponent privacy without changing real accounts or creating production test matches. HTTP checks can establish routing, deployed bundle presence and anonymous access denials, but cannot prove a real two-browser match.

## Remaining verification and scope

No browser connection was available to the agent, so actual two-account Realtime delivery, visual/mobile/IME behavior, microphone hardware and live Groq output still need the checklist below. The independent database races and mocked frontend tests are not claims of live two-account play. Production build passes with existing Vite compatibility and bundle-size warnings.

The later `202611200001_daily_reliability.sql` release resolves the separate Daily Five append-only/date-resumption issues and strengthens canonical-final judging for both modes. See DAILY_FIVE.md for the current protocol and regression evidence; the multiplayer migration described above remains unchanged.

## Two-account manual checklist

1. Refresh both browser profiles to load the new deployment. Sign in to two verified accounts that mutually follow each other; keep both tabs visible. Complete/acknowledge any earlier match.
2. Challenge and accept with Typing on both sides. Confirm the same question/countdown. Type a sentence, wait for autosave, then backspace, delete a selection, edit the first word and replace the whole answer. Paste and drag/drop must be blocked. Submit and verify the final transcript matches the latest edit, with no append-only error.
3. Repeat submitting immediately after rapid edits and at the end of the timer. Try repeated clicks. Briefly interrupt/reconnect the network before the deadline; confirm saved text recovers and no old autosave replaces a final. A response lost after server acceptance must recover the same immutable final. An outage past grace may retain only the last received draft.
4. Refresh during input. Confirm server-saved text returns and editing can continue. Open the same account/match in a second tab; the newer editor must fence the older tab rather than allowing silent overwrites.
5. Repeat with Typing/Voice and Voice/Voice. Include corrected interim speech and final recognition. Refresh after the speaking deadline and confirm the microphone does not reopen. Both players must reach judging/results.
6. Verify friend-match ELO and ranked record remain unchanged. Repeat normal human ranked Arena, confirm privacy before answer lock, and verify ELO/record update once even after refreshing results or retrying judging.
7. Exercise decline, sender cancellation, 60-second invitation expiry and concurrent acceptance/repeated clicks. Try queueing while an invitation is pending: only one active match may result. Check reconnect/refresh on both accounts and a normal Daily Five visit.
