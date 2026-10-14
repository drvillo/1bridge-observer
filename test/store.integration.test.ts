import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import * as authority from '@drvillo/1bridge-authority'
import { acceptObserverTarget, beginObserverTarget, claimObserverLease, installObserverSchema, openObserverStore,
  quarantineObserverTarget, registerObserverFeed,
  stageObserverBatch,
  type ObserverStore } from '../src/lib/store'
import type { ObserverConfig } from '../src/lib/config'
import type { ProvisionalFeedHead } from '../src/lib/source'
import type { CheckpointPageItem } from '../src/lib/source'

const databaseUrl = process.env.OBSERVER_TEST_DATABASE_URL
if (!databaseUrl) throw new Error('OBSERVER_TEST_DATABASE_URL must identify a disposable database')

const vector = authority.parseCanonical(readFileSync(new URL('./governance-v1.json', import.meta.url))) as unknown as {
  anchorPin: string; signedAnchor: string; leaves: string[]; checkpoints: string[]; expected: authority.GovernanceReplaySnapshot
}
const config: ObserverConfig = { sourceBaseUrl: 'https://evidence.example', feedId: vector.expected.feedId,
  anchorPin: vector.anchorPin, signedAnchor: vector.signedAnchor,
  databaseUrl, databaseSchema: 'observer_test', cronSecret: 'x'.repeat(32) }

async function finalTarget(): Promise<ProvisionalFeedHead> {
  const signedCheckpointBytes = authority.decodeBase64Url(vector.checkpoints.at(-1)!)
  const signedCheckpoint = authority.parseCanonical(signedCheckpointBytes) as unknown as authority.SignedCheckpoint
  return { provisional: true, checkpointHash: await authority.checkpointHash(signedCheckpoint.statement),
    signedCheckpoint, signedCheckpointBytes }
}

async function checkpointItems(start: number, end: number): Promise<CheckpointPageItem[]> {
  return Promise.all(vector.checkpoints.slice(start, end).map(async item => {
    const bytes = authority.decodeBase64Url(item)
    const signed = authority.parseCanonical(bytes) as unknown as authority.SignedCheckpoint
    return { bytes, signed, hash: await authority.checkpointHash(signed.statement) }
  }))
}

describe('durable observer store', () => {
  let store: ObserverStore
  const inspector = new pg.Pool({ connectionString: databaseUrl, max: 1 })

  beforeAll(() => { store = openObserverStore(config.databaseUrl, config.databaseSchema) })
  afterAll(async () => { await store.close(); await inspector.end() })

  it('installs the same observer schema twice in the selected schema', async () => {
    await installObserverSchema(store)
    await installObserverSchema(store)
    const marker = await inspector.query('SELECT version, schema_digest, catalog_fingerprint FROM observer_test.observer_schema_versions')
    expect(marker.rows).toHaveLength(1)
    expect(marker.rows[0]).toMatchObject({ version: 1 })
    expect(marker.rows[0].schema_digest).toMatch(/^[0-9a-f]{64}$/)
    expect(marker.rows[0].catalog_fingerprint).toMatch(/^[0-9a-f]{32}$/)
    const outside = await inspector.query("SELECT to_regclass('public.observer_feeds') IS NULL AS untouched")
    expect(outside.rows[0].untouched).toBe(true)
  })

  it('serializes two first-time installers and rejects a missing selected schema', async () => {
    const first = openObserverStore(databaseUrl, 'observer_parallel')
    const second = openObserverStore(databaseUrl, 'observer_parallel')
    try {
      await Promise.all([installObserverSchema(first), installObserverSchema(second)])
      const result = await inspector.query('SELECT version FROM observer_parallel.observer_schema_versions')
      expect(result.rows).toEqual([{ version: 1 }])
    } finally { await Promise.all([first.close(), second.close()]) }
    const missing = openObserverStore(databaseUrl, 'observer_missing')
    try {
      await expect(installObserverSchema(missing)).rejects.toThrow(/does not exist/)
    } finally { await missing.close() }
  })

  it('rejects an unpinned anchor before creating any feed row', async () => {
    await expect(registerObserverFeed(store, { ...config, anchorPin: '0'.repeat(64) })).rejects.toThrow(/pin mismatch/i)
    const result = await inspector.query('SELECT count(*) AS total FROM observer_test.observer_feeds')
    expect(result.rows[0].total).toBe('0')
  })

  it('registers only the independently pinned signed feed and preserves it on retry', async () => {
    await registerObserverFeed(store, config)
    await registerObserverFeed(store, config)
    const feed = await inspector.query('SELECT feed_id, anchor_pin, signed_anchor FROM observer_test.observer_feeds')
    expect(feed.rows).toHaveLength(1)
    expect(feed.rows[0].feed_id).toBe(config.feedId)
    expect(feed.rows[0].anchor_pin).toBe(config.anchorPin)
    expect(feed.rows[0].signed_anchor).toEqual(Buffer.from(authority.decodeBase64Url(config.signedAnchor)))
    const cursor = await inspector.query('SELECT feed_id, accepted_size, staged_next_index FROM observer_test.observer_cursors')
    expect(cursor.rows).toEqual([{ feed_id: config.feedId, accepted_size: '0', staged_next_index: '0' }])
    await expect(registerObserverFeed(store, { ...config, anchorPin: '0'.repeat(64) })).rejects.toThrow()
    await expect(registerObserverFeed(store, { ...config, sourceBaseUrl: 'https://alternate.example' })).rejects.toThrow(/conflicts/)
    expect((await inspector.query('SELECT count(*) AS total FROM observer_test.observer_feeds')).rows[0].total).toBe('1')
  })

  it('fences competing workers and same-worker reacquisition with epochs', async () => {
    const first = await claimObserverLease(store, config.feedId, 'worker-a', 30_000)
    expect(first).toMatchObject({ feedId: config.feedId, workerId: 'worker-a', epoch: 1, version: 0 })
    expect(await claimObserverLease(store, config.feedId, 'worker-b', 30_000)).toBeNull()
    const second = await claimObserverLease(store, config.feedId, 'worker-a', 30_000)
    expect(second).toMatchObject({ feedId: config.feedId, workerId: 'worker-a', epoch: 2, version: 0 })
    expect(second!.expiresAt.getTime()).toBeGreaterThan(Date.now())
    const row = await inspector.query('SELECT lease_epoch, lease_owner FROM observer_test.observer_cursors')
    expect(row.rows).toEqual([{ lease_epoch: '2', lease_owner: 'worker-a' }])
    await inspector.query("UPDATE observer_test.observer_cursors SET lease_until=clock_timestamp()-interval '1 second'")
    const replacement = await claimObserverLease(store, config.feedId, 'worker-b', 30_000)
    expect(replacement).toMatchObject({ workerId: 'worker-b', epoch: 3, version: 0 })
  })

  it('fixes one provisional target under the current lease and rejects stale claims', async () => {
    const claim = await claimObserverLease(store, config.feedId, 'worker-b', 30_000)
    const target = await finalTarget()
    await expect(beginObserverTarget(store, claim!, { ...target, checkpointHash: '0'.repeat(64) })).rejects.toThrow()
    expect((await inspector.query('SELECT count(*) AS total FROM observer_test.observer_targets')).rows[0].total).toBe('0')
    const started = await beginObserverTarget(store, claim!, target)
    expect(started).toMatchObject({ feedId: config.feedId, workerId: 'worker-b', epoch: claim!.epoch,
      version: 1, targetHash: target.checkpointHash, targetSize: target.signedCheckpoint.statement.size })
    expect(Number.isSafeInteger(started.attemptId) && started.attemptId > 0).toBe(true)
    const rows = await inspector.query('SELECT attempt_id, target_hash, target_size, status FROM observer_test.observer_targets')
    expect(rows.rows).toEqual([{ attempt_id: String(started.attemptId), target_hash: target.checkpointHash,
      target_size: String(target.signedCheckpoint.statement.size), status: 'active' }])
    const cursor = await inspector.query('SELECT accepted_size, staged_next_index, active_attempt_id, version FROM observer_test.observer_cursors')
    expect(cursor.rows).toEqual([{ accepted_size: '0', staged_next_index: '0',
      active_attempt_id: String(started.attemptId), version: '1' }])
    const priorBytes = authority.decodeBase64Url(vector.checkpoints.at(-2)!)
    const priorSigned = authority.parseCanonical(priorBytes) as unknown as authority.SignedCheckpoint
    await expect(beginObserverTarget(store, started, { provisional: true,
      checkpointHash: await authority.checkpointHash(priorSigned.statement),
      signedCheckpoint: priorSigned, signedCheckpointBytes: priorBytes })).rejects.toThrow(/Different provisional target/)
    const alteredSigned = { ...target.signedCheckpoint,
      signature: authority.encodeBase64Url(new Uint8Array(64).fill(1)) }
    await expect(beginObserverTarget(store, started, { ...target, signedCheckpoint: alteredSigned,
      signedCheckpointBytes: authority.canonicalBytes(alteredSigned) })).rejects.toThrow(/Different provisional target/)
    await expect(beginObserverTarget(store, claim!, target)).rejects.toThrow(/stale/i)
    const reclaimed = await claimObserverLease(store, config.feedId, 'worker-b', 30_000)
    await expect(beginObserverTarget(store, started, target)).rejects.toThrow(/stale/i)
    const resumed = await beginObserverTarget(store, reclaimed!, target)
    expect(resumed).toMatchObject({ attemptId: started.attemptId, epoch: reclaimed!.epoch, version: 1 })
  })

  it('stages two exact pages without advancing accepted coverage', async () => {
    const target = await finalTarget()
    const lease = await claimObserverLease(store, config.feedId, 'worker-b', 30_000)
    const active = await beginObserverTarget(store, lease!, target)
    const firstBatch = { start: 0, leaves: vector.leaves.slice(0, 3).map(item => authority.decodeBase64Url(item)),
      checkpoints: await checkpointItems(0, 4) }
    await expect(stageObserverBatch(store, active, { ...firstBatch,
      checkpoints: firstBatch.checkpoints.slice(1) })).rejects.toThrow(/checkpoint/i)
    expect((await inspector.query('SELECT count(*) AS total FROM observer_test.observer_staged_leaves')).rows[0].total).toBe('0')
    const first = await stageObserverBatch(store, active, firstBatch)
    expect(first).toMatchObject({ alreadyApplied: false, claim: { version: 2, attemptId: active.attemptId } })
    await expect(acceptObserverTarget(store, first.claim)).rejects.toThrow(/incomplete/i)
    const afterFirst = await inspector.query(
      'SELECT staged_next_index, accepted_size, staged_checkpoint_tail_position FROM observer_test.observer_cursors')
    expect(afterFirst.rows).toEqual([{ staged_next_index: '3', accepted_size: '0', staged_checkpoint_tail_position: '3' }])
    const reclaimed = await claimObserverLease(store, config.feedId, 'worker-b', 30_000)
    const resumed = await beginObserverTarget(store, reclaimed!, target)
    const duplicate = await stageObserverBatch(store, resumed, firstBatch)
    expect(duplicate).toMatchObject({ alreadyApplied: true, claim: { version: 2 } })
    await expect(stageObserverBatch(store, resumed, { ...firstBatch,
      leaves: [firstBatch.leaves[1]!, ...firstBatch.leaves.slice(1)] })).rejects.toThrow(/changed/i)
    const secondBatch = { start: 3, leaves: vector.leaves.slice(3).map(item => authority.decodeBase64Url(item)),
      checkpoints: await checkpointItems(4, 8) }
    await expect(stageObserverBatch(store, active, secondBatch)).rejects.toThrow(/stale/i)
    await expect(stageObserverBatch(store, duplicate.claim, { ...secondBatch, start: 4 })).rejects.toThrow(/start/i)
    const second = await stageObserverBatch(store, duplicate.claim, secondBatch)
    expect(second).toMatchObject({ alreadyApplied: false, claim: { version: 3, attemptId: active.attemptId } })
    const final = await inspector.query(
      'SELECT staged_next_index, accepted_size, staged_checkpoint_tail_hash, staged_checkpoint_tail_position, version FROM observer_test.observer_cursors')
    expect(final.rows).toEqual([{ staged_next_index: '7', accepted_size: '0',
      staged_checkpoint_tail_hash: target.checkpointHash, staged_checkpoint_tail_position: '7', version: '3' }])
    expect((await inspector.query('SELECT count(*) AS total FROM observer_test.observer_staged_leaves')).rows[0].total).toBe('7')
    expect((await inspector.query('SELECT count(*) AS total FROM observer_test.observer_staged_checkpoints')).rows[0].total).toBe('8')
    expect((await inspector.query('SELECT count(*) AS total FROM observer_test.observer_leaves')).rows[0].total).toBe('0')
    const checkpointOnly = { start: 7, leaves: [], checkpoints: await checkpointItems(7, 8) }
    await expect(stageObserverBatch(store, second.claim, checkpointOnly)).resolves.toMatchObject({ alreadyApplied: true })
    expect((await inspector.query('SELECT version FROM observer_test.observer_cursors')).rows[0].version).toBe('3')
    await expect(quarantineObserverTarget(store, second.claim)).rejects.toThrow(/cannot be quarantined/i)
    const accepted = await acceptObserverTarget(store, second.claim)
    expect(accepted).toEqual(vector.expected)
    const acceptedCursor = await inspector.query(
      'SELECT staged_next_index, accepted_size, accepted_checkpoint_hash, active_attempt_id, version FROM observer_test.observer_cursors')
    expect(acceptedCursor.rows).toEqual([{ staged_next_index: '7', accepted_size: '7',
      accepted_checkpoint_hash: target.checkpointHash, active_attempt_id: null, version: '4' }])
    expect((await inspector.query('SELECT count(*) AS total FROM observer_test.observer_leaves')).rows[0].total).toBe('7')
    expect((await inspector.query('SELECT count(*) AS total FROM observer_test.observer_checkpoints')).rows[0].total).toBe('8')
    expect((await inspector.query('SELECT status FROM observer_test.observer_targets')).rows[0].status).toBe('accepted')
    await expect(acceptObserverTarget(store, second.claim)).rejects.toThrow(/stale/i)
  })

  it('does not accept retained source bytes that fail cryptographic replay', async () => {
    const badStore = openObserverStore(databaseUrl, 'observer_parallel')
    try {
      await installObserverSchema(badStore)
      await registerObserverFeed(badStore, config)
      const lease = await claimObserverLease(badStore, config.feedId, 'bad-source-worker', 30_000)
      const target = await beginObserverTarget(badStore, lease!, await finalTarget())
      const leaves = vector.leaves.map(item => authority.decodeBase64Url(item))
      leaves[0] = leaves[1]!
      const staged = await stageObserverBatch(badStore, target,
        { start: 0, leaves, checkpoints: await checkpointItems(0, 8) })
      await expect(acceptObserverTarget(badStore, staged.claim)).rejects.toThrow()
      const cursor = await inspector.query(
        'SELECT accepted_size, active_attempt_id FROM observer_parallel.observer_cursors')
      expect(cursor.rows).toEqual([{ accepted_size: '0', active_attempt_id: String(target.attemptId) }])
      expect((await inspector.query('SELECT count(*) AS total FROM observer_parallel.observer_leaves')).rows[0].total).toBe('0')
      expect((await inspector.query('SELECT status FROM observer_parallel.observer_targets')).rows[0].status).toBe('active')
      const finding = await quarantineObserverTarget(badStore, staged.claim)
      expect(Number.isSafeInteger(finding) && finding > 0).toBe(true)
      const quarantined = await inspector.query(
        'SELECT accepted_size, staged_next_index, active_attempt_id FROM observer_parallel.observer_cursors')
      expect(quarantined.rows).toEqual([{ accepted_size: '0', staged_next_index: '0', active_attempt_id: null }])
      expect((await inspector.query('SELECT status FROM observer_parallel.observer_targets')).rows[0].status).toBe('quarantined')
      const findings = await inspector.query(
        'SELECT finding_id, finding_type, resolved_at FROM observer_parallel.observer_findings')
      expect(findings.rows).toEqual([{ finding_id: String(finding), finding_type: 'invalid_replay', resolved_at: null }])
      expect((await inspector.query('SELECT count(*) AS total FROM observer_parallel.observer_staged_leaves')).rows[0].total).toBe('7')
      const nextLease = await claimObserverLease(badStore, config.feedId, 'bad-source-worker', 30_000)
      const retry = await beginObserverTarget(badStore, nextLease!, await finalTarget())
      expect(retry.attemptId).not.toBe(target.attemptId)
      const corrected = await stageObserverBatch(badStore, retry,
        { start: 0, leaves: vector.leaves.map(item => authority.decodeBase64Url(item)),
          checkpoints: await checkpointItems(0, 8) })
      await expect(acceptObserverTarget(badStore, corrected.claim)).resolves.toEqual(vector.expected)
      expect((await inspector.query('SELECT resolved_at FROM observer_parallel.observer_findings')).rows[0].resolved_at).toBeNull()
    } finally { await badStore.close() }
  })
})
