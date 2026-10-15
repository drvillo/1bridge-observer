import { writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { performance } from 'node:perf_hooks'
import { test } from 'vitest'
import pg from 'pg'
import * as authority from '@drvillo/1bridge-authority'
import { pollObserverOnce } from '../src/lib/poll'
import { installObserverSchema, openObserverStore } from '../src/lib/store'
import { readBenchmarkProvenance } from './benchmark-provenance'
import { startGovernanceSource } from './governance-source-fixture'

const feedId = 'a'.repeat(64)
const workspaceId = 'b'.repeat(64)
const defaultSizes = [100, 1000, 10_000]

function selectedSizes(): number[] {
  const value = process.env.OBSERVER_SCALE_SIZES
  if (!value) return defaultSizes
  const sizes = value.split(',').map(Number)
  if (sizes.length < 1 || sizes.length > defaultSizes.length
    || sizes.some((size, index) => !defaultSizes.includes(size)
      || index > 0 && size <= sizes[index - 1]!)) {
    throw new TypeError('OBSERVER_SCALE_SIZES must be an ascending subset of 100,1000,10000')
  }
  return sizes
}

async function buildScaleHistory(maxSize: number) {
  const [root, recovery, provider] = await Promise.all([
    authority.generateSigningKey(), authority.generateSigningKey(), authority.generateSigningKey(),
  ])
  const anchor = await authority.createAuthorityAnchor({ feedId, workspaceId,
    rootPublicKey: root.publicKey, recoveryPublicKey: recovery.publicKey,
    checkpointPublicKey: provider.publicKey })
  const signedAnchor = await authority.signAuthorityAnchor(anchor, root, recovery)
  const anchorPin = await authority.anchorHash(anchor)
  let state = await authority.verifyAuthorityAnchor(signedAnchor, anchorPin)
  let frontier = authority.emptyHistoryFrontier()
  const leaves: Uint8Array[] = []
  const checkpoints: authority.SignedCheckpoint[] = []
  const rootKeyId = await authority.signingKeyId(root.publicKey)
  const providerKeyId = await authority.signingKeyId(provider.publicKey)
  async function seal() {
    const current = authority.authorityStateSnapshot(state)
    checkpoints.push(await authority.signCheckpoint({ version: 1, feedId,
      size: leaves.length, historyRoot: await authority.historyFrontierRoot(frontier),
      authorityRoot: current.authorityRoot, policyEpoch: current.policyEpoch,
      signerKeyId: providerKeyId,
      previous: checkpoints.length ? await authority.checkpointHash(checkpoints.at(-1)!.statement) : null,
    }, provider))
  }
  await seal()
  for (let index = 0; index < maxSize; index++) {
    const current = authority.authorityStateSnapshot(state)
    const revision = await authority.signAuthorityRevision({ version: 1, feedId, workspaceId,
      number: current.revision + 1, previous: current.revisionHash,
      previousRoot: current.authorityRoot, expectedPolicyEpoch: current.policyEpoch,
      operation: { kind: 'policy', body: null, policyHash: null },
      authorityRoot: current.authorityRoot, policyEpoch: current.policyEpoch + 1,
      signerKeyId: rootKeyId }, root)
    state = await authority.applyAuthorityRevision(state, revision)
    const leaf = authority.authorityRevisionLeaf(revision)
    leaves.push(leaf)
    frontier = await authority.appendHistory(frontier, leaf)
    await seal()
  }
  if (leaves.length !== maxSize || checkpoints.length !== maxSize + 1
    || checkpoints.at(-1)!.statement.historyRoot !== await authority.merkleRoot(leaves)) {
    throw new Error('Scale fixture history is inconsistent')
  }
  return { signedAnchor, anchorPin, leaves, checkpoints }
}

test('measure bounded observer catch-up for per-leaf checkpoint histories', async () => {
  const out = process.env.OBSERVER_SCALE_OUT
  const databaseUrl = process.env.OBSERVER_TEST_DATABASE_URL
  if (!out || !isAbsolute(out)) throw new TypeError('OBSERVER_SCALE_OUT must be an absolute file path')
  if (!databaseUrl || process.env.OBSERVER_DISPOSABLE_DATABASE !== '1') {
    throw new TypeError('Scale benchmark requires the disposable Postgres wrapper')
  }
  const provenance = await readBenchmarkProvenance()
  const sizes = selectedSizes()
  const maxPolls = 150
  const budget = { maxLeafPages: 100, maxCheckpoints: 100, maxMs: 60_000 }
  const fixtureStart = performance.now()
  const history = await buildScaleHistory(sizes.at(-1)!)
  const fixtureGenerationMs = performance.now() - fixtureStart
  const inspector = new pg.Pool({ connectionString: databaseUrl, max: 1 })
  const cases: Array<Record<string, unknown>> = []
  try {
    const postgres = (await inspector.query('SHOW server_version')).rows[0]?.server_version ?? 'unknown'
    const artifact = { format: '1bridge.governance.observer-scale/v1',
      recordedAt: new Date().toISOString(), ...provenance,
      environment: { ...provenance.environment, postgres },
      options: { sizes, maxPolls, budget }, fixtureGenerationMs,
      workload: 'one root-signed null-policy revision and one provider-signed checkpoint per leaf',
      method: 'Generate one signed policy-revision history, then for each prefix install a fresh observer schema and time each pollObserverOnce fixed-target invocation until accepted, a non-pending outcome, or the 150-call limit. The 60-second budget limits paging, not full call duration. Errors record their class without message or credentials. Fixture generation, source startup, schema installation, SQL validation and artifact writes are outside timed poll intervals. Each completed case is saved immediately.',
      cases, runComplete: false,
      limitations: [
        'Synthetic policy revisions, not a measured distribution of signed sharing and recovery actions.',
        'One feed with a supplied fixed target; registry discovery, multi-tenant scheduling and report generation are excluded.',
        'The direct poll uses 100 checkpoint items per invocation, while the current Vercel shared route uses 12.',
        'The 60-second budget applies to paging; acceptance replay and lease cleanup can extend call wall time.',
        'Loopback HTTP and local Postgres do not measure Vercel, Supabase pooler or internet latency.',
        'One run per size without randomization or outlier analysis; host cache, JIT and thermal effects are uncontrolled.',
      ] }
    const save = async () => writeFile(out, `${JSON.stringify(artifact, null, 2)}\n`)
    await save()
    for (const size of sizes) {
      await inspector.query('DROP SCHEMA IF EXISTS observer_scale CASCADE')
      await inspector.query('CREATE SCHEMA observer_scale')
      const prefix = { signedAnchor: history.signedAnchor, leaves: history.leaves.slice(0, size),
        checkpoints: history.checkpoints.slice(0, size + 1), alternateLastLeaf: history.leaves[size - 1]! }
      const source = await startGovernanceSource(prefix)
      const store = openObserverStore(databaseUrl, 'observer_scale')
      try {
        await installObserverSchema(store)
        const signedCheckpoint = prefix.checkpoints.at(-1)!
        const targetCheckpointHash = await authority.checkpointHash(signedCheckpoint.statement)
        const target = { provisional: true as const, signedCheckpoint,
          checkpointHash: targetCheckpointHash,
          signedCheckpointBytes: authority.canonicalBytes(signedCheckpoint) }
        const settings = { sourceBaseUrl: source.baseUrl, feedId, anchorPin: history.anchorPin,
          signedAnchor: authority.encodeBase64Url(authority.canonicalBytes(history.signedAnchor)),
          databaseUrl, databaseSchema: 'observer_scale', cronSecret: 'x'.repeat(32) }
        const polls: { invocation: number; status: string; durationMs: number;
          httpRequests: number; errorName?: string }[] = []
        for (let invocation = 0; invocation < maxPolls; invocation++) {
          const beforeRequests = source.calls.length
          const started = performance.now()
          let result: Awaited<ReturnType<typeof pollObserverOnce>> | null = null
          let errorName: string | undefined
          try { result = await pollObserverOnce(store, settings, 'scale-benchmark', budget, target) }
          catch (error) { errorName = error instanceof Error ? error.name : 'UnknownError' }
          const durationMs = performance.now() - started
          if (result?.status === 'accepted' && (result.snapshot.size !== size
            || result.snapshot.checkpointHash !== targetCheckpointHash)) {
            throw new Error('Scale poll accepted the wrong signed target')
          }
          const status = result?.status ?? 'error'
          polls.push({ invocation, status, durationMs,
            httpRequests: source.calls.length - beforeRequests,
            ...(errorName ? { errorName } : {}) })
          if (status !== 'pending') break
        }
        const rows = await inspector.query<{ accepted_size: string; accepted_checkpoint_hash: string | null;
          leaves: string; checkpoints: string }>(
            `SELECT accepted_size, accepted_checkpoint_hash,
              (SELECT count(*) FROM observer_scale.observer_leaves) AS leaves,
              (SELECT count(*) FROM observer_scale.observer_checkpoints) AS checkpoints
             FROM observer_scale.observer_cursors WHERE feed_id=$1`, [feedId])
        const stored = rows.rows[0]
        if (!stored) throw new Error('Scale observer cursor is missing')
        const outcome = polls.at(-1)!.status
        const leafRows = await inspector.query<{ leaf_index: string }>(
          'SELECT leaf_index FROM observer_scale.observer_leaves ORDER BY leaf_index')
        const checkpointRows = await inspector.query<{ position: string; checkpoint_size: string;
          statement_hash: string; signed_checkpoint: Buffer }>(
            'SELECT position, checkpoint_size, statement_hash, signed_checkpoint FROM observer_scale.observer_checkpoints ORDER BY position')
        const persistedContiguous = leafRows.rows.every((row, index) => row.leaf_index === String(index))
          && checkpointRows.rows.every((row, index) => row.position === String(index)
            && row.checkpoint_size === String(index))
        if (!persistedContiguous || leafRows.rows.length !== Number(stored.leaves)
          || checkpointRows.rows.length !== Number(stored.checkpoints)) {
          throw new Error('Scale persisted prefix has noncontiguous indexes or mismatched counts')
        }
        if (outcome === 'accepted' && (stored.accepted_size !== String(size)
          || stored.accepted_checkpoint_hash !== targetCheckpointHash
          || stored.leaves !== String(size) || stored.checkpoints !== String(size + 1)
          || checkpointRows.rows.at(-1)?.statement_hash !== targetCheckpointHash
          || !checkpointRows.rows.at(-1)?.signed_checkpoint.equals(target.signedCheckpointBytes))) {
          throw new Error('Scale accepted prefix does not match retained database evidence')
        }
        if (outcome !== 'accepted' && stored.accepted_size !== '0') {
          throw new Error('Scale non-accepted outcome has an unexpected accepted prefix')
        }
        cases.push({ size, targetCheckpointHash, outcome,
          acceptedLeaves: Number(stored.leaves), acceptedCheckpoints: Number(stored.checkpoints),
          acceptedCheckpointHash: stored.accepted_checkpoint_hash, persistedContiguous,
          totalPollMs: polls.reduce((total, item) => total + item.durationMs, 0), polls })
        await save()
      } finally { await store.close(); await source.close() }
    }
    artifact.runComplete = true
    await save()
  } finally { await inspector.end() }
}, 600_000)
