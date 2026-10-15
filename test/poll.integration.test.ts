import { afterAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import * as authority from '@drvillo/1bridge-authority'
import { pollObserverOnce } from '../src/lib/poll'
import { installObserverSchema, openObserverStore, readAcceptedObserverReplay } from '../src/lib/store'
import type { ObserverConfig } from '../src/lib/config'
import { buildGovernanceSource, startGovernanceSource, type GovernanceSourceHistory,
  type GovernanceSourceFaults } from './governance-source-fixture'

const databaseUrl = process.env.OBSERVER_TEST_DATABASE_URL
if (!databaseUrl) throw new Error('OBSERVER_TEST_DATABASE_URL must identify a disposable database')
const inspector = new pg.Pool({ connectionString: databaseUrl, max: 1 })

function config(history: GovernanceSourceHistory, sourceBaseUrl: string): ObserverConfig {
  return { sourceBaseUrl, feedId: history.signedAnchor.anchor.feedId,
    anchorPin: history.anchorPin,
    signedAnchor: authority.encodeBase64Url(authority.canonicalBytes(history.signedAnchor)),
    databaseUrl: databaseUrl!, databaseSchema: 'public', cronSecret: 'x'.repeat(32) }
}

describe('durable bounded source poll', () => {
  afterAll(async () => { await inspector.end() })

  it('resumes a partial target and then treats the accepted head as up to date', async () => {
    const history = await buildGovernanceSource()
    const source = await startGovernanceSource(history)
    const store = openObserverStore(databaseUrl, 'observer_poll')
    try {
      await installObserverSchema(store)
      const settings = config(history, source.baseUrl)
      const first = await pollObserverOnce(store, settings, 'poll-worker',
        { maxLeafPages: 16, maxCheckpoints: 2, maxMs: 20_000 })
      expect(first).toMatchObject({ status: 'pending' })
      const partial = await inspector.query(
        'SELECT staged_next_index, accepted_size, active_attempt_id FROM observer_poll.observer_cursors')
      expect(partial.rows[0]).toMatchObject({ staged_next_index: '1', accepted_size: '0' })
      expect((await inspector.query('SELECT count(*) AS total FROM observer_poll.observer_staged_checkpoints')).rows[0].total)
        .toBe('2')
      const attemptId = partial.rows[0].active_attempt_id
      const leafLimited = await pollObserverOnce(store, settings, 'poll-worker',
        { maxLeafPages: 1, maxCheckpoints: 1, maxMs: 20_000 })
      expect(leafLimited).toMatchObject({ status: 'pending' })
      expect((await inspector.query('SELECT staged_next_index FROM observer_poll.observer_cursors')).rows[0].staged_next_index)
        .toBe('2')
      const resumed = await pollObserverOnce(store, settings, 'poll-worker',
        { maxLeafPages: 16, maxCheckpoints: 16, maxMs: 20_000 })
      expect(resumed).toMatchObject({ status: 'accepted', snapshot: { size: history.leaves.length } })
      const accepted = await inspector.query(
        'SELECT accepted_size, active_attempt_id, version FROM observer_poll.observer_cursors')
      expect(accepted.rows[0]).toMatchObject({ accepted_size: '7', active_attempt_id: null })
      expect((await inspector.query('SELECT attempt_id FROM observer_poll.observer_targets')).rows)
        .toEqual([{ attempt_id: attemptId }])
      const again = await pollObserverOnce(store, settings, 'poll-worker',
        { maxLeafPages: 16, maxCheckpoints: 16, maxMs: 20_000 })
      expect(again).toMatchObject({ status: 'up_to_date' })
      expect((await inspector.query('SELECT version FROM observer_poll.observer_cursors')).rows[0].version)
        .toBe(accepted.rows[0].version)
    } finally { await store.close(); await source.close() }
  })

  it('resumes leaves staged before a multi-checkpoint page completes', async () => {
    const history = await buildGovernanceSource()
    const source = await startGovernanceSource(history, undefined, undefined, { leafPageSize: 1 })
    const store = openObserverStore(databaseUrl, 'observer_poll_paged_leaves')
    try {
      await installObserverSchema(store)
      const settings = { ...config(history, source.baseUrl), databaseSchema: 'observer_poll_paged_leaves' }
      const first = await pollObserverOnce(store, settings, 'paged',
        { maxLeafPages: 1, maxCheckpoints: 16, maxMs: 20_000 })
      expect(first.status).toBe('pending')
      expect((await inspector.query(`SELECT staged_next_index, accepted_size
        FROM observer_poll_paged_leaves.observer_cursors`)).rows[0])
        .toEqual({ staged_next_index: '1', accepted_size: '0' })
      expect((await inspector.query(`SELECT count(*) AS total
        FROM observer_poll_paged_leaves.observer_staged_checkpoints`)).rows[0].total)
        .toBe('0')
      const second = await pollObserverOnce(store, settings, 'paged',
        { maxLeafPages: 16, maxCheckpoints: 16, maxMs: 20_000 })
      expect(second).toMatchObject({ status: 'accepted', snapshot: { size: 7 } })
      expect(source.calls.filter(url => url.pathname.endsWith('/checkpoints'))).toHaveLength(2)
    } finally { await store.close(); await source.close() }
  })

  it('uses an explicitly advertised target without discovering mutable feed head', async () => {
    const history = await buildGovernanceSource()
    const source = await startGovernanceSource(history)
    const store = openObserverStore(databaseUrl, 'observer_fixed_target')
    try {
      await installObserverSchema(store)
      const signedCheckpoint = history.checkpoints.at(-1)!
      const fixed = { provisional: true as const, signedCheckpoint,
        checkpointHash: await authority.checkpointHash(signedCheckpoint.statement),
        signedCheckpointBytes: authority.canonicalBytes(signedCheckpoint) }
      const settings = { ...config(history, source.baseUrl), databaseSchema: 'observer_fixed_target' }
      expect(await pollObserverOnce(store, settings, 'fixed',
        { maxLeafPages: 16, maxCheckpoints: 16, maxMs: 20_000 }, fixed))
        .toMatchObject({ status: 'accepted', snapshot: { checkpointHash: fixed.checkpointHash } })
      expect(await readAcceptedObserverReplay(store, settings.feedId))
        .toMatchObject({ checkpointHash: fixed.checkpointHash, size: history.leaves.length })
      expect(source.calls.some(url => url.pathname.endsWith('/head'))).toBe(false)
      expect(source.calls.filter(url => url.pathname.endsWith('/checkpoints'))).toHaveLength(1)
      expect((await inspector.query(`SELECT
        (SELECT count(*) FROM observer_fixed_target.observer_leaves) AS leaves,
        (SELECT count(*) FROM observer_fixed_target.observer_checkpoints) AS checkpoints`)).rows[0])
        .toEqual({ leaves: '7', checkpoints: '8' })
    } finally { await store.close(); await source.close() }
  })

  it('leaves a target pending through source unavailability, then catches up', async () => {
    const history = await buildGovernanceSource()
    const faults: GovernanceSourceFaults = { unavailableLeaves: true }
    const source = await startGovernanceSource(history, undefined, undefined, faults)
    const store = openObserverStore(databaseUrl, 'observer_poll_unavailable')
    try {
      await installObserverSchema(store)
      const settings = config(history, source.baseUrl)
      const unavailable = await pollObserverOnce(store, settings, 'poll-worker',
        { maxLeafPages: 16, maxCheckpoints: 16, maxMs: 20_000 })
      expect(unavailable).toMatchObject({ status: 'unavailable' })
      const prior = await inspector.query(
        'SELECT active_attempt_id, accepted_size FROM observer_poll_unavailable.observer_cursors')
      expect(prior.rows[0].active_attempt_id).not.toBeNull()
      expect(prior.rows[0].accepted_size).toBe('0')
      expect((await inspector.query('SELECT count(*) AS total FROM observer_poll_unavailable.observer_findings')).rows[0].total)
        .toBe('0')
      faults.unavailableLeaves = false
      const resumed = await pollObserverOnce(store, settings, 'poll-worker',
        { maxLeafPages: 16, maxCheckpoints: 16, maxMs: 20_000 })
      expect(resumed).toMatchObject({ status: 'accepted', snapshot: { size: 7 } })
      expect((await inspector.query('SELECT attempt_id FROM observer_poll_unavailable.observer_targets')).rows)
        .toEqual([{ attempt_id: prior.rows[0].active_attempt_id }])
    } finally { await store.close(); await source.close() }
  })

  it('quarantines a complete but replay-invalid signed target', async () => {
    const history = await buildGovernanceSource()
    const source = await startGovernanceSource(history, history.wrongRoot)
    const store = openObserverStore(databaseUrl, 'observer_poll_invalid')
    try {
      await installObserverSchema(store)
      const result = await pollObserverOnce(store, config(history, source.baseUrl), 'poll-worker',
        { maxLeafPages: 16, maxCheckpoints: 16, maxMs: 20_000 })
      expect(result).toMatchObject({ status: 'quarantined' })
      const cursor = await inspector.query(
        'SELECT accepted_size, active_attempt_id FROM observer_poll_invalid.observer_cursors')
      expect(cursor.rows).toEqual([{ accepted_size: '0', active_attempt_id: null }])
      expect((await inspector.query('SELECT finding_type FROM observer_poll_invalid.observer_findings')).rows)
        .toEqual([{ finding_type: 'invalid_replay' }])
    } finally { await store.close(); await source.close() }
  })

  it('retains source nonconformance without treating it as a cryptographic finding', async () => {
    const history = await buildGovernanceSource()
    const faults: GovernanceSourceFaults = { omitGenesis: true }
    const source = await startGovernanceSource(history, undefined, undefined, faults)
    const store = openObserverStore(databaseUrl, 'observer_poll_protocol')
    try {
      await installObserverSchema(store)
      const settings = config(history, source.baseUrl)
      const first = await pollObserverOnce(store, settings, 'poll-worker',
        { maxLeafPages: 16, maxCheckpoints: 16, maxMs: 20_000 })
      expect(first).toMatchObject({ status: 'source_nonconforming' })
      const cursor = await inspector.query(
        'SELECT accepted_size, active_attempt_id, version FROM observer_poll_protocol.observer_cursors')
      expect(cursor.rows[0].accepted_size).toBe('0')
      expect(cursor.rows[0].active_attempt_id).not.toBeNull()
      const findings = await inspector.query(
        'SELECT finding_type, evidence_bytes, resolved_at FROM observer_poll_protocol.observer_findings')
      expect(findings.rows).toHaveLength(1)
      expect(findings.rows[0].finding_type).toBe('source_nonconformance')
      expect(findings.rows[0].resolved_at).toBeNull()
      expect(authority.parseCanonical(findings.rows[0].evidence_bytes)).toMatchObject({
        kind: 'observer.source_nonconformance', feedId: settings.feedId,
      })
      const second = await pollObserverOnce(store, settings, 'poll-worker',
        { maxLeafPages: 16, maxCheckpoints: 16, maxMs: 20_000 })
      expect(second).toMatchObject({ status: 'source_nonconforming' })
      expect((await inspector.query('SELECT count(*) AS total FROM observer_poll_protocol.observer_findings')).rows[0].total)
        .toBe('1')
      faults.omitGenesis = false
      const caughtUp = await pollObserverOnce(store, settings, 'poll-worker',
        { maxLeafPages: 16, maxCheckpoints: 16, maxMs: 20_000 })
      expect(caughtUp).toMatchObject({ status: 'accepted', snapshot: { size: 7 } })
      expect((await inspector.query('SELECT resolved_at FROM observer_poll_protocol.observer_findings')).rows[0].resolved_at)
        .toBeNull()
    } finally { await store.close(); await source.close() }
  })
})
