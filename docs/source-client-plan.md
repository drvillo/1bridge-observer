# Bounded pull client and fixture publisher plan

> Planned observer increment. The frozen source wire contract is `docs/source-pull-contract.md`. This increment fetches and parses a fixed target; it does not persist evidence, report coverage or assume a customer-approved feed-read credential scheme.

## Ground truth

- The repository currently has `src/lib/config.ts` for source URL, feed ID, independent pin/anchor, database URL and cron secret. `verifyObserverAnchor` calls the authority library to verify the pinned anchor and initial provider key. There is no source client, fixture publisher or poll route.
- The public authority dependency is presently pinned to `d9c37ec` in `package.json`; update to a separately reviewed immutable revision only after full mixed replay is accepted/published. The initial pin does not authenticate a later head signed by a rotated provider key.
- `docs/source-pull-contract.md` fixes exact canonical JSON envelopes, bounded `head`, `checkpoints` and `leaves` GET routes, a provisional head selector, immediate checkpoint chain and contiguous positions. It correctly limits suppression detection to evidence the observer receives or independently retains.
- A proposed `SOURCE_READ_TOKEN` is pending the user's decision because it adds an app-issued machine credential. Until decided, fixture tests can pass an explicitly supplied header but production config must not silently introduce that auth convention.

## Journey and states

| Step | Caller | Before → after | Failure |
|---|---|---|---|
| Discover | Manual/cron poll core | Configured feed → structurally valid provisional head bytes/hash/size and independently verified anchor | Source substitute anchor, oversized/malformed 200 or HTTP failure does not become an accepted checkpoint |
| Page checkpoints | Poll core | Cursor `start` or exact old hash → bounded immediately ordered checkpoint bytes through fixed target | Empty nonterminal page, unexpected predecessor/echo/target rejects; no skip |
| Page leaves | Poll core | Start index → bounded ordered canonical leaf bytes to target size | Empty nonterminal, wrong start/echo, excess bytes/items rejects |
| Verify | Authority replay caller | All exact bytes → pinned verified prefix | Rotated signer, wrong root/policy/stream or fork rejects; only replay can accept |

## Wire and API contract

Use native `fetch` with an explicit source origin, feed ID, fixed target hash and bounded query values. A parser for each exact envelope uses the authority package's `parseCanonical` on the **decoded `Response.body` bytes** after a streaming size cap, then validates exact fields/types and canonical unpadded base64url items. Native fetch may decompress HTTP content encoding before exposing the body, so this caps the bytes parsed, not the on-wire transfer size. Read `Response.body` incrementally; `arrayBuffer()` without an early cap is not acceptable. Set an explicit request timeout/AbortSignal and `redirect:'error'` so customer-configured source credentials cannot be forwarded to another origin. Reject cross-origin URL redirects, credentials in URL, fragments and non-HTTPS production source URLs. The existing config parser already constrains origin syntax; HTTP loopback is test-only.

`discoverFeedHead` verifies the source's signed anchor against the independently configured pin and feed ID; it checks the head checkpoint's canonical structure, computes its statement hash and compares the echoed `checkpointHash`, but marks the checkpoint **provisional**. It cannot verify a rotated signing key yet. `fetchCheckpointPage` and `fetchLeafPage` return exact copied canonical byte arrays plus checked echoes. The caller—not unsigned `items.length` claims—derives the next cursor; an empty page is legal only at the provisional fixed target hash/size boundary, subject to replay. The checkpoint page's first item's `previous` must equal the requested `after` hash unless `after='start'`, when it must be signed size-zero genesis. The caller must still verify every signature and authority transition through the authority replay API before declaring a target accepted. Leaf positions are assigned from requested `start + offset`; leaf bytes have no global index field.

Source 401/403, 404/409, 429, 5xx, timeout and connection failure are retryable or operator-auth failures that leave coverage pending; they are not, by themselves, cryptographic suppression evidence. Malformed success bodies are source nonconformance; a separately authenticated fork or independent receipt conflict is a cryptographic finding. Keep response-body excerpts and credentials out of errors/logs. A caught fetch failure must not advance an accepted cursor.

The fixture publisher lives in `test/source-fixture.ts` beside existing tests, avoiding a new directory convention, and serves real canonical envelopes/bytes from authority package artifacts over `node:http`. It supports deterministic outage, malformed/oversized pages, old/forked head, dropped range, delayed pages and provider-key rotation controls. Do not deploy it in the observer's production Next routes. A local HTTP smoke exercises the real client against the fixture; later store/poller tests reuse it.

## Changes and proposed names

| Path/name | Responsibility | Decision |
|---|---|---|
| `src/lib/source.ts` `discoverFeedHead` | Fetch and structurally fix one provisional target under pinned anchor | Keep; name avoids authentication claim for target |
| `src/lib/source.ts` `fetchCheckpointPage` | Read one bounded canonical checkpoint page | Keep; no replay inside fetch function |
| `src/lib/source.ts` `fetchLeafPage` | Read one bounded canonical leaf page | Keep; no DB work |
| `src/lib/source.ts` `readBoundedResponse` | Stop stream before response size limit | Private helper, no new dependency |
| `test/source.test.ts` | Parser, HTTP and adversarial source contract | Lowest responsible layer |
| `test/source-fixture.ts` | Test-only configurable publisher | Existing flat test directory |

## Test plan

1. Write a failing `head` test with a real pinned anchor and signed size-zero checkpoint from the accepted authority package. Observe red before creating `src/lib/source.ts`. Positive target is provisional; wrong pin/feed/hash/canonical bytes and rotated key discovery cases fail/behave as specified.
2. Add bounded streaming and exact-envelope adversarial tests: >64/256 KiB chunked decoded response, compressed response that exceeds the decoded limit, duplicate keys, noncanonical JSON, extra/missing fields, wrong base64url, sparse/overlong item arrays, empty nonterminal page, wrong target/start/after, redirect and timeout. Mutate a bound or echo check and see the targeted test fail, then restore.
3. Add checkpoint and leaf fixture paging through a policy/key rotation and two actors. Feed exact returned bytes to `replayGovernanceHistory` and assert a verified prefix only after replay; demonstrate a validly signed wrong authority root is rejected there.
4. Run `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, local HTTP fixture smoke, `git diff --check` and independent spec/quality review. Store/poller concurrency and Vercel cron are later increments; a source client alone makes no coverage claim.

## Principles and verification

SRP: source client transports and parses, authority library verifies signed history, store retains, poller orchestrates. DRY: exact wire envelopes from the shared contract, no second cryptographic implementation. YAGNI: no queue, browser UI or database access here. KISS: three bounded GETs and one test publisher. Boy Scout cleanup in touched files only; no new runtime dependency or production directory convention. The feed-read credential decision is explicit and still pending.
