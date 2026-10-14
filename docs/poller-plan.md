# Bounded durable pull increment

Status: poll core implemented and under verification, 2026-10-14. The application has no governance publisher yet; the HTTP source is a test fixture. This increment cannot claim a deployed independent observer or hidden-tail detection.

## Ground truth

- `src/lib/source.ts` discovers a provisional exact head and fetches canonical checkpoint and leaf pages under a fixed target. Each HTTP request is bounded, but these functions do not retain progress.
- `src/lib/store.ts` retains one fenced active target, staged source bytes, accepted replayed bytes, and replay-rejected findings. `claimObserverLease` gives a versioned lease; `stageObserverBatch` advances only staging; `acceptObserverTarget` replays the retained prefix under the independent pin before commit.
- `test/governance-source-fixture.ts` serves the shared mixed-history fixture and can make leaf requests unavailable. No production route invokes the store or source client.
- Unverified: provider machine-read authorization. The user has a pending question. The first poller test uses the local public fixture and must not settle the production authentication contract.

## Journey and states

| Step | Caller | Source/store state | Failure |
|---|---|---|---|
| Claim | Bounded invocation | Free/expired lease to fenced worker | Competing worker returns busy |
| Resume | Claimed worker | Existing exact active target/cursors remain fixed | No rediscovery replaces an active target |
| Discover | Claimed worker without target | Signed source head fixes new provisional target | Source outage leaves accepted head untouched |
| Pull | Worker | At most configured leaf/checkpoint pages stage exact bytes | Exhausted budget returns pending; no accepted head advance |
| Settle | Worker at target | Replay and accept, or retain replay-rejected attempt/finding | Missing page or transport outage never quarantines |
| Repeat | Later invocation | Accepted head matches source head | Up-to-date with no duplicate target |

## Changes and proposed names

| Path/name | Purpose | Decision |
|---|---|---|
| `src/lib/store.ts` `readObserverProgress` | Read target/cursors under current fenced claim | One read transaction, defensive return |
| `src/lib/poll.ts` `pollObserverOnce` | Advance a bounded amount of source evidence and settle a complete target | One orchestration function; no HTTP route or signing yet |
| `test/poll.integration.test.ts` | Prove offline resume, honest catch-up, invalid candidate and no-op on real Postgres | Lowest layer that sees HTTP and durable DB |
| `test/store.integration.test.sh`, `test/store.supabase.test.sh` | Give poll tests a distinct disposable schema | No application table touched |

The poller uses checkpoint pages of one item each. It fetches and stages leaf pages through that checkpoint's size, then stages the checkpoint. If a budget ends midway, the staged leaf cursor survives and the next run refetches the still-unstaged checkpoint. It never holds a database transaction over HTTP or cryptographic replay. The fixed target's signature bytes are compared when its checkpoint arrives. Each invocation has page-count and elapsed-time bounds; the lease is checked again on each store mutation. A transport failure returns a pending/unavailable result; structurally invalid source data is surfaced as an error until a durable source-protocol finding contract exists.

## Test plan

| Behavior | Layer | Assertion |
|---|---|---|
| One bounded invocation stops before the target | HTTP + real Postgres | Active attempt and staged bytes retained; accepted size stays zero |
| Worker resumes after offline source period | HTTP + real Postgres | Same attempt, complete replay, accepted final head, no skipped index |
| Source leaf outage | HTTP + real Postgres | Returns unavailable, keeps active target and accepted head unchanged |
| Signed but invalid candidate | HTTP + real Postgres | Exact attempt/finding retained; accepted size unchanged |
| Same accepted head | HTTP + real Postgres | No duplicate target or version advance |

## Principles and verification

The source client owns HTTP parsing, store owns durable facts and fencing, and the poller owns orchestration. No new dependency or directory convention is needed. Do not add a Vercel cron route before the source authorization and deployment contract is settled. Run red integration tests first, then `pnpm test`, `pnpm test:integration`, local Supabase integration, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `git diff --check`, and a deliberate guard mutation. The app source remains untouched.
