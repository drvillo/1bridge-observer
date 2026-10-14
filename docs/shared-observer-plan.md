# Multi-tenant pull observer implementation plan

Implementation contract and verification record. The shared profile is additive; the original single-feed routes remain available separately.

**Goal:** Run one independent Vercel observer for every 1Bridge plan, discovering all pseudonymous workspace feeds from a single pinned public registry and reporting exact verified and pending coverage.

**Architecture:** Poll a fixed signed global-registry target first, stage and replay its contiguous entries in observer-owned Postgres, then reuse the current per-feed verifier against each advertised checkpoint. Publish an aggregate signed statement only for the registry head and feeds actually accepted. A feed outage or observer outage changes coverage freshness; no 1Bridge release waits for this service.

**Tech stack:** Existing Next.js 16 API routes, `pg`, Postgres/Supabase, `@drvillo/1bridge-authority`, Vitest, daily Vercel Hobby cron. No new runtime dependency.

## Ground truth and compatibility

- `src/lib/config.ts` requires one `FEED_ID`, `ANCHOR_PIN`, `SIGNED_ANCHOR`; `src/app/api/poll/route.ts` invokes `pollObserverOnce` for that feed. This is not yet the shared deployment profile.
- `src/lib/source.ts` already fetches bounded fixed-target feed pages. `src/lib/poll.ts` stages feed pages under a fenced lease. `src/lib/verify-source.ts` replays per-feed authority/action history. Keep this verifier as the inner component.
- `src/lib/store.ts` tables are keyed by `feed_id`. Add one registry cursor/entry catalog and aggregate reports; do not duplicate per-feed event tables.
- The authority library's `createRegistryReplaySession` validates registration signatures and global append-only history. Its `signAggregateReport` distinguishes a completely verified advertised head from a pending feed. A signed registry entry alone never counts as validated authorization.
- A shared deployment has one `SOURCE_BASE_URL`, pinned registry publisher key/genesis, observer-owned DB/schema, observer signing key and cron secret. It has no per-customer source token, identity mapping, customer private key or customer-configured feed list. This public-source profile requires 1Bridge to publish pseudonymous verification envelopes.

## Source and storage contracts

- `GET /api/governance/v1/registry/head` returns exact signed registry checkpoint bytes and statement hash. An accepted target cannot change during a run.
- `GET /api/governance/v1/registry/checkpoints?target=<hash>&after=<hash|start>&limit=<1..16>` returns the complete, consecutive signed checkpoint chain to the fixed target. Offline catch-up must fetch missed checkpoints because each statement cites its immediate predecessor.
- `GET /api/governance/v1/registry/entries?target=<hash>&start=<index>&limit=<1..64>` returns canonical contiguous byte entries bound to the fixed target. A returned range must be nonempty until the target size is reached, and no entry may exceed 32 KiB.
- `GET /api/governance/v1/registry/consistency?old=<hash>&target=<hash>` returns the RFC 9162 consistency path. This is required even though complete local entry replay also checks the root.
- Registry tables retain signed genesis, accepted target/hash/size, exact canonical entries, provisional target and page cursor, lease epoch/owner/expiry, and permanent findings. Stage before accepting. A crash resumes the same fixed target; a fork is retained as a finding.
- Feed records store each discovered signed anchor/pin and latest advertised checkpoint bytes/hash/size. Each feed poll is pinned to that registry checkpoint, not an independently discovered mutable latest head. Reuse existing per-feed fenced staging and Postgres rows. One unavailable/invalid feed is marked pending/invalid while other feeds proceed.
- Aggregate reports commit one accepted global registry head and separate Merkle roots/counts of sorted verified and pending feed-status records plus findings. A public status-proof endpoint must return the exact record and Merkle path for a requested pseudonymous feed ID, so a customer can inspect its own pending/verified state. The report identifies publication coverage and validated authorization separately. Per-feed reports remain available for detailed proof.

## Proposed names and files

| Path | Responsibility | Proposed name / design note |
|---|---|---|
| `src/lib/registry-source.ts` | Bounded fixed-target global HTTP fetch and response validation | `discoverRegistryHead`, `fetchRegistryCheckpointPage`, `fetchRegistryEntryPage`, `fetchRegistryConsistency`; each does one request kind. |
| `src/lib/registry-poll.ts` | Registry catch-up and durable staging | `pollRegistryOnce`; feed polling is a separate scheduler loop. |
| `src/lib/config.ts` | Shared deployment config and independent pin validation | `loadSharedObserverConfig`, `loadSharedReportReadConfig`, `verifyRegistryPin`; retain existing per-feed config for the legacy profile. |
| `src/lib/poll.ts` | Accept an explicitly advertised per-feed fixed target | `pollObserverOnce` gains a target argument; existing feed verifier stays one responsibility. |
| `src/lib/registry-store.ts`, `src/lib/aggregate-store.ts`, `schema-v4.sql` | Registry staging, feed discovery and aggregate report persistence | `stageRegistryEntries`, `acceptRegistryTarget`, `readRegistryFeeds`, `publishAggregateCoverage`; use current schema upgrade/fingerprint pattern. |
| `src/app/api/shared-poll/route.ts` | Shared cron orchestration | Fetch registry, then bounded round-robin feeds; never call 1Bridge from a DB transaction. |
| `src/app/api/shared-reports/latest/route.ts`, `src/app/api/shared-reports/status/route.ts` | Public signed aggregate and feed-status proofs | Explicit report scope; do not imply full verification when pending. |
| `test/registry-source.test.ts`, `test/registry-poll.integration.test.ts`, `test/shared-route.integration.test.ts` | Adversarial source and real Postgres resume/fencing checks | Consume the frozen authority fixture without regenerating expected values. |

## Tasks and gates

### 1. Pinned registry source

- [ ] Write failing unit tests for the frozen two-feed registry vector, wrong publisher key, skipped checkpoint predecessor, malformed/forked target, oversized/empty/out-of-order pages and URL downgrade/redirect. Run focused Vitest and confirm each fails for the contract gap.
- [ ] Implement bounded source calls and independent registry pin configuration. Keep timeouts within Hobby function duration.
- [ ] Run focused tests, lint, typecheck and build; commit.

### 2. Durable registry catch-up

- [ ] Write failing disposable-Postgres tests for fresh registration, two-target offline backlog, staged-page crash/retry, two concurrent cron invocations, lease expiry/fence, fork quarantine and Supabase search-path compatibility.
- [ ] Add v4 schema upgrade and cursor functions. Replay exact stored bytes with the authority library before committing a new accepted registry head.
- [ ] Run unit and Postgres/Supabase integration tests, SQL fingerprint/schema checks, lint, typecheck and build; commit.

### 3. Feed verification from discovery

- [ ] Write failing tests that two discovered feeds are polled with no customer-specific env, and that a source showing a different mutable head cannot move a feed beyond its registry-advertised fixed target.
- [ ] Pass the registry target/anchor to the existing per-feed poller. Verify authority transitions, actor signatures, predecessor receipts and Merkle history using the existing replay contract. Persist per-feed accepted/pending/invalid state.
- [ ] Test one unavailable feed and one valid feed: the latter is verified, the former remains pending, and neither affects product operations. Run all observer gates; commit.

### 4. Reports and deployment

- [ ] Write failing tests for aggregate statement contents, pending set, invalid-feed finding retention, source outage, report reader auth and public verification from the independently pinned registry key.
- [ ] Publish exact signed aggregate and per-feed reports from observer-owned database state. Document setup for independent Vercel + Postgres/Supabase operator, source endpoint limits, secrets, key custody, schema migration and catch-up operation.
- [ ] Pin the tested authority Git commit; run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, Supabase SQL checks and `pnpm build`. Smoke a Vercel deployment and GitHub CI. Only then mark the standalone-repository gate ready for 1Bridge app changes.

## Limits and threat cases

The observer detects rewrites of witnessed registry/feed prefixes, unauthorized published actions, omitted predecessors required by later published signed actions, and missing advertised ranges. It cannot infer an event hidden from every independent witness and receipt holder. A source outage is pending, not automatically tampering. Registry registration proves key possession relative to a pseudonym; customers compare their own retained anchor pins. The report does not certify private effect openings or real-world organizational identity. Enterprise customer-operated single-tenant observers are a future deployment profile, not an alternative required for this shared service.
