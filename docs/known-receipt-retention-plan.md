# Known Receipt Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retain exact externally supplied integrated receipts in customer-owned Postgres and bind the known set and its reconciliation status into scoped signed reports, without choosing an ingress transport or claiming every client receipt has arrived.

**Architecture:** A v3 observer migration adds immutable, feed-scoped canonical receipt bytes keyed by the portable library's receipt hash. A store call snapshots and validates the receipt, inserts it idempotently, and advances the existing signed-report revision only for a new retained receipt. Report publication replays retained source evidence under the independent pin, compares every retained receipt to that accepted prefix, signs a sorted receipt-set digest, and includes deterministic unresolved-status hashes. The caller is trusted to supply externally held evidence; no HTTP ingress is introduced here.

**Tech Stack:** TypeScript, `@drvillo/1bridge-authority`, `pg`, PostgreSQL 17/Supabase, Vitest.

---

## Ground truth and boundaries

- `src/lib/store.ts:199-231` installs v1 and v2 under one transaction, checks the installed catalog fingerprint before migration, and derives exact SQL-file digests. The v2 marker rejects version 3, so the installer must skip old migration scripts once v3 is installed.
- `schema-v2.sql:1-75` freezes the prior v1-to-v2 migration and creates signed reports; do not edit it or `schema.sql`.
- `src/lib/store.ts:740-814` can compare caller-supplied receipts against a replayed accepted prefix, but retains none. `src/lib/store.ts:643-739` signs `knownReceipts: none` and checks `report_revision` before insertion.
- `src/completion-receipt.ts` in the pinned authority package constrains the integrated receipt to 8 KiB and exports `completionReceiptHash`; the observer's `src/lib/store.ts:1-9` already imports it.
- Unverified: transport authentication and whether clients may asynchronously copy receipts into customer-controlled storage. This plan neither chooses nor exposes ingress; it also does not treat an unverified stored receipt as proof of provider misconduct.

## Journey and states

| Step | Caller | API | Database before → after | Failure state |
|---|---|---|---|---|
| Install | Customer observer startup | `installObserverSchema` | Valid v1/v2 → v3 marker plus empty receipt table | Drift or partial DDL rolls back |
| Retain known receipt | Trusted future ingress or operator importer | `retainKnownReceipt(store, feedId, receipt)` | No row → exact canonical bytes and revision +1 | Wrong feed, malformed receipt or changed duplicate rejected |
| Retry retained receipt | Same caller | Same API | Existing exact row and unchanged revision | Different bytes for same identity rejected |
| Compare and report | Observer poll/report path | Existing `reconcileRetainedReceipts`; `publishObserverCoverage` | Accepted prefix unchanged → signed report binds known receipt set and unresolved statuses | Future head remains pending; forged receipt remains unmatched, neither alone proves misconduct |

## Files and proposed names

| File | Responsibility |
|---|---|
| `schema-v3.sql` | Version-checked, catalog-fingerprinted migration for `observer_known_receipts` |
| `src/lib/store.ts` | Install v3 and persist one canonical, feed-scoped receipt with revision fencing |
| `test/store.integration.test.ts` | Real Postgres migration/idempotence/catalog assertions |
| `test/report.integration.test.ts` | Real Postgres receipt-retention/revision and signed report assertions |
| `test/store.integration.test.sh`, `test/store.supabase.test.sh` | Existing disposable databases; no new schema name needed |
| `README.md`, `docs/architecture.md` | Exact archive scope and non-claims |

`retainKnownReceipt` has one responsibility: persist an independently supplied exact receipt. It does not authenticate the ingress or evaluate source truth. `publishObserverCoverage` owns scoped report publication, reusing the existing replay and report-signing boundary. No new dependency or directory convention is added.

## Task 1: v3 migration and installer

**Files:** Create `schema-v3.sql`; modify `src/lib/store.ts`, `test/store.integration.test.ts`.

- [ ] **Step 1: Add failing integration expectations.** In `test/store.integration.test.ts`, change the fresh/repeat marker assertions from 2 to 3; assert `to_regclass('observer_test.observer_known_receipts')` exists. In the populated-upgrade case, assert the v1 feed survives a v1→v2→v3 install and that a repeated install preserves version 3. Add a separate v2→v3 case by executing frozen v1 and v2 SQL with their exact digests, retaining the existing feed/cursor rows, then calling the installer; assert those rows survive and version becomes 3. Assert a same-name non-unique replacement for the new receipt index causes repeat installation to reject catalog drift.
- [ ] **Step 2: Run `pnpm test:integration` and observe the expected marker/table assertion failure.** The failure must name version 2 or the missing receipt table, not a fixture setup error.
- [ ] **Step 3: Add `schema-v3.sql`.** Require a v2 marker with the exact v2 digest, or a v3 marker with the exact v3 digest. Under the existing advisory transaction lock create:

```sql
CREATE TABLE IF NOT EXISTS observer_known_receipts (
  feed_id text NOT NULL REFERENCES observer_feeds(feed_id) ON DELETE RESTRICT,
  receipt_hash text NOT NULL CHECK (receipt_hash ~ '^[0-9a-f]{64}$'),
  leaf_index bigint NOT NULL CHECK (leaf_index BETWEEN 0 AND 9007199254740991),
  checkpoint_hash text NOT NULL CHECK (checkpoint_hash ~ '^[0-9a-f]{64}$'),
  receipt_bytes bytea NOT NULL CHECK (octet_length(receipt_bytes) BETWEEN 1 AND 8192),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (feed_id, receipt_hash)
);
CREATE INDEX observer_known_receipts_feed_index_idx
  ON observer_known_receipts(feed_id, leaf_index);
```

  The SQL preflight must count eleven observer-owned tables on repeat, then update marker version/digest only from v2. Recompute and store the exact catalog fingerprint using the established v2 fingerprint block after DDL; a repeat must compare and reject drift.
- [ ] **Step 4: In `installObserverSchema`, read and hash v3, execute v1 only for null/1, v2 only for null/1/2, then v3 for null/1/2/3.** Set `observer.previous_schema_digest` to the v2 digest immediately before v3 and `observer.schema_digest` to v3. A marker outside 1–3 throws before any DDL.
- [ ] **Step 5: Run `pnpm test:integration`; inspect the version, upgrade and drift assertions.** Run `pnpm typecheck` after `pnpm build` or in a separate step because the build rewrites `.next/types`.
- [ ] **Step 6: Commit only migration, installer and test files on the feature branch.** Report publication remains at `knownReceipts: none` until Task 3, so this intermediate commit must not be pushed as a release.

## Task 2: immutable receipt retention

**Files:** Modify `src/lib/store.ts`, `test/report.integration.test.ts`, `README.md`, `docs/architecture.md`.

- [ ] **Step 1: Add a failing real-Postgres test.** Register the existing mixed-history feed, call `retainKnownReceipt(store, feedId, history.firstReceipt)`, then query exact canonical bytes, `receipt_hash`, `leaf_index`, checkpoint hash and `report_revision=1`. Retry the same receipt and assert one row and unchanged revision. Retain `history.secondReceipt` and assert two rows and revision 2. Assert a wrong-feed or malformed receipt leaves rows/revision unchanged. Use the existing `history.firstReceipt` fixture and `authority.canonicalBytes`/`completionReceiptHash`; no mock database.
- [ ] **Step 2: Run `pnpm test:integration` and observe the expected missing-export failure.**
- [ ] **Step 3: Implement `retainKnownReceipt(store, feedId, receipt): Promise<{ receiptHash: string; inserted: boolean }>` in `src/lib/store.ts`.** Synchronously snapshot with `parseCanonical(canonicalBytes(receipt))`, validate/hash with `completionReceiptHash`, require `receipt.feedId===feedId`, derive `checkpointHash(receipt.checkpoint.statement)`, and use one `transaction` with `SELECT report_revision FROM observer_cursors WHERE feed_id=$1 FOR UPDATE`. Enforce at most 10,000 receipts and 16 MiB exact archived bytes per feed, matching the bounded report computation. Insert with `ON CONFLICT DO NOTHING`; if inserted, increment `report_revision` and return true. If not inserted, select `receipt_bytes` for the exact hash and compare bytes; reject a mismatch and return false only for byte-identical retry. Do not verify the source checkpoint or mutate accepted coverage here.
- [ ] **Step 4: Run integration and mutation checks.** Deliberately remove the revision increment and observe the new test fail, then restore it. Test that mutating the caller's receipt immediately after invoking the async method cannot alter stored bytes; if it fails, move all input copying before the first `await`.
- [ ] **Step 5: Commit the store/test change on the feature branch, but do not push this intermediate commit.** Signed reports still need Task 3 to describe the retained set honestly.

## Task 3: receipt-aware signed coverage

**Files:** Modify `src/lib/store.ts`, `test/report.integration.test.ts`, `README.md`, `docs/architecture.md`.

- [ ] **Step 1: Add failing integration assertions.** After archiving two receipts and accepting the full mixed-history source, `publishObserverCoverage` must sign `knownReceipts: {kind:'known_archive', count:2, digest:observerEvidenceSetDigest(sortedReceiptHashes)}` and zero unresolved receipt findings. In the partial-prefix test, archive a valid future-head receipt, sign the partial-prefix report, and assert one unresolved finding committed to that report; after the full source is accepted, sign a new revision and assert that the receipt is matched and the derived unresolved count disappears. A malformed or cross-feed receipt must never enter the archive. Retrying a receipt must not issue a second report revision.
- [ ] **Step 2: Run `pnpm test:integration` and observe the known-receipt scope assertion fail.**
- [ ] **Step 3: Extend the existing report material transaction to read sorted `observer_known_receipts` rows under the same cursor revision, with the 10,000-row/16-MiB bounds.** Reuse the exact hash/bytes checked at retention. Compute `observerEvidenceSetDigest(receiptHashes)` only for nonempty archives; otherwise preserve `{kind:'none',count:0,digest:null}`. Replay the accepted source once with `createGovernanceReplaySession`, then sequentially call `verifyReceipt` for every archived receipt whose checkpoint is within the accepted prefix. For pending or unmatched receipts, derive `observerFindingHash(canonicalBytes({version:1,kind:'observer.known_receipt_unresolved',feedId,receiptHash,status,coveredCheckpointHash}))`; union/sort those hashes with retained finding hashes before `observerEvidenceSetDigest`. A pending/invalid archived receipt is an unresolved evidence item, not a tampering verdict.
- [ ] **Step 4: Keep the existing report-revision compare-and-swap.** A receipt inserted after the material read must cause report insertion to reject as changed evidence; the next poll can retry. Store the signed report only after the full known set and unresolved digest are computed.
- [ ] **Step 5: Mutation-check the invariant.** Temporarily omit archived receipt hashes from the signed report and observe the new test fail; restore the digest computation.
- [ ] **Step 6: Document exact scope and run all gates.** Describe configured-caller receipt custody, 10,000/16-MiB archive bounds, pending versus unmatched meaning and the fact that archive membership is not completeness. Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, local Supabase integration, `pnpm build`, `git diff --check`; obtain code review, commit and push only once all pass.

## Principles and verification

- **SRP:** migration owns schema, store owns immutable receipt retention, replay owns source comparison, route authentication remains separate.
- **DRY:** use the portable receipt hash and existing transaction helper; do not add another receipt parser or crypto implementation.
- **YAGNI:** no speculative HTTP ingress, queue, issuer policy or source accusation in this increment.
- **KISS:** one receipt row per canonical hash and one cursor revision on first insertion.
- **Boy Scout:** preserve frozen v1/v2 migrations and use the current catalog guard rather than silent `IF NOT EXISTS` upgrades.
- **Final gate:** the real Postgres and local Supabase suites must prove fresh install, repeat install, both upgrade paths, changed-catalog rejection, exact receipt idempotence, revision tracking, signed known-set scope and pending-to-matched report evolution. Unit tests, lint, typecheck and production build must also pass. These checks prove retention and reconciliation for supplied receipts, not global receipt availability or complete independently observed coverage.

Ingress selection, authenticated client copying and app integration remain dependent on the user decisions already requested. No provider response can prove that the customer archive holds every receipt.
