# Independent observer architecture and implementation order

Status: design contract, 2026-10-14. A runnable Next.js bootstrap with configuration validation and a liveness-only route exists; no poll, independent verification, persistence or deployed observer is claimed. The user selected a public, customer-run, TypeScript observer that pulls 1bridge, supports Vercel and ordinary Postgres/Supabase, and never participates in a release decision. This design uses the separately approved 1bridge D1–D4 shared architecture.

## Ground truth and trust boundary

- The public authority library currently implements RFC 9162 roots/proofs and a history frontier, canonical encoding, P-256 signatures, an ordered map, audience commitments and signed checkpoints (`../1bridge-authority` is a sibling checkout; see its `src/index.ts`). Signed actions, receipts and authority replay are still in progress. The observer must import accepted exports rather than inventing parallel cryptography.
- The provider app currently has no governance pull endpoint or authority journal (`ubo-guard/.planning/research/1bridge-verifiable-governance-design-review.md` is a design lead, not deployed evidence). Fixture endpoints can exercise the observer before app integration.
- [Vercel Hobby cron](https://vercel.com/docs/cron-jobs/usage-and-pricing) permits a daily schedule with hour-level timing; [Functions](https://vercel.com/docs/functions/limitations) have bounded execution. [Vercel Queues](https://vercel.com/docs/queues) are available on all plans in beta, but queue messages are wake-ups rather than independent evidence retention.
- The observer operator independently pins the feed identity, customer root and authorized provider checkpoint key. A key supplied solely by the source cannot authenticate the source. The operator controls its own signing key, Postgres credentials and Vercel project. It never receives the provider Supabase service-role key.

## Journey and states

| Step | Caller | Before → after | Failure behavior |
|---|---|---|---|
| Configure | Customer operator | Independently verified pins and source URL → local feed config | Invalid or changed trust anchor rejects; source cannot silently replace it |
| Discover | Daily cron or authorized manual trigger | Durable old head → fixed signed target head | Timeout/outage records availability state; no false fork accusation |
| Pull | Worker | Cursor below target → bounded contiguous canonical leaf batch | Missing index, duplicate, wrong bytes or size leaves durable unresolved range |
| Verify | Worker with authority library | Supplied batch → checked history/authority/action state | Invalid signature, transition, map root or proof records finding, stops advancement |
| Commit | Worker and own Postgres | Verified batch and cursor → one durable transaction | Redelivery/competing workers compare prior cursor/head; no skipped batch |
| Report | Observer signer | Exact verified head/coverage and unresolved findings → signed statement | A partial batch never produces full-head coverage |

An observer outage does not change 1bridge's normal or Enterprise/Government strict-auditing release behavior. Strict mode strengthens configured checks, durable findings and signed reporting without witness-before-release.

## Deployment and data ownership

Use TypeScript and a Node runtime compatible with the current 1bridge Next.js/Vercel ecosystem. A Vercel-hosted worker exposes a CRON_SECRET-protected invocation and a separately authorized manual continuation path. One invocation handles bounded bytes/items/time; daily cron starts or resumes the backlog. Queued continuations may accelerate catch-up, but a lost/expired queue message cannot erase the durable Postgres cursor or findings. A self-hosted command must call the same poll core. The implementation plan will pin actual package versions and scripts when the shared library API is final.

The customer's Postgres owns configured feeds/pins, accepted checkpoints, exact processed leaf hashes and replay state, cursors/lease tokens, independent retained receipts, unresolved gaps/conflicts, and signed coverage statements. The schema must work unchanged with ordinary Postgres or a customer Supabase Postgres URL. Keep migrations in this repository. Use parameterized SQL and a single client for each transaction; no DB transaction spans a network call. Lease expiry controls duplicate work, while head/cursor compare-and-swap controls correctness under competing invocations.

The source read API will expose one fixed target signed checkpoint, every intervening signed checkpoint since the observer's retained head, contiguous ranges addressed by exact start/limit/target size or ID, and the historical authority material needed to replay each event. The authority library's checkpoint `previous` refers to the immediately preceding signed statement, so jumping directly from an old head to a latest head is insufficient after missed publications. Route names and JSON envelopes will be fixed in a shared contract before implementation. The observer validates response bytes rather than trusting pagination metadata. It cannot assert that a source response is globally latest merely because it is well signed.

## Detection and limits

A signed receipt retained outside provider control names a completed event/index/head. If a later pulled feed omits it, the observer retains an unresolved gap or a cryptographic conflict once contradictory signed material is available. An unanswered request is an availability failure, not proof of tampering. Signed incompatible heads prove equivocation to a verifier that receives both. A source-only pull cannot detect an entirely hidden, coherent branch without independent evidence of it. Client-originated asynchronous receipt archive is the recommended independent channel; exact ingress authorization and retention are not part of the first pull-only increment. The provider never pushes events to this observer.

## Implementation phases and tests

1. Finish the authority library's checkpoint, action/authority replay and receipt verification contracts. Freeze shared fixture vectors and import the tested package. No app source edit occurs here.
2. Implement a deterministic source fixture and pure bounded pull/verify state machine. Test outage, malformed payload, rollback, fork, missing index, wrong authority transition, partial progress, and honest no-op polling with failing tests first.
3. Implement customer-owned Postgres migrations/repository and test real transactions, crash points, concurrent workers, replay and retained findings on both ordinary Postgres and a Supabase-compatible connection path.
4. Add Vercel/Node invocation, daily cron setup, bounded continuation, configuration validation, signing key custody, manual operation, and reproducible deployment guide. Build and run a deployed preview smoke; document any environment that could not be exercised.
5. Add independent receipt ingestion/reconciliation once the retention transport is settled; test an offline backlog and a known withheld tail, including the negative case where no independent copy exists. Run cross-repo fixtures before touching 1bridge application source.

The Next.js bootstrap passed package build, lint, typecheck, unit and production HTTP liveness checks. No poll, Postgres test, Vercel deployment or audit report is claimed yet.
