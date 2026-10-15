# Feed Source Finding Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mark a feed source-nonconformance finding resolved once the observer accepts the exact signed checkpoint that produced it, while retaining the finding record and leaving cryptographic replay findings unresolved.

**Architecture:** Keep the existing observer findings table and acceptance transaction. Join the finding's recorded attempt to its immutable target, then resolve only when the accepted checkpoint table contains the same hash and signed bytes. The transaction already advances the report revision so a subsequent signed report reflects the current unresolved set.

**Tech Stack:** TypeScript, Postgres, Vitest real-database integration tests.

---

## Ground truth

- `src/lib/poll.ts:109-115` records source-protocol diagnostics as `source_nonconformance`.
- `src/lib/store.ts:637-655` attaches a new finding to the active attempt when one exists and advances report revision.
- `schema.sql:66-77` retains the signed target per attempt; `schema.sql:154-166` retains findings and resolution timestamps.
- `src/lib/store.ts:566-584` accepts replayed leaves/checkpoints and advances report revision in one transaction but does not resolve source findings.
- `src/lib/registry-store.ts:517-519` already resolves a corresponding registry source finding when an accepted chain contains its target.
- `test/poll.integration.test.ts:152-185` currently asserts the feed source finding remains unresolved even after catch-up.
- Unverified: deployed report freshness after recovery. Verify via local real-Postgres integration and signed-report tests; deployed Vercel smoke remains a separate deployment check.

## Journey and states

| Step | Caller | Route | Library | Model | State change | Failure state |
| --- | --- | --- | --- | --- | --- | --- |
| Poll malformed source | poll worker | `/api/shared-poll` or `/api/poll` | `pollObserverOnce`, `recordObserverFinding` | `observer_findings`, `observer_targets` | New unresolved source finding on active attempt | No accepted coverage advance |
| Poll repaired source | poll worker | same | `pollObserverOnce`, `acceptObserverTarget` | accepted checkpoints, targets, findings, cursor | Exact target accepted; matching source finding resolved; revision advances | Invalid retained replay quarantined |
| Report | observer signer | same | report signing in `store.ts` | signed report | Unresolved set excludes recovered source diagnostic | Prior signed reports remain historical |

## Changes

- `test/poll.integration.test.ts` — require source finding resolution after exact target acceptance and retention of the historical row.
- `src/lib/store.ts` — update matching attempt-bound source findings inside the existing acceptance transaction.
- `docs/architecture.md`, `README.md` — describe feed finding recovery accurately.

## Proposed names

| Name | Description | Name strain | Decision |
| --- | --- | --- | --- |
| None | This change adds no function, component, hook, or renamed symbol. | None | Use the existing acceptance transaction. |

## Test plan

| Behaviour | Layer | Assertion | Why |
| --- | --- | --- | --- |
| Recovered exact source target | Real Postgres integration | `resolved_at` becomes non-null, same row retained | Transaction and joins own this state |
| Rejected replay remains unresolved | Existing real Postgres integration | `invalid_replay` remains unresolved | Protects cryptographic finding semantics |
| Mutation | Real Postgres integration | Remove resolution statement temporarily and observe expected assertion failure | Confirms test covers new invariant |

## Principles check

- SRP/DRY: source finding resolution belongs in the accepted-target transaction, following the registry's accepted-chain pattern.
- YAGNI/KISS: no new schema, table, worker, API, or dependency.

## Smells and Boy Scout scope

- No new names or module structure. Replace the stale finding-resolution statement in touched documentation. Other observer lifecycle concerns remain outside this fix.

## Verification

- [x] Change integration assertion first and run `pnpm test:integration`; one expected failure on the null resolution timestamp.
- [x] Add the transactional resolution statement and rerun integration; 31 passed, 1 opt-in live-source test skipped.
- [x] Temporarily remove the statement and rerun integration; the recovery assertion failed again, then restore the statement.
- [x] Run `pnpm lint`, `pnpm typecheck`, `pnpm test` (96 passed), `pnpm test:integration` (31 passed, 1 skipped), `pnpm build`, inspect diff and `git status`.

### Task 1: Test and implement feed recovery

**Files:** `test/poll.integration.test.ts`, `src/lib/store.ts`

- [x] **Step 1: Write the failing test.** In the existing recovered-source test, assert that the retained finding's `resolved_at` is non-null after acceptance, keeping the original row-count assertion.
- [x] **Step 2: Run the integration suite.** Run `pnpm test:integration`; it failed because the timestamp was still null.
- [x] **Step 3: Add minimal acceptance SQL.** After inserting accepted checkpoints, update only unresolved `source_nonconformance` findings whose recorded attempt's target hash and signed bytes match an accepted checkpoint in the same feed.
- [x] **Step 4: Run integration and mutation checks.** Rerun `pnpm test:integration`, temporarily remove the SQL, confirm the recovery test fails, and restore it.
- [x] **Step 5: Update descriptions and verify.** Amend `README.md` and `docs/architecture.md`, run the verification commands above, then commit and push the fix.
