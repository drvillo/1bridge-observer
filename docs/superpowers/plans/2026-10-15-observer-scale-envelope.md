# Observer 100/1,000/10,000-leaf capacity characterization

## Ground truth

- The app signs one feed checkpoint per governed leaf (`ubo-guard/webapp/src/lib/authority/completion.ts:200-208`; `storage.ts:148-156`). The observer route currently budgets 12 checkpoint items per selected feed per daily invocation (`src/app/api/shared-poll/route.ts:36-40`; `vercel.json`).
- The fixed-target poller stages up to 100 checkpoints and 100 leaf pages per direct call, preserving a durable cursor (`src/lib/poll.ts:21-95`); the source limits each checkpoint page to 16 and each leaf page to 64 (`src/lib/source.ts:155-220`). The observer store's accepted-prefix cap is 10,000 leaves/10,001 checkpoints and 32 MiB (`src/lib/store.ts:503-543,662-663`).
- The authority library already generates and streams a 10,004-leaf mixed history under a 120-second test (`1bridge-authority/test/streaming-replay.test.ts:1-104`). Its component replay timing does not measure HTTP or durable observer storage.
- Unverified until this run: whether the current observer accepts the full 10,000-leaf policy-revision workload within repeated bounded calls, and what local per-call and total times it takes.

## Journey and states

| Step | Caller | Function | State before → after | Failure state |
|---|---|---|---|---|
| Prepare | Opt-in benchmark | Build signed 10,000-policy-revision fixture; serve size-specific prefixes | No database/source → immutable signed source | Invalid fixture aborts without an artifact. |
| Catch up | Benchmark loop | `pollObserverOnce` with 100-checkpoint/100-leaf-page limits and a 60-second paging budget | Empty accepted cursor → staged target → accepted target | `pending` retains exact state; source errors, invalid replay or ceiling become explicit measured outcomes. |
| Verify | Benchmark/SQL | Query accepted leaf/checkpoint counts and signed target | Claimed acceptance → corroborated DB rows and head | A mismatched claim aborts artifact writing. |

## Changes

- `test/scale.benchmark.ts`: generate one authority-root-signed policy history with a provider checkpoint after every leaf, then benchmark fixed targets at 100, 1,000, and 10,000 leaves against disposable Postgres and loopback HTTP. Record every poll's status, duration and request count, plus environment, source/build pins, final persisted counts, and explicit limits. Generate crypto, start source and install schema outside timed intervals. Use a hard 150-invocation ceiling per size so a stalled target becomes a recorded unsupported outcome. The 60-second budget covers paging; final replay and lease cleanup can exceed it. Persist each completed size so a later timeout does not discard earlier evidence.
- `test/benchmark-provenance.ts` and existing `test/poll.benchmark.ts`: share exact authority build/source cleanliness and Postgres image checks without changing the seven-leaf benchmark semantics.
- `vitest.scale.config.ts`, `package.json`, `test/integration-schemas.sql`: isolate an opt-in scale script with a pinned Postgres image and dedicated disposable schema.
- Research-artifacts repo: test the raw result before generation; publish its exact commit/environment/scope and retained samples. Do not extrapolate local results to Vercel, Supabase or a multi-tenant SLA.

## Proposed names

| Name | Responsibility | Strain decision |
|---|---|---|
| `readBenchmarkProvenance` | Verify and return source/dependency/image identity | One provenance concern; no conditional/caller suffix. |
| `buildScaleHistory` | Generate one signed policy-revision history | One fixture concern; report policy-only workload. |
| `measureScale` | Run and validate one size against one empty schema | One benchmark case; no product state change. |

## Test plan

| Behavior | Layer | Assertion | Why |
|---|---|---|---|
| Raw artifact is from clean exact source and immutable authority/Postgres pins, with 100/1,000/10,000 rows | Research Node test, red before artifact | Exact provenance/size list and bounded poll records | Prevents invented or stale measurements. |
| Each accepted size has contiguous persisted 100/1,000/10,000 leaves and size+1 checkpoints at the target hash | Opt-in real-Postgres benchmark assertion | Accepted claim and DB rows agree | Persistence is the measured boundary. |
| No record claims deployed or multi-tenant performance | Artifact test and method text | Explicit limitations and route-budget distinction | Keeps evidence narrower than claims. |

## Principles and Boy Scout scope

No new runtime dependency, schema migration or product route. The fixture is deliberately policy-heavy and cannot stand in for action-heavy latency. The clean prior seven-leaf result remains versioned by its source commit. Refactoring the shared benchmark provenance is behavior-preserving; smoke the old runner before and after. Review changed names and keep benchmark-only code outside production modules.

## Verification

Observe the research artifact test fail when absent. Run a one-size smoke with dirty-tree override to validate generation/polling, then commit the runner and run all three sizes from clean source into the research repository. Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm build`, `git diff --check`, and the research `pnpm test`. Review raw counts and limitations before publishing. Record unsupported outcomes rather than silently dropping them.
