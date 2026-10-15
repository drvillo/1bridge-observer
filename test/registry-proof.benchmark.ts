import { writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { performance } from 'node:perf_hooks'
import { expect, test } from 'vitest'
import pg from 'pg'
import { consistencyProof, merkleRoot, verifyConsistency } from '@drvillo/1bridge-authority'
import { readBenchmarkProvenance } from './benchmark-provenance'

const allowedSizes = [100, 1000, 10_000, 100_000]
const bytesPerEntry = 512
const trialsPerSize = 3

function selectedSizes(): number[] {
  const input = process.env.OBSERVER_REGISTRY_PROOF_SIZES
  if (!input) return allowedSizes
  const sizes = input.split(',').map(Number)
  if (sizes.length < 1 || sizes.length > allowedSizes.length
    || sizes.some((size, index) => !allowedSizes.includes(size)
      || index > 0 && size <= sizes[index - 1]!)) {
    throw new TypeError('OBSERVER_REGISTRY_PROOF_SIZES must be an ascending subset of 100,1000,10000,100000')
  }
  return sizes
}

test('measure full-prefix registry consistency proof construction', async () => {
  const output = process.env.OBSERVER_REGISTRY_PROOF_OUT
  const databaseUrl = process.env.OBSERVER_TEST_DATABASE_URL
  if (!output || !isAbsolute(output)) {
    throw new TypeError('OBSERVER_REGISTRY_PROOF_OUT must be an absolute file path')
  }
  if (!databaseUrl || process.env.OBSERVER_DISPOSABLE_DATABASE !== '1') {
    throw new TypeError('Registry proof benchmark requires the disposable Postgres wrapper')
  }
  const sizes = selectedSizes()
  const provenance = await readBenchmarkProvenance()
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  const postgres = (await client.query('SHOW server_version')).rows[0]?.server_version ?? 'unknown'
  const cases: Array<Record<string, unknown>> = []
  const artifact = { format: '1bridge.governance.registry-proof-microbenchmark/v1',
    recordedAt: new Date().toISOString(), ...provenance,
    environment: { ...provenance.environment, postgres },
    options: { sizes, bytesPerEntry, trialsPerSize, oldSize: 'floor(size / 2)' },
    method: 'Use one disposable Postgres temporary table with deterministic 512-byte entry values. For each size, fetch the full ordered prefix as the current app source does, validate its indexes and map its bytes, then time the installed portable consistencyProof. Compute both Merkle roots outside the timed interval and verify the proof in every trial. Insert and independent root calculation are excluded from timing.',
    cases, runComplete: false,
    limitations: [
      'Synthetic fixed-size entries; the distribution of real serialized registry entries was not measured.',
      'Equivalent full-prefix SQL and portable proof function, not a timed 1Bridge route, Prisma transaction or signed checkpoint lookup.',
      'One local Postgres container and Node process; no Vercel, Supabase pooler, remote network or concurrent-source load.',
      'Three consecutive unrandomized trials per size; cache, JIT and RSS accumulation are uncontrolled.',
      'RSS is a process snapshot after each trial, not an isolated peak allocation for that size.',
    ] }
  const save = async () => writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`)
  try {
    await client.query('CREATE TEMP TABLE benchmark_registry_entries (entry_index bigint PRIMARY KEY, entry_bytes bytea NOT NULL)')
    await save()
    let inserted = 0
    for (const size of sizes) {
      await client.query(`INSERT INTO benchmark_registry_entries
        SELECT i, decode(repeat(md5(i::text), 32), 'hex')
        FROM generate_series($1::bigint, $2::bigint) i`, [inserted, size - 1])
      inserted = size
      const oldSize = Math.floor(size / 2)
      const measurements: Array<{ fetchMs: number; prepareMs: number; proofMs: number; totalMs: number;
        proofItems: number; rssMiB: number }> = []
      for (let trial = 0; trial < trialsPerSize; trial++) {
        const start = performance.now()
        const rows = await client.query<{ entry_index: string; entry_bytes: Buffer }>(
          'SELECT entry_index, entry_bytes FROM benchmark_registry_entries WHERE entry_index < $1 ORDER BY entry_index',
          [size])
        const fetched = performance.now()
        expect(rows.rows).toHaveLength(size)
        expect(rows.rows.every((row, index) => row.entry_index === String(index))).toBe(true)
        const leaves = rows.rows.map(row => row.entry_bytes)
        const prepared = performance.now()
        const proof = await consistencyProof(leaves, oldSize)
        const finished = performance.now()
        const [oldRoot, newRoot] = await Promise.all([
          merkleRoot(leaves.slice(0, oldSize)), merkleRoot(leaves),
        ])
        expect(await verifyConsistency(oldSize, size, oldRoot, newRoot, proof)).toBe(true)
        measurements.push({ fetchMs: fetched - start, prepareMs: prepared - fetched,
          proofMs: finished - prepared,
          totalMs: finished - start, proofItems: proof.length,
          rssMiB: process.memoryUsage().rss / 1_048_576 })
      }
      cases.push({ size, oldSize, measurements })
      await save()
    }
    artifact.runComplete = true
    await save()
  } finally { await client.end() }
}, 120_000)
