> Historical design/evidence for the retired v1 profile. See README.md and the compact registry witness plan for current runtime.

# Observer runtime bootstrap plan

> **For agentic workers:** Apply Superpowers test-driven development and subagent-driven development, then independent specification and quality review. This is the first independently tested observer increment, not observer readiness.

**Goal:** Create a buildable Next.js/Vercel Node project with exact customer-owned configuration validation and a truthful liveness endpoint, without claiming to have observed any governance history.

**Approved architecture:** The user chose a public TypeScript observer deployable on Vercel, with independent Postgres/Supabase state, pulling 1bridge and never gating releases. `docs/architecture.md` is the shared observer contract. A Next.js 16 project and pnpm match the current 1bridge stack; no provider DB credential or application source changes enter this phase.

## Ground truth

- This new public repo currently has only `README.md`, `LICENSE`, `docs/architecture.md` at commit `8be0c8a`. It has no runnable code, package manager lockfile, env loader or route.
- The existing app pins `next@16.2.10`, `react@19.2.3`, `pnpm@10.29.3`, and uses TypeScript 5/Vitest 3 (`ubo-guard/webapp/package.json:5`, `:103-105`, `:118-122`). Reuse their major stack rather than another framework.
- [Vercel Hobby cron](https://vercel.com/docs/cron-jobs/usage-and-pricing) supports daily invocation with hour-level timing; a cron route will be added only when it actually invokes a bounded poll. Do not publish a successful no-op audit route.
- The authority library's checkpoint module is under review. No observer poll protocol/API is frozen; this bootstrap cannot claim complete evidence verification.

## Journey and states

| Step | Caller | State before → after | Failure |
|---|---|---|---|
| Install/build | Customer or CI | Public source → reproducible pnpm lockfile and Next production output | Dependency/type/build error fails CI |
| Configure | Deployment process | Environment values → validated source URL/feed/key/DB/cron-secret settings | Missing/malformed values throw without logging secrets |
| Check liveness | Browser/monitor | HTTP GET `/api/health` → `{status:'up'}` | No audit-coverage or DB-availability claim; this is process liveness only |

The observer signer and receipt archive settings are later phases; do not add speculative credentials. The config loader accepts a `Record<string,string|undefined>` argument so tests do not mutate process env. Production entry points will call it at runtime, not during static build.

## Changes and proposed names

| Name/path | Responsibility | Decision |
|---|---|---|
| `package.json`, `pnpm-lock.yaml` | Pin Next/React/TS/Vitest/pnpm with `dev`, `build`, `start`, `lint`, `typecheck`, `test` scripts | Same ecosystem; no new framework |
| `tsconfig.json`, `eslint.config.mjs`, `vitest.config.ts`, `next-env.d.ts`, `.gitignore` | Minimal standard project tooling | Follow 1bridge conventions; no product UI framework |
| `src/lib/config.ts` `loadObserverConfig` | Validate runtime env once into explicit config | One operation; no name strain |
| `src/app/api/health/route.ts` `GET` | Return liveness only | Conventional Next route; no audit claim |
| `src/app/page.tsx`, `src/app/layout.tsx` | Minimal public status/info surface needed for Next build | Static information, no false coverage |
| `test/config.test.ts`, `test/health.test.ts` | Lowest-layer config and route contract tests | Test domain response, not self-mock |
| `.env.example`, `README.md` | First runnable local/Vercel setup, scope and limits | No secrets in repo |

Use environment names `SOURCE_BASE_URL`, `FEED_ID`, `CHECKPOINT_PUBLIC_KEY`, `DATABASE_URL`, `CRON_SECRET`. Source URL must be HTTPS in production, with plain HTTP allowed only for loopback fixture development when explicitly opted in via `NODE_ENV=test`; reject embedded credentials, query, fragment and non-root paths. `FEED_ID` is exactly 64 lowercase hexadecimal characters. `CHECKPOINT_PUBLIC_KEY` is canonical unpadded base64url and within a reasonable encoded length; cryptographic P-256 import validation occurs in the later library-backed configuration phase. `DATABASE_URL` must parse as `postgres:` or `postgresql:` with host/database; do not log user/pass. `CRON_SECRET` is at least 32 UTF-8 bytes; route authentication is added with the real poll endpoint. Reject missing/extra unsafe values as appropriate without echoing secrets. Normalize source URL to no trailing slash.

## Test-first plan

1. Add config tests importing missing `loadObserverConfig` and observe red. Cover valid production HTTPS and test loopback, malformed URL/protocol/credentials/path, uppercase/malformed feed, malformed base64url key, DB schemes, short/missing secret and no secret echo. Implement the smallest loader.
2. Add route contract test for missing `GET`, observe red. Implement a stable liveness response with no misleading `audited` field. The static page likewise states that a configured source has not yet been audited by this bootstrap.
3. Build and run `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `git diff --check`, a local HTTP smoke and advisory smell review. Intentionally break one config invariant and see the targeted test fail; restore. The DB/cron/integration gates remain unverified because this increment has no persistence or poll.

## Execution record

The bootstrap implementation is committed at `0ba7130`; the URL canonicalization regression fix is `fc62ca5`. An independent specification review found that valid default-port and uppercase-host origins were rejected; a failing regression was added before the fix and the follow-up spec review passed. Independent quality review accepted the bootstrap scope. Parent verification after the fix: `pnpm test` 27/27, `pnpm lint`, `pnpm typecheck`, `pnpm build`, and `git diff --check` passed. Reviewer production HTTP smoke returned 200 `{"status":"up"}` and the page explicitly described the lack of an audit. No Postgres, poll, signed coverage or Vercel deployment has been tested or claimed.

## Principles, smells and verification

SRP: config validation and liveness are separate from polling. DRY: one environment parser, not route-local copies. KISS/YAGNI: no database driver until a repository method needs it, no authenticated cron handler until real work exists, no empty audit statement. Follow Next route/lib split and small components. No application source changes occur, so 1bridge app gates do not apply. This phase is not counted as completion of the observer deliverable.
