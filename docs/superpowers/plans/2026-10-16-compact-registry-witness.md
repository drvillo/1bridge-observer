# Compact registry witness implementation plan

**Status:** authority contract and observer compact poll, v5 store, findings, signed report, public read route and daily cron implemented, reviewed and locally tested on disposable Postgres and Supabase Postgres. The old per-feed endpoints remain as version-1 compatibility code; they are no longer scheduled. A third-party production deployment, app-side inclusion/feed comparison, real-source smoke test and research-article update remain pending. See the coordinating 1Bridge D3 plan (`.planning/research/1bridge-d3-compact-witness-refactor-plan.md` in the app worktree).

The current authority signer caps unresolved finding IDs at 10,000. The v5 store resolves transient proof failures when their exact target is validly accepted, and the public read route rejects a report whose signed finding set no longer matches durable state. A sustained malicious source capable of exhausting that active bound remains an explicit operator-alert condition, not a claim of unlimited observer availability; the app does not wait for it.

**Goal:** Independently witness one global signed Merkle registry as an append-only sequence of roots. Poll autonomously from 1Bridge, retain accepted signed roots in observer-owned Postgres, and publish a small signed global statement. No customer feed list, customer token, feed replay, receipt ingress, push from 1Bridge or release dependency.

## Ground truth

- `src/lib/shared-poll.ts:22-59` calls `pollRegistryOnce`, reads discovered feeds and invokes `pollObserverOnce` for each selected feed. `src/lib/registry-poll.ts:87-117` stages entry and checkpoint pages. `src/lib/aggregate-store.ts:1-85` signs per-feed aggregate coverage; `src/app/api/shared-reports/status/route.ts` serves a feed proof. These are the paths to retire from the shared profile after v2 passes.
- `src/lib/registry-source.ts:131-157,226-239` already parses bounded signed heads and consistency paths; reuse it. `src/lib/config.ts:107-137` independently pins publisher SPKI and signed empty genesis; retain that trust boundary.
- `src/lib/shared-poll-run.ts:8-12` budgets 45 seconds and 12 feed selections; `vercel.json:1-13` schedules one daily cron and a queue consumer. A compact poll should need one head request and, after genesis, one consistency request. Verify measured duration before removing the queue trigger and dependency.
- The authority library's `verifyRegistryExtension` requires an immediately linked `previous` hash; for an old-to-latest jump verify each endpoint signature and call `verifyConsistency` over sizes/roots. This proves tree-prefix consistency, not the validity of skipped checkpoint metadata or of feed/action leaves (`../1bridge-authority/src/registry.ts:137-149`; `src/history.ts:138-175`).

## Journey and states

| Step | Caller | Route | Function / store | State before → after | Failure |
|---|---|---|---|---|---|
| Poll | Daily cron or authorized manual call | `/api/shared-poll` | `pollRegistryWitnessOnce` | Retained root → candidate signed head | Source outage: retain root, report stale/pending. |
| Verify | Poller | 1Bridge `/registry/head`, `/registry/consistency` | Authority portable verifier | Candidate → authenticated append-only target | Bad signature/path, smaller size or same-size fork: finding, no cursor advance. |
| Commit | Poller | None | Postgres witness store with CAS/lease | Old accepted root → signed target retained exactly once | Competing invocations retry or report busy. |
| Report | Poller/read API | `/api/registry-witness/latest` | Observer signer | Accepted root → versioned signed statement with time/findings | Never call a per-feed status proof `verified`. |

## Changes and tasks

1. **Characterize v1 first:** keep its integration test green while recording the exact v1 report shape and endpoint behavior. Add a v2 protocol vector in the authority package, publish/pin its immutable commit, then add a failing unit test that demands a valid old-to-latest Merkle jump without fetching `entries`, `checkpoints` or `/feeds/`.
2. **Implement the small poller:** validate pinned genesis, signed target, sizes, same-size equality and Merkle consistency; use `discoverRegistryHead` and `fetchRegistryConsistency`. Classify source outage separately from a cryptographic conflict. Retain exact conflicting signed bytes and proof failure evidence, not just an error string. No network call inside a SQL transaction.
3. **Implement v5 store/report:** leave v1-v4 migration files unchanged; add a v5 migration with a pinned genesis, accepted head history, findings and signed v2 report rows. Use a singleton CAS/lease to prevent concurrent replacement. Verify stored bytes on restart and report read. Existing v1 aggregate rows remain historical and must not be interpreted as v2. Test fresh install, v4 upgrade, tampered retained bytes, race and restart in disposable Postgres and Supabase-compatible Postgres.
4. **Cut shared routes over:** `/api/shared-poll` runs only the compact poller; publish a versioned global report route. Keep old public aggregate routes clearly marked v1 during app transition, then remove or archive them. Update `vercel.json`, remove the queue consumer, scheduler and `@vercel/queue` only after an outage/backlog fixture demonstrates the single bounded poll resumes to the latest root on the next trigger. Do not delete legacy single-feed code unless a consumer audit establishes it is unused; it is separate from the shared contract.
5. **Integration and docs:** with the real 1Bridge source, test two feeds but assert the observer requests only global `head`/`consistency`. Poll an old root after many publications; verify the exact accepted target and signed report. Test wrong publisher key, inconsistent larger root, same-size fork, source outage, duplicate poll and no-release coupling. A later action Y citing hidden X is deliberately *not* observer-detected in this profile: add a negative fixture so future prose cannot claim otherwise. Update README/architecture, deployment env and Vercel instructions before publishing this as current behavior.

## Proposed names

| Name | Meaning | Decision |
|---|---|---|
| `pollRegistryWitnessOnce` | One global signed-root observation attempt | New poller. |
| `acceptRegistryWitness` | Atomically retain one consistent candidate root | Store API. |
| `publishRegistryWitness` | Sign the accepted root and observation time | Report API. |

## Test plan

| Behavior | Layer | Required red check |
|---|---|---|
| Signed old-to-latest consistency | Authority unit and observer HTTP fixture | Invalid signature/path fails; skip intermediate checkpoints succeeds. Mutate root comparison and watch failure. |
| Durable conflict/race | Disposable Postgres integration | Conflicting root never overwrites old accepted root; two pollers converge or one is busy. Bypass CAS and watch failure. |
| Bounded data exchange | Observer HTTP fixture | No registry `entries` or `/feeds/` requests; report bytes stay nearly constant as feed count rises. Reintroduce a feed call and watch failure. |
| Vercel contract | Route test/build | Cron auth, unavailable source, fresh signed report and no queue trigger work. |

## Principles check

SRP: the observer authenticates global publication only; the customer's verifier handles individual actions. DRY: reuse authority Merkle/signature primitives. YAGNI/KISS: no per-feed shared state, action replay, queue-as-coordination or second audit log. The v2 API is explicitly versioned; old v1 `verified` semantics are never silently reused.

## Smells and Boy Scout scope

`src/lib/store.ts` and `registry-store.ts` contain v1 concerns. Isolate v2 tables and persistence with small named operations; remove shared-only dead code after characterization. Do not combine HTTP, crypto and SQL in a single function. Preserve legacy single-feed consumers if discovered; report the audit result.

## Verification

Run focused red/green tests after each task, then once at the end: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm build`, the opt-in running-1Bridge HTTP contract and `git diff --check`. Run the same schema suite against a Supabase Postgres URL. Record actual Hobby-function proof/poll latency before claiming a bounded freshness target. Deployed third-party cron, independently delivered pins and any SLA remain unverified until a deployed smoke test.
