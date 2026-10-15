import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { cpus, platform, release } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { test } from 'vitest'
import pg from 'pg'
import * as authority from '@drvillo/1bridge-authority'
import { pollObserverOnce } from '../src/lib/poll'
import { installObserverSchema, openObserverStore } from '../src/lib/store'
import { buildGovernanceSource, startGovernanceSource } from './governance-source-fixture'

const authorityPin = 'github:drvillo/1bridge-authority#b48c9989b59f243b22c655b3d55b4ce0ae814f06'
const authorityBuildSha256 = '2a0774548fb95f8d88698a8a19de02ce128d0a7c53383ddcaa561bdaf89ea50b'

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new TypeError(`Benchmark count must be an integer from ${min} to ${max}`)
  }
  return parsed
}

async function installedAuthorityDigest(): Promise<string> {
  const packageRoot = join(process.cwd(), 'node_modules', '@drvillo', '1bridge-authority')
  const files = ['package.json', ...(await readdir(join(packageRoot, 'dist')))
    .filter(file => file.endsWith('.js')).sort().map(file => `dist/${file}`)]
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file).update('\0').update(await readFile(join(packageRoot, file))).update('\0')
  }
  return hash.digest('hex')
}

test('measure nonempty fixed-target observer catch-up into disposable Postgres', async () => {
  const out = process.env.OBSERVER_BENCH_OUT
  const databaseUrl = process.env.OBSERVER_TEST_DATABASE_URL
  if (!out || !isAbsolute(out)) throw new TypeError('OBSERVER_BENCH_OUT must be an absolute file path')
  if (!databaseUrl || process.env.OBSERVER_DISPOSABLE_DATABASE !== '1') {
    throw new TypeError('Benchmark requires the disposable Postgres wrapper')
  }
  const trials = boundedInteger(process.env.OBSERVER_BENCH_TRIALS, 30, 1, 100)
  const warmup = boundedInteger(process.env.OBSERVER_BENCH_WARMUP, 3, 0, 20)
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  if (pkg.dependencies['@drvillo/1bridge-authority'] !== authorityPin
    || await installedAuthorityDigest() !== authorityBuildSha256) {
    throw new Error('Installed authority package differs from the pinned clean build')
  }
  const observerCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const observerDirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() !== ''
  if (observerDirty && process.env.OBSERVER_BENCH_ALLOW_DIRTY !== '1') {
    throw new Error('Commit the observer benchmark runner before recording final samples')
  }
  const postgresImage = process.env.OBSERVER_TEST_POSTGRES_IMAGE
  const postgresImageId = process.env.OBSERVER_TEST_POSTGRES_IMAGE_ID
  const postgresImageArchitecture = process.env.OBSERVER_TEST_POSTGRES_IMAGE_ARCHITECTURE
  if (!postgresImage?.startsWith('postgres@sha256:')
    || !/^sha256:[0-9a-f]{64}$/.test(postgresImageId ?? '')
    || !postgresImageArchitecture) {
    throw new Error('Benchmark requires a pinned Postgres image and inspected image provenance')
  }

  const history = await buildGovernanceSource()
  const source = await startGovernanceSource(history)
  const inspector = new pg.Pool({ connectionString: databaseUrl, max: 1 })
  const signedCheckpoint = history.checkpoints.at(-1)!
  const checkpointHash = await authority.checkpointHash(signedCheckpoint.statement)
  const target = { provisional: true as const, signedCheckpoint, checkpointHash,
    signedCheckpointBytes: authority.canonicalBytes(signedCheckpoint) }
  const settings = { sourceBaseUrl: source.baseUrl,
    feedId: history.signedAnchor.anchor.feedId, anchorPin: history.anchorPin,
    signedAnchor: authority.encodeBase64Url(authority.canonicalBytes(history.signedAnchor)),
    databaseUrl, databaseSchema: 'observer_benchmark', cronSecret: 'x'.repeat(32) }
  const budget = { maxLeafPages: 16, maxCheckpoints: 16, maxMs: 20_000 }
  const samples = []
  try {
    const databaseVersion = (await inspector.query('SHOW server_version')).rows[0]?.server_version ?? 'unknown'
    for (let trial = -warmup; trial < trials; trial++) {
      await inspector.query('DROP SCHEMA IF EXISTS observer_benchmark CASCADE')
      await inspector.query('CREATE SCHEMA observer_benchmark')
      const store = openObserverStore(databaseUrl, settings.databaseSchema)
      try {
        await installObserverSchema(store)
        const beforeCold = source.calls.length
        const coldStart = performance.now()
        const cold = await pollObserverOnce(store, settings, 'benchmark', budget, target)
        const coldMs = performance.now() - coldStart
        const coldHttpRequests = source.calls.length - beforeCold
        if (cold.status !== 'accepted' || cold.snapshot.size !== history.leaves.length
          || cold.snapshot.checkpointHash !== checkpointHash) {
          throw new Error(`Cold poll did not accept the expected head: ${cold.status}`)
        }
        const rows = await inspector.query<{ leaves: string; checkpoints: string;
          accepted_size: string; accepted_checkpoint_hash: string }>(
            `SELECT (SELECT count(*) FROM observer_benchmark.observer_leaves) AS leaves,
                    (SELECT count(*) FROM observer_benchmark.observer_checkpoints) AS checkpoints,
                    accepted_size, accepted_checkpoint_hash
             FROM observer_benchmark.observer_cursors WHERE feed_id=$1`, [settings.feedId])
        const accepted = rows.rows[0]
        if (!accepted || accepted.leaves !== '7' || accepted.checkpoints !== '8'
          || accepted.accepted_size !== '7' || accepted.accepted_checkpoint_hash !== checkpointHash) {
          throw new Error('Persisted observer prefix disagrees with the signed seven-leaf head')
        }
        const beforeHot = source.calls.length
        const hotStart = performance.now()
        const hot = await pollObserverOnce(store, settings, 'benchmark', budget, target)
        const hotMs = performance.now() - hotStart
        const hotHttpRequests = source.calls.length - beforeHot
        if (hot.status !== 'up_to_date' || hotHttpRequests !== 0) {
          throw new Error(`Repeated poll did not preserve the accepted head: ${hot.status}`)
        }
        if (trial >= 0) samples.push({ trial, coldStatus: cold.status, hotStatus: hot.status,
          coldMs, hotMs, coldHttpRequests, hotHttpRequests,
          acceptedLeaves: Number(accepted.leaves), acceptedCheckpoints: Number(accepted.checkpoints),
          acceptedCheckpointHash: accepted.accepted_checkpoint_hash })
      } finally { await store.close() }
    }
    const artifact = {
      format: '1bridge.governance.observer-catchup/v1', recordedAt: new Date().toISOString(),
      observerCommit, observerDirty, authorityDependency: authorityPin, authorityBuildSha256,
      environment: { node: process.version, platform: platform(), release: release(),
        cpuModel: cpus()[0]?.model ?? 'unknown', cpuCount: cpus().length,
        postgres: databaseVersion, postgresImage, postgresImageId, postgresImageArchitecture },
      options: { trials, warmup },
      workload: { feedCount: 1, leaves: history.leaves.length, checkpoints: history.checkpoints.length,
        source: 'in-process loopback HTTP fixture; fresh observer schema per trial' },
      method: 'Time pollObserverOnce with a registry-style fixed target, then an immediate repeated poll; key generation, source startup, schema install and result validation are outside the timed intervals. Raw trials retained without outlier deletion.',
      samples,
      limitations: [
        'One seven-leaf feed, not multi-feed or multi-tenant registry scheduling.',
        'Loopback HTTP and local Postgres do not measure deployed Vercel, Supabase pooler or internet latency.',
        'Fixed source and ascending trial order do not counterbalance cache, JIT or host thermal effects.',
        'The hot poll uses the supplied fixed target and makes no HTTP request; it does not measure registry discovery.',
      ],
    }
    await writeFile(out, `${JSON.stringify(artifact, null, 2)}\n`)
  } finally { await inspector.end(); await source.close() }
})
