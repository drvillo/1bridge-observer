import { afterAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import * as authority from '@drvillo/1bridge-authority'
import { pollObserverOnce } from '../src/lib/poll'
import { installObserverSchema, openObserverStore } from '../src/lib/store'
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
    databaseUrl: databaseUrl!, cronSecret: 'x'.repeat(32) }
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
      const attemptId = partial.rows[0].active_attempt_id
      const leafLimited = await pollObserverOnce(store, settings, 'poll-worker',
        { maxLeafPages: 1, maxCheckpoints: 16, maxMs: 20_000 })
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
})
