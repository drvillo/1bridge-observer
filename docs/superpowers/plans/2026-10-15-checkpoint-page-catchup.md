# Bounded checkpoint-page catch-up

## Ground truth

- 1Bridge signs and stores a new checkpoint for every governed completion and authority revision (`ubo-guard/webapp/src/lib/authority/completion.ts:200-208`, `storage.ts:148-156`).
- The observer wire contract permits up to 16 ordered checkpoints per response (`src/lib/source.ts:155-181`), and the persistence boundary can stage up to 16 exact checkpoints atomically (`src/lib/store.ts:148-186,379-485`).
- `pollObserverOnce` currently requests and stages one checkpoint per HTTP page (`src/lib/poll.ts:69-91`). The shared Vercel route budgets 12 checkpoints per feed and runs on a daily Hobby cron (`src/app/api/shared-poll/route.ts:36-40`, `vercel.json`). This means a 100-checkpoint cold backlog requires at least nine daily runs for a feed selected every day, before accounting for other feeds, time limits or outages.
- Unverified until tested: staging an entire checkpoint page after its leaves preserves all accepted-head and resumability invariants. The real-Postgres integration test below will verify it.

## Journey and states

| Step | Caller | Production function | State before → after | Failure state |
|---|---|---|---|---|
| Daily or manual pull | `/api/shared-poll` | `pollSharedObserverOnce` → `pollObserverOnce` | Registry-advertised provisional head → bounded staged page | Time/page budget or unavailable source retains staged progress and pending status. |
| Page replay | `pollObserverOnce` | `fetchCheckpointPage`, `fetchLeafPage`, `stageObserverBatch` | Consecutive signed checkpoint bytes and covered leaves → exact staged prefix | Malformed page cannot become accepted coverage. |
| Completion | `pollObserverOnce` | `acceptObserverTarget` | Fully staged target → cryptographically replayed accepted head | Invalid replay quarantines exact evidence. |

## Changes

- `src/lib/poll.ts`: fetch up to `min(16, remaining checkpoint budget)` checkpoints at a time; stage their covered leaves with the existing bounded 64-leaf pages, then stage the complete checkpoint page. Count checkpoint **items**, not HTTP requests, against `maxCheckpoints`. Persist partial leaves before yielding so a later invocation can refetch the same immutable checkpoint page and continue. Retain the existing fixed target and replay/acceptance gates.
- `test/poll.integration.test.ts`: require one checkpoint HTTP request for a seven-leaf/eight-checkpoint cold feed, preserve the two-stage resume behavior by setting an explicit one-checkpoint second budget, and prove the accepted persisted prefix.
- `docs/persistence-plan.md` and `README.md`: describe the page-batching behavior and distinguish improved request count from the unchanged 12-checkpoint production budget. Do not imply a 24-hour backlog SLA.
- Existing opt-in benchmark and public raw artifact: rerun only after source commit with exact provenance; report the changed measurement alongside its narrower scope.

## Proposed names

No new exported functions or directory convention. Existing `pollObserverOnce`, `fetchCheckpointPage`, and `stageObserverBatch` retain one responsibility each. The new local variable `checkpointLimit` names the maximum number of items remaining in this call.

## Test plan

| Behavior | Layer | Domain assertion | Why this layer |
|---|---|---|---|
| Cold seven-leaf/eight-checkpoint target uses one checkpoint page and accepts the full signed prefix | Real Postgres integration | One checkpoint GET, seven persisted leaves, eight persisted checkpoints and expected signed head | HTTP and staged transaction boundaries are both material. |
| Budget interruption resumes the same target and staged leaves | Real Postgres integration | Pending first and second calls retain the attempt; third call accepts it | Lease/version and cursor persistence require a database. |
| Checkpoint page budget cannot be bypassed by batching | Real Postgres integration | A two-item budget stages no more than two checkpoints | Protects bounded Hobby invocation work. |

## Principles and Boy Scout scope

SRP/DRY: paging stays in the poller, source parsing in `source.ts`, staging in `store.ts`; no duplicate validators. YAGNI/KISS: no queue, new table, schema migration or second replay path. Touch only the poller, its existing integration tests and accuracy text. Inspect changed files for name strain and behavior-preserving cleanup separately.

## Verification

Observe the new checkpoint-request assertion fail before code. After the smallest change, rerun the focused real-Postgres suite, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm build`, `git diff --check`, and the opt-in pinned benchmark from a clean source commit. Keep the existing accepted-prefix and failure tests green. The benchmark still excludes registry discovery, multi-feed scheduling and deployment transit.
