# 1Bridge independent observer

This public TypeScript/Next.js service pulls a signed pseudonymous governance [registry](#registry) and its advertised [feed](#feed) evidence from 1Bridge. It stores accepted prefixes in observer-owned Postgres, replays authority and action signatures with [the authority library](https://github.com/drvillo/1bridge-authority), and signs aggregate reports that mark each feed verified or pending.

The service does not gate a 1Bridge operation or release. A later published signed action that cites a witnessed predecessor exposes a suppressed gap during catch-up. An event hidden from every independent witness and receipt holder stays invisible here.

One [observer operator](#observer-operator) deploys the shared profile for every plan. That deployment has no per-customer ID, token, source URL, or feed list. Customer-operated Enterprise observers are a later profile. The [monitored deployment](#monitored-deployment) has to publish pseudonymous verification envelopes with no private payloads. Set `SOURCE_BASE_URL` to a deployment that serves the public registry and feed routes before you claim coverage. Role names used below are collected in [Roles and terms](#appendix-roles-and-terms).

Routine tests use a local synthetic source and a separate Postgres. An opt-in test can check a running 1Bridge Next source. A green local run does not show that a deployment is watching production.

## Set up the shared profile

### 1. Install

Use a Node.js release that supports Next.js 16, and pnpm 10.29.3.

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm test:integration
pnpm lint
pnpm typecheck
pnpm build
```

`pnpm test:integration` creates a disposable Postgres 17 container and removes it when the run finishes.

### 2. Create the database

Provision Postgres that you operate. A Supabase project works. Copy the connection string from [Supabase `DATABASE_URL`](#supabase-database_url).

You create the schema before the first deploy. The pool logs in with this operator's database role.

- Dedicated database: leave `OBSERVER_SCHEMA` as `public`.
- Shared database, including a Supabase project that also hosts other Supabase products: create a schema for this service and set `OBSERVER_SCHEMA` to that name.

On Supabase, open the SQL editor and run:

```sql
CREATE SCHEMA observer AUTHORIZATION postgres;
```

The pooler username looks like `postgres.[project-ref]`. The database role is the part before the dot, `postgres`, unless you created another role. That role needs `USAGE` and `CREATE` on the schema. Owning the schema provides both.

v1–v4 migrations then run in one transaction and check the installed catalog fingerprint.

### 3. Pin the registry

The [registry publisher](#registry-publisher) is the 1Bridge operator who signs the global [registry](#registry). You are the [observer operator](#observer-operator). Their private key stays with them. You configure their public key.

Get two values from that publisher on a channel outside the host you will poll. A 1Bridge release record, a key-ceremony note, or a comparison you make with them is that channel.

- `REGISTRY_PUBLISHER_PUBLIC_KEY`: their ECDSA P-256 public key as [SPKI](#spki), unpadded base64url.
- `REGISTRY_SIGNED_GENESIS`: the [signed empty registry genesis](#signed-empty-registry-genesis), in the same encoding.

Record those bytes before you accept a copy from the [monitored deployment](#monitored-deployment). The authority library checks the genesis signature under that [pin](#pin), then checks later [registry checkpoints](#registry-checkpoint) along the same chain.

### 4. Generate the observer signing key

This pair is the [observer signing key](#observer-signing-key). It is a different key from the [registry publisher](#registry-publisher) key. Run this on a machine where the terminal scrollback stays private. It prints one ECDSA P-256 pair:

```sh
node --input-type=module -e 'import { generateSigningKey, exportSigningPrivateKey, exportSigningPublicKey } from "@drvillo/1bridge-authority"; const pair = await generateSigningKey(); console.log("OBSERVER_SIGNING_PRIVATE_KEY=" + await exportSigningPrivateKey(pair.privateKey)); console.log("OBSERVER_SIGNING_PUBLIC_KEY=" + await exportSigningPublicKey(pair.publicKey))'
```

Keep the PKCS#8 private key in the host secret store. Give the [SPKI](#spki) public key to [report verifiers](#report-verifier) on a channel separate from the monitored deployment, and pin it there.

### 5. Set the variables

Local Next.js reads `.env.local` from the repo root. Copy `.env.example` to that file and fill it in. Git ignores `.env*` and keeps `.env.example`.

On Vercel, open the project and go to **Settings → Environment Variables**. Add each name for Production. Redeploy after saving so the functions pick up the values.

You generate `CRON_SECRET` (`openssl rand -base64 32`). It has to be at least 32 UTF-8 bytes. Vercel Cron reads that project variable and calls `GET /api/shared-poll` with `Authorization: Bearer <CRON_SECRET>`.

What each name means, and where the value comes from, is in [Environment variables](#environment-variables).

### 6. Deploy

`vercel.json` calls `GET /api/shared-poll` daily at 08:00 UTC. Call that route yourself with the same bearer token to catch up. Each call has a 45-second work budget, at most 12 registry entry or checkpoint pages, and at most 12 round-robin feeds. Poll state, leases, and accepted evidence stay in Postgres across restarts. An unavailable feed stays pending and leaves its peers running. Vercel does not retry a failed cron run. Read the report checkpoint and time when you want freshness. The daily Hobby trigger is not a bound on observation lag.

On [Vercel Hobby](https://vercel.com/docs/cron-jobs/usage-and-pricing), cron runs at most once per day and may start anywhere within its scheduled hour. This route declares a 60-second [function duration](https://vercel.com/docs/functions/configuring-functions/duration), with 45 seconds reserved for polling. With a stable catalog of more than 12 feeds, even an error-free observer needs at least `ceil(feed count / 12)` daily runs to select every feed once; registry backlog, source outages and retries can extend that further. A 24-hour customer review threshold therefore means **an old report is labeled stale and cannot complete strict review**, not that Hobby guarantees a new witness every 24 hours. The independent operator can invoke the protected route additional times for catch-up or deploy on a plan with a more frequent cron. Neither choice changes 1Bridge release availability.

`SOURCE_BASE_URL` is an HTTPS origin with no credentials, path, query, or fragment. HTTP loopback is available in tests. Endpoint and page limits are in [the shared observer contract](docs/shared-observer-plan.md). `GET /api/health` reports process liveness.

## Supabase `DATABASE_URL`

For this service on Vercel, `DATABASE_URL` is the **Transaction pooler** URI from the Supabase **Connect** dialog.

1. Open the project in the Supabase dashboard.
2. Click **Connect**.
3. Select **Transaction pooler** (shared pooler, transaction mode).
4. Copy the **URI**.
5. Replace `[YOUR-PASSWORD]` with the database password from **Project Settings → Database**. If you no longer have that password, reset it there. Percent-encode reserved characters in it (`&`, `#`, `?`, `@`, `/`, and spaces).
6. If the copied URI has no `sslmode` parameter, append `?sslmode=verify-full`. If it already has an `sslmode`, use `verify-full` for this deployment.

The filled-in value has this shape:

```txt
postgresql://postgres.[PROJECT-REF]:[YOUR-PASSWORD]@[POOLER-HOST]:6543/postgres?sslmode=verify-full
```

| Field | Value you want |
| --- | --- |
| Host | `aws-[INDEX]-[REGION].pooler.supabase.com`. Copy it from Connect. `[INDEX]` is a pooler cluster, so you cannot build the host from the region name. |
| Port | `6543` |
| User | `postgres.[PROJECT-REF]` |
| Database | `postgres` (the path, not a query parameter) |

Port 6543 is transaction mode on an IPv4 pooler host, which Vercel serverless egress can reach. This service sets `search_path` and takes `pg_advisory_xact_lock` inside one transaction. Transaction mode keeps that state until commit, then returns the server connection to the pool.

This repository uses `pg` 8.23. Its installed connection-string parser treats `sslmode=verify-full` as TLS with certificate and hostname verification. If your pooler presents a certificate outside the runtime's trusted CA set, obtain the CA from Supabase Database settings and configure a trusted certificate file for the deployed function before polling. Do not turn off certificate checks to make a connection succeed. Vercel functions can read files included in their deployment bundle; their filesystem is read-only at runtime, so the CA must be supplied at build/deploy time. The observer's database connection is separate from the cryptographic registry and feed checks.

The Connect dialog also offers these strings. They configure other clients:

| Label in Connect | Shape | Use it for |
| --- | --- | --- |
| Project URL, anon key, service role key | `https://[PROJECT-REF].supabase.co` and the JWT API keys | The Data API (`supabase-js`). `pg` cannot open that URL. |
| Direct connection | `postgresql://postgres:[PASSWORD]@db.[PROJECT-REF].supabase.co:5432/postgres` | Long-lived backends that have IPv6, or the IPv4 add-on. Vercel serverless egress does not have IPv6. |
| Session pooler | same pooler host as above, port `5432`, user `postgres.[PROJECT-REF]` | IPv4 clients that need a session for the whole connection, including named prepared statements. Switch to this URI if the transaction pooler rejects a query as a prepared statement. |
| Dedicated pooler | `postgresql://postgres:[PASSWORD]@db.[PROJECT-REF].supabase.co:6543/postgres` | Paid plans that want a pooler on the database host. IPv6, or IPv4 with the add-on. |

The password in that URI is the database password from **Project Settings → Database**. The anon key, service role key, and JWT secret are API credentials and stay out of `DATABASE_URL`.

## Environment variables

Shared-profile names are what the Vercel cron reads. Legacy names apply to a separate single-feed install. Placeholders are the same strings as `.env.example`.

### Shared profile

**`SOURCE_BASE_URL`**

HTTPS origin of the 1Bridge deployment that publishes the public registry and feed routes. No user, password, path, query, or fragment. You copy the origin from that deployment (the scheme and host you open in a browser).

**`REGISTRY_PUBLISHER_PUBLIC_KEY`**

Unpadded base64url [SPKI](#spki) of the [registry publisher](#registry-publisher)'s ECDSA P-256 public key. Take it from the channel in [step 3](#3-pin-the-registry). This value is part of the registry [pin](#pin). A key returned by the monitored host is what that pin checks.

**`REGISTRY_SIGNED_GENESIS`**

Unpadded base64url of the canonical [signed empty registry genesis](#signed-empty-registry-genesis), from that same channel. The service checks the signature, `size = 0`, and `previous = null`.

**`DATABASE_URL`**

`postgresql://` or `postgres://` URI with a host and a database name. No URL fragment. For Supabase, use the transaction pooler URI in the section above. The password in the URI is the database password from **Project Settings → Database**.

**`OBSERVER_SCHEMA`**

Schema name. If you omit it, the service uses `public`. You create the schema and grant the connection role `USAGE` and `CREATE` before the first request. The name starts with a letter or underscore, then contains only letters, digits, and underscores, and is at most 63 characters.

**`CRON_SECRET`**

A secret you generate, at least 32 UTF-8 bytes. `openssl rand -base64 32` is enough. You paste it into the Vercel project (and into `.env.local` for a local server). Vercel Cron sends it as `Authorization: Bearer` on `GET /api/shared-poll`. A manual catch-up uses the same header. On the legacy profile, `GET /api/poll` expects this secret too.

**`OBSERVER_SIGNING_PRIVATE_KEY`**

`replace-with-unpadded-base64url-pkcs8`

Unpadded base64url PKCS#8 of an observer-owned ECDSA P-256 private key. The command in step 4 prints it. Store it in Vercel as a sensitive environment variable, or in `.env.local` for a local process. It signs aggregate reports.

**`OBSERVER_SIGNING_PUBLIC_KEY`**

`replace-with-unpadded-base64url-spki`

Unpadded base64url [SPKI](#spki) of that same keypair. The command prints it next to the private key. The deployment imports it and checks that the two keys match before a poll. [Report verifiers](#report-verifier) pin this public key from you. A report body is the wrong place to learn it.

Generate one observer-owned pair. Pin its public key independently of the source.

### Legacy single-feed profile

`GET /api/poll` and token-protected `GET /api/reports/latest` read these. The shared cron does not. There is no public receipt-ingress route. The legacy store can keep completion receipts handed to it in process, so you can compare them. That archive does not show that every customer submitted a receipt.

**`FEED_ID`**

`replace-with-64-lowercase-hex-characters`

The [feed](#feed) id inside the [customer](#customer-and-authority-anchor)'s signed [authority anchor](#customer-and-authority-anchor): 64 lowercase hex characters. The customer gives you the anchor. You set `FEED_ID` to the anchor's `feedId`. Startup fails if the verified anchor carries a different id.

**`ANCHOR_PIN`**

`replace-with-independently-authenticated-64-lowercase-hex-anchor-hash`

The 64-lowercase-hex hash of that anchor, authenticated by the customer when the anchor was created and given to you with the anchor. This is the legacy [pin](#pin). The service verifies `SIGNED_ANCHOR` against it. The hash you were given is the value a copy on the source head response has to match.

**`SIGNED_ANCHOR`**

`replace-with-canonical-unpadded-base64url-of-canonical-signed-anchor-json`

Canonical unpadded base64url of the canonical signed-anchor JSON. The customer exports this bytestring with the [pin](#pin). The service rejects `=` padding and any character outside the base64url alphabet.

**`REPORT_READ_TOKEN`**

`replace-with-a-different-at-least-32-utf8-byte-secret`

A second secret you generate, at least 32 UTF-8 bytes, distinct from `CRON_SECRET`. Readers send it as `Authorization: Bearer` on `GET /api/reports/latest`. It authorizes that read. It does not sign reports. `openssl rand -base64 32` is a fine generator, run separately from the cron secret so the two values differ.

### Test-only names

`pnpm test:integration` boots its own database. Set these when you opt into an extra check.

| Variable | Where the value comes from |
| --- | --- |
| `OBSERVER_TEST_DATABASE_URL` | URI of a disposable database. Keep production off this variable. |
| `OBSERVER_SUPABASE_CONTAINER` | Docker name of a local container whose image is `supabase/postgres`. |
| `OBSERVER_SUPABASE_DATABASE_URL` | Postgres URI for that local container. `test/store.supabase.test.sh` rewrites the database name and exports `OBSERVER_TEST_DATABASE_URL`. |
| `OBSERVER_LIVE_SOURCE_BASE_URL` | Origin of a disposable 1Bridge Next app that is already publishing registry feeds. |
| `OBSERVER_LIVE_REGISTRY_PUBLIC_KEY` | [Registry publisher](#registry-publisher) [SPKI](#spki) you retained for that test source. |
| `OBSERVER_LIVE_REGISTRY_GENESIS` | [Signed empty registry genesis](#signed-empty-registry-genesis) you retained for that test source. |
| `OBSERVER_LIVE_FEEDS` | JSON array of pins, for example `[{"feedId":"<64-hex>","anchorPin":"<64-hex>"}]`. |

## Public verification interface

- `GET /api/shared-reports/latest` returns `{ version: 1, reportHash, signedReport }`, or 404 before the first report.
- `GET /api/shared-reports/status?reportHash=<64-lowercase-hex>&feedId=<64-lowercase-hex>` returns `{ version: 1, reportHash, proof }` for a feed in that report.

Both routes are public and read-only. Browsers on any origin may call them (`Access-Control-Allow-Origin: *`). Responses use `Cache-Control: no-store`. They expose pseudonymous feed IDs and cryptographic status, not customer identity or private payloads. Browser callers send a non-credentialed GET. The routes do not require the cron secret or a customer machine token.

A [report verifier](#report-verifier) pins, on its own, the [observer signing key](#observer-signing-key)'s public half, the [registry publisher](#registry-publisher) public key, the expected [registry checkpoint](#registry-checkpoint), and its own [feed](#feed) ID and [authority anchor](#customer-and-authority-anchor) [pin](#pin). It then calls `verifyAggregateFeedStatus` from the authority library. The proof cannot supply the expected customer identity. `verified` means this observer replayed the registry-advertised feed head. `pending` means it has not. HTTP 200 and this deployment's key configuration are not independent trust anchors. Reports keep the registry and verified replay snapshots needed to regenerate status proofs.

The database keeps accepted and staged global registry entries and checkpoints, source findings, per-feed accepted evidence, and signed reports. A transient registry source error is recorded. If a later accepted chain contains that target, the source-nonconformance finding is marked resolved and the record stays. An invalid replay stays a finding. A source outage is pending, not a tampering verdict. Registry checkpoints and signed action predecessor links make a later rewrite of a witnessed prefix detectable. The observer cannot prove that every action was published, or that a tail nobody witnessed had existed.

## Checks in this repo

The authority dependency is pinned in `package.json` to a reviewed Git commit. `pnpm-workspace.yaml` allows that dependency's Git `prepare` build. v1–v3 migrations stay frozen. `schema-v4.sql` adds the shared registry and aggregate tables.

- `bash test/schema.sql.test.sh` checks the v1 DDL against disposable Postgres.
- `pnpm test:integration` covers fresh installs, v1 and v2 upgrades, and shared workflows, including a loopback HTTP source with two feeds, a 25-feed rotating scheduler across store restarts, bounded catch-up, outage recovery, and a missing-checkpoint finding.
- Optional Supabase scripts run against a disposable Supabase Postgres database you supply (`OBSERVER_SUPABASE_CONTAINER` and `OBSERVER_SUPABASE_DATABASE_URL`).

To check a live 1Bridge source:

1. Start a disposable local app database and Next server whose published registry feeds contain signed leaves.
2. In a separate disposable Postgres database, create the schema `observer_live_source`.
3. Set `OBSERVER_TEST_DATABASE_URL`, `OBSERVER_LIVE_SOURCE_BASE_URL`, `OBSERVER_LIVE_REGISTRY_PUBLIC_KEY`, and `OBSERVER_LIVE_REGISTRY_GENESIS` from the pins you retained for that test.
4. Set `OBSERVER_LIVE_FEEDS` to a JSON array such as `[{"feedId":"<64-hex>","anchorPin":"<64-hex>"}]`.
5. Run `pnpm exec vitest run --config vitest.integration.config.ts test/live-source.integration.test.ts`.

That test pulls the public registry and feed routes, checks the pinned signatures and signed leaves, stores each accepted head, and checks signed aggregate coverage proofs. The ordinary integration suite skips it when those variables are unset. Point `OBSERVER_TEST_DATABASE_URL` at disposable data.

## Appendix: Roles and terms

### Observer operator

The person or team deploying this repository. You own the Vercel project, the Postgres database, `CRON_SECRET`, and the [observer signing key](#observer-signing-key). You store the [registry publisher](#registry-publisher)'s public key as configuration. [Registry checkpoints](#registry-checkpoint) stay signed by the publisher's key.

### Registry publisher

The 1Bridge operator who holds the ECDSA P-256 private key for the global governance registry. That party signs the empty genesis and every later registry checkpoint. In production this is the team that runs 1Bridge. A customer workspace is a different party. The observer operator is a different party again.

You get their public key and the signed genesis from them. A 1Bridge release record, a key-ceremony note, or a value you compare with them in person is the usual source. The host in `SOURCE_BASE_URL` may be run by the same organization. The bytes you configure still come from that outside record, so a substituted host is checked against a key you already hold.

### Monitored deployment

The 1Bridge HTTPS origin in `SOURCE_BASE_URL`. This service pulls registry and feed routes from it. The [pins](#pin) are the values you use to check that origin.

### Registry

The append-only log of pseudonymous workspace registrations and the feed heads those workspaces advertise. The registry publisher signs it. The shared observer learns feed ids from this log. It takes no customer feed list in its environment.

### Signed empty registry genesis

The first registry checkpoint. Its statement has `size` 0 and `previous` null, and the registry publisher's key signs it. You store those exact signed bytes in `REGISTRY_SIGNED_GENESIS`. Later checkpoints have to chain from this statement.

### Registry checkpoint

One signed statement in the registry chain. Each statement names the hash of the statement before it. The observer replays that chain from the pinned genesis to the head the monitored deployment advertises.

### Pin

A value you configure and keep, which the monitored deployment has to match. The shared profile has one registry pin: the publisher public key together with the signed empty genesis. The legacy single-feed profile adds an anchor pin, the 64-hex hash of one customer's signed authority anchor.

### SPKI

Subject Public Key Info, the usual encoding of an ECDSA P-256 public key. This service stores it as unpadded base64url: the URL-safe alphabet, with no `=` padding. `REGISTRY_PUBLISHER_PUBLIC_KEY` and `OBSERVER_SIGNING_PUBLIC_KEY` both use that encoding. The matching private-key encoding is PKCS#8, also unpadded base64url, in `OBSERVER_SIGNING_PRIVATE_KEY`. The publisher's private key is not an environment variable here.

### Feed

A pseudonymous evidence log for one workspace, advertised by the registry and identified by 64 lowercase hex characters. The shared profile reads those ids from the registry. The legacy profile is configured with one id in `FEED_ID`.

### Customer and authority anchor

A customer is a workspace owner on 1Bridge. Their authority anchor is a signed document that binds their feed id and the initial provider checkpoint key. They authenticate the anchor's 64-hex hash when the anchor is created. That hash is `ANCHOR_PIN` on a legacy single-feed install, supplied with `SIGNED_ANCHOR`. The shared cron does not read those variables. A customer who checks a public report still pins their own feed id and anchor hash while verifying.

### Observer signing key

An ECDSA P-256 key generated for this deployment, with the command in [step 4](#4-generate-the-observer-signing-key). The private key signs aggregate reports. Report verifiers pin the public key from you. This key is distinct from the registry publisher key and from any customer authority anchor.

### Report verifier

A party that checks a signed aggregate report. Often that party is a customer inspecting their own feed. They pin your observer public key, the registry publisher public key, the registry checkpoint they expect, and their own feed id and authority anchor pin, then call `verifyAggregateFeedStatus`. The report body does not fill in those expected values.

License: MIT.
