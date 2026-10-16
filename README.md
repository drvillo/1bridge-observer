# 1Bridge independent observer

> **Current shared profile:** the daily Vercel cron runs the version-2 compact global registry witness. The earlier per-feed routes and reports have been retired. A witnessed global root does not prove that a particular customer action was included. See the [compact witness plan](docs/superpowers/plans/2026-10-16-compact-registry-witness.md).

This public TypeScript/Next.js service pulls the latest signed global governance [registry](#registry) head and, when it advances, a Merkle consistency proof from 1Bridge. It stores accepted roots and findings in observer-owned Postgres, then signs a compact global witness with [the authority library](https://github.com/drvillo/1bridge-authority). It does not fetch tenant feeds or registry entries on the current shared cron path.

The service does not gate a 1Bridge operation or release. A later root inconsistent with a witnessed Merkle prefix exposes tampering. A compact witness cannot inspect action citations: customer-held receipts and 1Bridge's customer-side feed-continuation verifier are needed to detect a suppressed action within a consistent registry branch. An event hidden from every independent witness and receipt holder stays invisible.

One [observer operator](#observer-operator) deploys the shared profile for every plan. That deployment has no per-customer ID, token, source URL, or feed list. Customer-operated Enterprise observers are a later profile. The [monitored deployment](#monitored-deployment) has to publish pseudonymous verification envelopes with no private payloads. Set `SOURCE_BASE_URL` to a deployment that serves the public registry head and consistency routes before you claim coverage. Role names used below are collected in [Roles and terms](#appendix-roles-and-terms).

Routine tests use a local synthetic source and a separate Postgres. The opt-in live-source test can check a running 1Bridge Next source; the 1Bridge app also has a local cross-repository fixture using its registry readers over HTTP. A green local run does not show that a deployment is watching production.

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

To check the same suite against a running **local** Supabase Postgres container, set `OBSERVER_SUPABASE_CONTAINER` to its container name and `OBSERVER_SUPABASE_DATABASE_URL` to its local Postgres URI, then run `bash test/store.supabase.test.sh`. The script creates and removes a disposable database in that container. `bash test/schema.supabase.test.sh` checks fresh and repeat schema installation there. These commands are for local test instances, not production databases.

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

v1–v5 migrations run in one transaction and check the installed catalog fingerprint. The v5 tables hold the compact witness cursor, signed reports and bounded findings; legacy v1–v4 rows remain historical.

### 3. Pin the registry

The [registry publisher](#registry-publisher) is the 1Bridge operator who signs the global [registry](#registry). You are the [observer operator](#observer-operator). Their private key stays with them. You configure their public key.

Get two values from that publisher on a channel outside the host you will poll. A 1Bridge release record, a key-ceremony note, or a comparison you make with them is that channel.

- `REGISTRY_PUBLISHER_PUBLIC_KEY`: their ECDSA P-256 public key as [SPKI](#spki), unpadded base64url.
- `REGISTRY_SIGNED_GENESIS`: the [signed empty registry genesis](#signed-empty-registry-genesis), in the same encoding.

Record those bytes before you accept a copy from the [monitored deployment](#monitored-deployment). The authority library checks the genesis signature under that [pin](#pin). Each later accepted head must have a valid publisher signature and a Merkle consistency proof from the last accepted root; the compact poll does not replay skipped checkpoint metadata.

### 4. Generate the observer signing key

This pair is the [observer signing key](#observer-signing-key). It is a different key from the [registry publisher](#registry-publisher) key. Run this on a machine where the terminal scrollback stays private. It prints one ECDSA P-256 pair:

```sh
node --input-type=module -e 'import { generateSigningKey, exportSigningPrivateKey, exportSigningPublicKey } from "@drvillo/1bridge-authority"; const pair = await generateSigningKey(); console.log("OBSERVER_SIGNING_PRIVATE_KEY=" + await exportSigningPrivateKey(pair.privateKey)); console.log("OBSERVER_SIGNING_PUBLIC_KEY=" + await exportSigningPublicKey(pair.publicKey))'
```

Keep the PKCS#8 private key in the host secret store. Give the [SPKI](#spki) public key to [report verifiers](#report-verifier) on a channel separate from the monitored deployment, and pin it there.

### 5. Set the variables

Local Next.js reads `.env.local` from the repo root. Copy `.env.example` to that file and fill it in. Git ignores `.env*` and keeps `.env.example`.

On Vercel, open the project and go to **Settings → Environment Variables**. Add each name for Production. Redeploy after saving so the functions pick up the values.

You generate `CRON_SECRET` (`openssl rand -base64 32`). It has to be at least 32 UTF-8 bytes. Vercel Cron reads that project variable and calls `GET /api/registry-witness/poll` with `Authorization: Bearer <CRON_SECRET>`.

What each name means, and where the value comes from, is in [Environment variables](#environment-variables).

### 6. Deploy

`vercel.json` calls `GET /api/registry-witness/poll` daily at 08:00 UTC. One invocation requests the latest signed head and, if it changed, one consistency proof. It signs a fresh report timestamp after an unchanged valid head or a retained protocol finding. A source outage returns `unavailable`, preserves the last accepted root, and never blocks 1Bridge. Invoke the protected route manually with the same bearer token when you need another observation. Public `GET /api/registry-witness/latest` returns the latest signed global report. Pin the observer public key independently before trusting it.

The observer retains bounded evidence for parsed conflicting heads and proofs, and a typed finding when parsing fails. A rejected consistency path for a candidate head resolves when that same head is later accepted with a valid path; signature failures and rollbacks remain findings for operator review. The authority report signer accepts at most 10,000 unresolved finding IDs. A malicious source that drives beyond that bound requires operator investigation and a subsequent protocol revision; it cannot block 1Bridge operations. Do not describe the last signed report as current while its finding set or timestamp is stale.

On [Vercel Hobby](https://vercel.com/docs/cron-jobs/usage-and-pricing), cron runs at most once per day and may start anywhere within its scheduled hour. This route declares a 60-second [function duration](https://vercel.com/docs/functions/configuring-functions/duration). Merkle consistency lets one poll jump over many publications without replaying intermediate checkpoints. The observer can still be stale during an outage or after the last poll. A freshness threshold is a verifier policy, not a service availability guarantee.

Historical feed-replay benchmark artifacts characterize version 1 and do not measure the compact route. Measure real source proof-generation and Vercel poll duration before making a latency claim for the new deployment.

For the 1Bridge registry source's full-prefix consistency-proof cost, set `OBSERVER_REGISTRY_PROOF_OUT` to an absolute output path and run `pnpm bench:registry-proof`. The opt-in microbenchmark uses a disposable pinned Postgres container, synthetic 512-byte entries and the installed authority library. It verifies every generated proof against independently computed roots. It measures the equivalent ordered database read and proof function, not a running 1Bridge route, Vercel deployment or real registry-entry distribution; do not treat its timings as a service latency promise.

`SOURCE_BASE_URL` is an HTTPS origin with no credentials, path, query, or fragment. HTTP loopback is available in tests. `GET /api/health` reports process liveness.

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

The names below are what the compact Vercel cron reads. Placeholders are the same strings as `.env.example`.

### Shared profile

**`SOURCE_BASE_URL`**

HTTPS origin of the 1Bridge deployment that publishes the public registry head and consistency routes. No user, password, path, query, or fragment.

**`REGISTRY_PUBLISHER_PUBLIC_KEY`**

Unpadded base64url [SPKI](#spki) of the [registry publisher](#registry-publisher)'s ECDSA P-256 public key. Take it from the channel in [step 3](#3-pin-the-registry). This value is part of the registry [pin](#pin). A key returned by the monitored host is what that pin checks.

**`REGISTRY_SIGNED_GENESIS`**

Unpadded base64url of the canonical [signed empty registry genesis](#signed-empty-registry-genesis), from that same channel. The service checks the signature, `size = 0`, and `previous = null`.

**`DATABASE_URL`**

`postgresql://` or `postgres://` URI with a host and a database name. No URL fragment. For Supabase, use the transaction pooler URI in the section above. The password in the URI is the database password from **Project Settings → Database**.

**`OBSERVER_SCHEMA`**

Schema name. If you omit it, the service uses `public`. You create the schema and grant the connection role `USAGE` and `CREATE` before the first request. The name starts with a letter or underscore, then contains only letters, digits, and underscores, and is at most 63 characters.

**`CRON_SECRET`**

A secret you generate, at least 32 UTF-8 bytes. `openssl rand -base64 32` is enough. You paste it into the Vercel project (and into `.env.local` for a local server). Vercel Cron sends it as `Authorization: Bearer` on `GET /api/registry-witness/poll`. A manual poll uses the same header.

**`OBSERVER_SIGNING_PRIVATE_KEY`**

`replace-with-unpadded-base64url-pkcs8`

Unpadded base64url PKCS#8 of an observer-owned ECDSA P-256 private key. The command in step 4 prints it. Store it in Vercel as a sensitive environment variable, or in `.env.local` for a local process. It signs global witness reports.

**`OBSERVER_SIGNING_PUBLIC_KEY`**

`replace-with-unpadded-base64url-spki`

Unpadded base64url [SPKI](#spki) of that same keypair. The command prints it next to the private key. The deployment imports it and checks that the two keys match before a poll. [Report verifiers](#report-verifier) pin this public key from you. A report body is the wrong place to learn it.

Generate one observer-owned pair. Pin its public key independently of the source.

### Upgrade from legacy profiles

This release retires `/api/poll`, `/api/reports/latest`, `/api/shared-poll`, `/api/shared-reports/*` and queue continuation. Remove manually configured old cron or queue triggers. Only `/api/registry-witness/poll` is scheduled. `FEED_ID`, `ANCHOR_PIN`, `SIGNED_ANCHOR` and `REPORT_READ_TOKEN` are no longer used.

The installer preserves immutable schema-v1–v4 migrations and historical rows, then installs v5. It never converts v1 reports into v2 witness reports. Export historical reports before upgrading if external consumers need them; use the prior Git revision to read their old API. No external consumer was found in reviewed repositories, but unknown third-party consumers cannot be ruled out.

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
| `OBSERVER_LIVE_REGISTRY_TARGET` | Exact 64-character lowercase hash of the signed head expected from that source. |
| `OBSERVER_LIVE_EXPECTED_REGISTRY_SIZE` | Expected integer entry count of that head, at least four for the two-feed fixture. |

## Public verification interface

`GET /api/registry-witness/latest` returns `{ version: 2, reportHash, signedReport }`, or 404 before a report exists. It is public, read-only, noncredentialed and cross-origin (`Access-Control-Allow-Origin: *`, `Cache-Control: no-store`). The protected poll route uses the cron bearer secret.

Verifiers independently pin the observer public key, publisher public key and signed empty registry genesis. The signed report contains the accepted global root, observation time and unresolved findings. The observer retains global signed roots and findings in v5 tables and requests only the source registry `head` and `consistency` routes. It never requests customer feed history or accepts customer receipts.

A root witnesses append-only publication. It does not attest actor authority, action validity, the latest head for a customer, or completeness of the product audit log. Customer-side verification combines a saved action receipt with registry inclusion and authenticated feed history. A later hidden-X citation inside an action is not inspected by this observer. An outage is pending/stale, not proof of tampering; shares never wait for the observer.

## Checks in this repo

Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration` and `pnpm build`. Integration uses disposable Postgres and tests fresh installation, preserved legacy upgrades, compact root acceptance, findings, restart, concurrency, outage recovery and public route contracts. `test/store.supabase.test.sh` runs the same suite in a disposable database on local Supabase Postgres. Historical benchmark artifacts remain evidence of the retired profile, not compact-profile performance claims.

For the optional real-source check, use a **disposable observer database** and set `OBSERVER_TEST_DATABASE_URL`, `OBSERVER_LIVE_SOURCE_BASE_URL`, `OBSERVER_LIVE_REGISTRY_PUBLIC_KEY`, `OBSERVER_LIVE_REGISTRY_GENESIS`, `OBSERVER_LIVE_REGISTRY_TARGET` (the exact expected 64-character checkpoint hash), and `OBSERVER_LIVE_EXPECTED_REGISTRY_SIZE` (at least four). Run `pnpm exec vitest run --config vitest.integration.config.ts test/live-source.integration.test.ts`. The test creates and drops a unique observer schema itself; it is skipped unless every value is configured. It authenticates the signed report and checks that the accepted cursor matches the expected size and hash. The source database is not modified by this test. Third-party deployed cron smoke and freshness SLA remain unverified.

## Appendix: Roles and terms

### Observer operator

The person or team deploying this repository. You own the Vercel project, the Postgres database, `CRON_SECRET`, and the [observer signing key](#observer-signing-key). You store the [registry publisher](#registry-publisher)'s public key as configuration. [Registry checkpoints](#registry-checkpoint) stay signed by the publisher's key.

### Registry publisher

The 1Bridge operator who holds the ECDSA P-256 private key for the global governance registry. That party signs the empty genesis and every later registry checkpoint. In production this is the team that runs 1Bridge. A customer workspace is a different party. The observer operator is a different party again.

You get their public key and the signed genesis from them. A 1Bridge release record, a key-ceremony note, or a value you compare with them in person is the usual source. The host in `SOURCE_BASE_URL` may be run by the same organization. The bytes you configure still come from that outside record, so a substituted host is checked against a key you already hold.

### Monitored deployment

The 1Bridge HTTPS origin in `SOURCE_BASE_URL`. The shared observer pulls only the public registry `head` and `consistency` routes from it. The [pins](#pin) are the values you use to check that origin.

### Registry

The append-only log of pseudonymous workspace registrations and the feed heads those workspaces advertise. The registry publisher signs its checkpoints. The shared observer witnesses the registry roots without fetching entries or learning feed IDs. It takes no customer feed list in its environment.

### Signed empty registry genesis

The first registry checkpoint. Its statement has `size` 0 and `previous` null, and the registry publisher's key signs it. You store those exact signed bytes in `REGISTRY_SIGNED_GENESIS`. Later checkpoints have to chain from this statement.

### Registry checkpoint

One signed statement in the registry chain. Each statement names the hash of the statement before it. The compact observer verifies endpoint signatures and a Merkle consistency proof from its retained root to the advertised head; it does not replay skipped checkpoint metadata.

### Pin

A value you configure and keep, which the monitored deployment has to match. The shared profile has one registry pin: the publisher public key together with the signed empty genesis. Customer-side action verification additionally pins the customer's signed authority anchor.

### SPKI

Subject Public Key Info, the usual encoding of an ECDSA P-256 public key. This service stores it as unpadded base64url: the URL-safe alphabet, with no `=` padding. `REGISTRY_PUBLISHER_PUBLIC_KEY` and `OBSERVER_SIGNING_PUBLIC_KEY` both use that encoding. The matching private-key encoding is PKCS#8, also unpadded base64url, in `OBSERVER_SIGNING_PRIVATE_KEY`. The publisher's private key is not an environment variable here.

### Feed

A pseudonymous evidence log for one workspace, advertised by the registry and identified by 64 lowercase hex characters. The compact observer does not read these IDs; customer-side verifiers use them in inclusion and feed-history proofs.

### Customer and authority anchor

A customer is a workspace owner on 1Bridge. Their authority anchor is a signed document that binds their feed id and the initial provider checkpoint key. They authenticate the anchor's 64-hex hash when the anchor is created. The customer-side action verifier pins this hash and feed ID. The compact observer needs neither.

### Observer signing key

An ECDSA P-256 key generated for this deployment, with the command in [step 4](#4-generate-the-observer-signing-key). The private key signs compact global witness reports. Report verifiers pin the public key from you. This key is distinct from the registry publisher key and from any customer authority anchor.

### Report verifier

A party that checks a signed global witness report using `verifyRegistryWitness` from the authority library and independently pinned observer/publisher keys and signed genesis. To check a specific action, the customer additionally verifies its saved receipt, registry inclusion and signed feed history. The report body cannot supply independent trust pins.

License: MIT.
