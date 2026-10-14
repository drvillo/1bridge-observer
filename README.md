# 1bridge independent observer

Public, customer-operated pull observer for 1bridge governance evidence. This repository has a bounded pull client, process-local fixed-target verification and a test-only HTTP governance source; it does not yet run scheduled polling, persist findings, or produce audit coverage. A running health endpoint is not an audit assurance.

## Run locally

Use Node.js compatible with Next.js 16 and pnpm 10.29.3. Run `pnpm install --frozen-lockfile`, then `pnpm dev` for the local app or `pnpm build && pnpm start` for a production build. `GET /api/health` returns `{ "status": "up" }` to indicate process liveness. The static home page states the current scope.

Copy `.env.example` to a private environment file and supply customer-controlled values when integrating the next runtime phase. The configuration loader in `src/lib/config.ts` accepts an environment record at runtime; the bootstrap page and health route do not read it. `src/lib/source.ts` fetches a provisional head and exact checkpoint/leaf pages; `src/lib/verify-source.ts` replays one fixed target under the independent anchor pin in a single process and refuses incomplete budgets. Tests exercise this path against a local HTTP governance publisher. No production route calls it yet, and its result is not durable independent coverage. Keep credentials outside source control. In a Vercel project, set the same values as environment variables. No cron job is registered until a real bounded poll route exists.

`SOURCE_BASE_URL` must be an HTTPS origin with no credentials, path, query or fragment. Only `NODE_ENV=test` permits HTTP loopback fixtures. `FEED_ID` is 64 lowercase hex characters. `ANCHOR_PIN` is the 64-character lowercase hex output of the authority library's `anchorHash(anchor)`, obtained through an independently authenticated customer ceremony. `SIGNED_ANCHOR` is canonical unpadded base64url of UTF-8 `canonicalJson(signedAuthorityAnchor)`. A signed anchor may be fetched from the source, but it must verify against the independently configured pin; never derive or replace the pin from source responses. The async `verifyObserverAnchor` routine verifies the pin, both customer key-possession signatures and feed identity, then returns the initial authorized provider checkpoint public key and key ID from the verified anchor. The old `CHECKPOINT_PUBLIC_KEY` input is removed because the pinned anchor already authenticates that key. `DATABASE_URL` must identify a Postgres database. `CRON_SECRET` needs at least 32 UTF-8 bytes.

The first-party authority package is pinned to immutable commit `fb583a867bbf23969c94361355dc97695795ec45`. `pnpm-workspace.yaml` permits only that package's Git `prepare` build. A trusted operator must review upgrades before changing the commit and pin. The pull client treats a fetched target as provisional until the full signed history is replayed under the independently pinned anchor.

Run `pnpm test`, `pnpm lint`, `pnpm typecheck`, and `pnpm build` to check this increment. [Architecture and implementation order](docs/architecture.md) describes the trust boundary, evidence ownership, planned verification path, and limits of source-only pulling.

License: MIT.
