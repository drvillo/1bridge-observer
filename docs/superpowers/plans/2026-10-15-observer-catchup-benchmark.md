# Nonempty Observer Catch-up Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce reproducible raw timings for the actual observer poller replaying one nonempty signed feed over loopback HTTP into disposable Postgres.

**Architecture:** Reuse `buildGovernanceSource` and `startGovernanceSource` (`test/governance-source-fixture.ts`) and `pollObserverOnce` (`src/lib/poll.ts`). A dedicated Vitest config selects only the benchmark file. The existing Postgres wrapper creates a fresh container, while each trial resets only a dedicated schema before timing. Results are saved in the public research-artifacts repository after verifying the observer commit and authority build.

**Tech Stack:** TypeScript, Vitest, Node performance API, existing authority package, `pg`, Postgres 17.

---

## Scope and evidence boundary

`test/poll.integration.test.ts` already verifies the seven-leaf, eight-checkpoint feed and accepted database state, but its assertions do not time the poll. `test/shared-poll.integration.test.ts` uses empty feed histories, so its timing would not measure cryptographic feed replay. This benchmark exercises the per-feed fixed-target path used after registry discovery; it excludes registry polling, multi-feed scheduling, Vercel/network transit, key generation, source startup and schema installation. A later integrated benchmark must cover those excluded stages.

The runner records raw cold-catch-up and immediately repeated up-to-date durations, HTTP request counts, source and dependency revisions, Node/CPU/Postgres environment, trial/warmup counts and limitations. Every accepted sample checks a seven-leaf persisted prefix, eight checkpoints and the expected signed head. A failed sample aborts artifact writing.

## Task 1: Specify the artifact before producing it

**Files:**
- Create `1bridge-research-artifacts/test/observer-catchup-bench.test.mjs` in its active benchmark worktree.

- [x] Add a Node test that reads `results/observer-catchup-benchmark.json`, requires `format = '1bridge.governance.observer-catchup/v1'`, 30 retained trials, nonnegative durations, seven accepted leaves, eight accepted checkpoints, and `accepted` then `up_to_date` statuses.
- [x] Run `node --test test/observer-catchup-bench.test.mjs`; expect a missing-artifact failure. Do not invent timings to make the test pass.

## Task 2: Add the isolated runner

**Files:**
- Create `test/poll.benchmark.ts` and `vitest.benchmark.config.ts`.
- Modify `test/integration-schemas.sql`, `test/store.integration.test.sh`, `package.json`.

- [x] Make `vitest.benchmark.config.ts` include only `test/*.benchmark.ts` and use a 120-second test timeout.
- [x] Add `CREATE SCHEMA observer_benchmark;` to the shared disposable schema fixture. Let `test/store.integration.test.sh` accept an optional Vitest config filename, defaulting to `vitest.integration.config.ts`.
- [x] Add `bench:observer` with a pinned Postgres 17 image digest through the existing disposable wrapper, and record the resolved image ID and architecture alongside the server version. Ordinary integration tests keep their existing default image reference.
- [x] In the benchmark test, reject a missing/relative `OBSERVER_BENCH_OUT` and nonclean Git source. Generate one signed seven-leaf history, start one loopback source, derive the signed fixed head, and read the Postgres server version before samples. A dirty-tree override is available only for smoke runs and is recorded in the output.
- [x] For each of three warmups and 30 retained trials, reset `observer_benchmark` and install its schema outside timing. Time one `pollObserverOnce` fixed-target call and one immediately repeated call separately. Require statuses `accepted` and `up_to_date`; query the persisted leaf/checkpoint counts and accepted head outside timing. Store only successful retained trials. Generate no extra crypto keys inside timing.
- [x] Run a two-trial smoke with `OBSERVER_BENCH_TRIALS=2 OBSERVER_BENCH_WARMUP=0` and an absolute temporary output path. The first run exposed Vitest's missing `import.meta.resolve`; the runner now hashes the installed package via the repo's `node_modules` path. A later pinned-image smoke also passed.
- [x] Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm build`, `git diff --check`; commit the runner. The opt-in benchmark is excluded from the normal unit/integration suites. Before commit, 86 unit and 30 ordinary integration tests passed; the running-source opt-in test was skipped.

## Task 3: Produce and review public raw evidence

**Files:**
- Create `1bridge-research-artifacts/results/observer-catchup-benchmark.json`.
- Modify that repository's `README.md`, `docs/governance-research-traceability.md`, `docs/governance-repository-map.md`, and `results/artifact-manifest.json`.

- [x] With the observer runner committed and clean, run `OBSERVER_BENCH_OUT=<absolute research result path> pnpm bench:observer` from the observer repo. The raw result records source commit `b5a0a04`, the exact authority pin/build digest, and the pinned Postgres image digest/ID.
- [x] Run the research test written in Task 1 and `pnpm test`; inspect raw sample counts and flags, hash the result into the artifact manifest, and document the narrow measurement boundary. All 13 research checks passed.
- [x] Commit and push both public branches. Do not call this a deployed, multi-tenant or end-to-end benchmark.
