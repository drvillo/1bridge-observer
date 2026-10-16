> Historical design/evidence for the retired v1 profile. See README.md and the compact registry witness plan for current runtime.

# Queued shared-observer catch-up on Hobby

## Ground truth

- The user explicitly chose cron plus queues on Vercel Hobby for the independent shared observer. Vercel's public-beta Queues support Hobby, at-least-once push consumers and `@vercel/queue` `send`/`handleCallback`; configure a private consumer with a `queue/v2beta` trigger in `vercel.json` ([official overview](https://vercel.com/docs/queues), [SDK](https://vercel.com/docs/queues/sdk)). Queue delivery and pricing remain deployment facts to verify; local tests cannot certify Vercel trigger wiring.
- The existing daily cron route does a bounded 45-second `pollSharedObserverOnce` call and signs the aggregate report (`src/app/api/shared-poll/route.ts:9-53`). It stages at most 12 checkpoint items per selected feed, picks at most 12 feeds and has no continuation scheduler. The selected-feed poller and registry poller retain durable state and release fenced leases (`src/lib/shared-poll.ts:22-61`; `src/lib/poll.ts:36-113`; `src/lib/registry-poll.ts:42-122`).
- The clean [scale result](https://github.com/drvillo/1bridge-research-artifacts/blob/a92428c/results/observer-scale-benchmark.json) verified 10,000 leaves/10,001 checkpoints with 101 direct 100-item polls. The current 12-item shared-route cap requires at least 834 selected route calls for that prefix. Local timings do not predict deployed speed.

## Design

Retain cron and the protected manual route as recovery seeds. Add an optional queue wake-up path in this standalone observer repository, without any 1Bridge push or release dependency. Both cron and the queue consumer call one shared poll/report function. A queue message contains only scheduling counters (version, remaining scan batches, whether this sweep made progress, remaining calls); no customer data, signed evidence, secret or cursor. Every consumer rereads the latest durable registry/feed cursors. A duplicate, late, lost or expired message cannot rewind or skip those cursors. The Postgres lease and compare-and-swap rules remain the correctness boundary.

One sweep covers the current accepted catalog using the existing 12-feed round-robin selection. After a bounded call, schedule another if unselected feed batches remain. When a sweep ends, start one more sweep only if it made durable progress (accepted target or newly staged page/target). Stop when a full sweep makes no progress, when the source is unavailable with no progress, or after 128 continuation calls; the next daily cron/manual call may resume. A `pending` result without any staged work does not by itself trigger a hot loop. Queue send failure is reported/logged but does not invalidate the signed report or block releases. The consumer returns an error for a genuine poll/report failure so Vercel can retry at least once; its handler is idempotent under existing DB fencing. The queue message is a wake-up, never an audit event or evidence store.

The queue integration adds the official `@vercel/queue` runtime package and a private Next route. This is the one new dependency authorized by the user's explicit queue decision; the authority library and application gain none. The feature is best effort, not a freshness SLA. The 128-call daily chain and 12-item cap can still leave a large backlog pending. Do not claim the queue consumer runs on deployed Vercel until independently smoked there.

## Journey and states

| Step | Caller | State before → after | Failure state |
|---|---|---|---|
| Seed | Daily cron or authorized manual GET | Current durable cursors → one bounded verified poll and signed report | Poll failure returns 500; successful report remains valid if queue send fails. |
| Continue | Private Vercel push consumer | Scheduling counters → fresh bounded poll, optional successor message | Duplicate delivery meets existing lease/fence; source outage without progress ends chain; thrown error retries. |
| Recover | Next cron/manual call | Pending cursor/backlog → next bounded attempt | Expired/lost queue message never erases retained evidence. |

## Implementation and tests

1. Red pure tests for the sweep decision: one feed with staged progress chains; 25 feeds get three batches even when initially current; no-progress/unavailable stops; 128-call cap stops; malformed message rejected. Implement one small `src/lib/shared-continuation.ts` scheduler.
2. Red integration tests for pending-progress flags in the existing feed/registry pollers. Add `progressed` only to `pending` results, set it after durable target/staging transitions; preserve all prior statuses and acceptance rules. Derive shared `madeProgress`, feed count and selected count for scheduling.
3. Extract the existing shared poll/report body into one service used by cron and queue consumer. Add one queue adapter around SDK `send`, with local injection for route tests. Confirm a queue publish failure does not change the successful poll/report response. Add private `handleCallback` route and `vercel.json` trigger, then build/typecheck. Test exact route configuration and mock callback dispatch; external trigger behavior remains unverified until deployment.
4. Document setup, beta/Hobby constraints, bounded capacity and operational recovery; include a local real-Postgres multi-invocation test showing staged backlog finishes without actor/consumer coupling. Run lint, typecheck, unit, real-Postgres integration, build and diff checks. Review security of queue payload/logs and all changed names. No app source changes precede observer gates.

## Names and limits

`nextSharedContinuation` decides only the next scheduling counters; `runSharedPollCycle` owns one observer poll and its report cadence, not queue delivery. The daily cron refreshes the signed report timestamp. Queue polls sign a new aggregate only when accepted coverage or unresolved findings may have changed, avoiding full snapshot inserts for every staged page. `progressed` describes durable staging or acceptance, not cryptographic verification by itself. The 128-call cap is an operational safety bound, not a completeness limit; the daily cron can resume beyond it. A single queue push callback still runs inside the Vercel 60-second function ceiling. Local tests do not establish queue billing, production delivery or 24-hour observation.

## Verification record

The scheduler test was red before its module existed; pending-progress and route/deployment tests were red before their implementation. The independent review found repeated full aggregate report insertion during staged queue calls. A red cadence test and real-Postgres row-count assertion now require queue polls with unchanged coverage to skip signing/insertion, while daily cron and accepted coverage still sign. `pnpm lint`, `pnpm typecheck`, `pnpm test` (96), `pnpm test:integration` (31 pass, one opt-in skip), local Supabase-Postgres integration (31 pass, one opt-in skip), `pnpm build`, both benchmark smoke runners and `git diff --check` passed. Actual Vercel queue trigger delivery, Hobby cost and live third-party credentials remain unverified.
