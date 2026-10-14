# 1bridge independent observer

Public, customer-operated pull observer for 1bridge governance evidence. This repository currently contains a **runtime bootstrap only**. It does not pull evidence, verify checkpoints, persist findings, or produce audit coverage. A running health endpoint is not an audit assurance.

## Run locally

Use Node.js compatible with Next.js 16 and pnpm 10.29.3. Run `pnpm install --frozen-lockfile`, then `pnpm dev` for the local app or `pnpm build && pnpm start` for a production build. `GET /api/health` returns `{ "status": "up" }` to indicate process liveness. The static home page states the current scope.

Copy `.env.example` to a private environment file and supply customer-controlled values when integrating the next runtime phase. The configuration loader in `src/lib/config.ts` accepts an environment record at runtime; the bootstrap page and health route do not read it. Keep credentials outside source control. In a Vercel project, set the same values as environment variables. No cron job is registered until a real bounded poll route exists.

`SOURCE_BASE_URL` must be an HTTPS origin with no credentials, path, query or fragment. Only `NODE_ENV=test` permits HTTP loopback fixtures. `FEED_ID` is 64 lowercase hex characters. `CHECKPOINT_PUBLIC_KEY` is canonical unpadded base64url; cryptographic P-256 import is a later integration step. `DATABASE_URL` must identify a Postgres database. `CRON_SECRET` needs at least 32 UTF-8 bytes.

Run `pnpm test`, `pnpm lint`, and `pnpm typecheck` to check this increment. [Architecture and implementation order](docs/architecture.md) describes the trust boundary, evidence ownership, planned verification path, and limits of source-only pulling.

License: MIT.
