# Fixed-target source verification increment

Status: implemented and independently reviewed on 2026-10-14. This increment verifies one complete fixed source target in a single process. It does not persist evidence, issue coverage statements, operate a cron, or claim production catch-up capacity.

## Ground truth

- `src/lib/source.ts` already discovers a provisional signed target, checks a configured independent anchor pin, and retrieves bounded canonical checkpoint and leaf pages. It deliberately does not authenticate a rotated checkpoint signer or replay the history.
- `test/governance-source.test.ts` currently performs that replay by gathering every leaf and checkpoint in test memory. Its fixture has two actors, an audit-policy change, a provider-key rotation, and signed wrong-root/wrong-policy targets. No product source route exists yet.
- The pinned authority release exports `createGovernanceReplaySession`, which verifies pinned genesis, bounded leaf pages, actor receipts, historical authority changes and each sealed checkpoint without exposing mutable state. A failed session must be discarded. Its process-local state and high-cardinality throughput are not proven for Vercel Hobby.
- The source wire contract in `docs/source-pull-contract.md` fixes a target hash and requires the full signed checkpoint chain and contiguous leaves; a source-provided `latest` is only a provisional view. `docs/persistence-plan.md` separately specifies the future accepted/staged cursor and fenced lease.

## Journey and states

| Step | Caller | Existing client / new verifier | Process state before → after | Failure |
|---|---|---|---|---|
| Pin and discover | Fixture or future poller | `verifyObserverAnchor`, `discoverFeedHead` | Independently configured pin → fixed provisional target | Wrong pin/feed/head rejects; transport outage is pending, not tampering |
| Fetch chain | Verifier | `fetchCheckpointPage` | Start → exact genesis → consecutive signed checkpoints through target | Gap, fork, noncanonical or changed target rejects |
| Replay each span | Verifier | `fetchLeafPage`, authority replay session | Contiguous tentative leaves → sealed accepted checkpoint | Wrong history root, action, authority root, policy or provider signer rejects; partial span is unaccepted |
| Finish | Verifier | Compare exact target bytes and return snapshot | Last sealed checkpoint → verified process-local prefix | Fixed target changed or incomplete chain never returns success |

No database state changes in this increment. A verified process-local prefix is not an independently retained observation or a guarantee about an unshown branch.

## Changes and proposed names

| Path / name | Responsibility | Name decision |
|---|---|---|
| `src/lib/verify-source.ts` / `verifySourceTarget` | Fetch one fixed target and replay its complete chain with bounded source pages | Single fetch-plus-verification responsibility; no persistence or coverage assertion |
| `test/verify-source.test.ts` | Exercise exact fixture through the public verifier and adversarial source variants | Assert authenticated domain result and rejection, not mocked function calls |
| `docs/source-client-profile.md` and README | State the verified-prefix capability and its unpersisted limits | Do not label the observer operational |

The function accepts an existing `ObserverConfig` and explicit leaf/checkpoint **count limits**. It refuses a target outside those limits with an incomplete-work error, distinct from cryptographic invalidity; a future durable poller will resume from staged state rather than bypass this cap. These counts do not bound elapsed time or memory across all source calls. Before a Vercel poll route uses this verifier, add a deadline and measured per-invocation work limit. This increment imports no new dependency and adds no new directory convention.

## Test plan

| Behaviour | Lowest layer | Domain assertion |
|---|---|---|
| Mixed valid feed, two actors and rotated provider key | Real local HTTP fixture + library | Final target hash, size, policy epoch and actor heads match signed fixture |
| Validly signed wrong history root or policy | Real local HTTP fixture | Discovery remains provisional; full replay rejects without returning a verified prefix |
| Wrong configured pin, missing genesis, changed/missing target page, skipped leaf | Real local HTTP fixture | No verified result and no false tamper finding from a temporary HTTP failure |
| Invocation budget exhausted | Pure guard / HTTP fixture | Explicit incomplete result/error; no accepted coverage claim |

The first public-API test failed because the verifier module was absent. The mixed fixture, invalid signed roots/policy, pin and budget tests then passed. Removing the exact final-target-byte guard made the alternate-valid-signature test fail because verification wrongly resolved; the guard was restored. Independent review found missing-page/outage test gaps, now covered through real HTTP fixture faults, including a later skipped leaf and a different valid last action whose root disagrees. After the final test addition, `pnpm test` passed 64 tests; `pnpm lint`, `pnpm typecheck`, `pnpm build` and `git diff --check` passed. The Next build compiles this module, but there is no production route or separately exported compiled package to smoke; the real HTTP Vitest fixture exercises its runtime. This increment does not touch the app; its gates start at app integration.

## Principles and scope

SRP: source client owns bounded transport/decoding, this verifier owns sequence and cryptographic replay, future store owns retention/CAS. DRY: call the authority session; do not reimplement historical signature or Merkle predicates. YAGNI/KISS: no trusted serialized replay cache, database mock, scheduler or new cryptographic scheme. Scoped Boy Scout work may clarify touched source-client errors separately from behavior changes; do not alter existing liveness semantics. Source-read authentication, independent receipt ingress, Postgres driver, and app release semantics remain separate pending decisions.
