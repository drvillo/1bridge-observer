import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import * as authority from '@drvillo/1bridge-authority'
import { claimObserverLease, installObserverSchema, openObserverStore, registerObserverFeed,
  type ObserverStore } from '../src/lib/store'
import type { ObserverConfig } from '../src/lib/config'

const databaseUrl = process.env.OBSERVER_TEST_DATABASE_URL
if (!databaseUrl) throw new Error('OBSERVER_TEST_DATABASE_URL must identify a disposable database')

const vector = authority.parseCanonical(readFileSync(new URL('./governance-v1.json', import.meta.url))) as unknown as {
  anchorPin: string; signedAnchor: string; expected: authority.GovernanceReplaySnapshot
}
const config: ObserverConfig = { sourceBaseUrl: 'https://evidence.example', feedId: vector.expected.feedId,
  anchorPin: vector.anchorPin, signedAnchor: vector.signedAnchor,
  databaseUrl, cronSecret: 'x'.repeat(32) }

describe('durable observer store', () => {
  let store: ObserverStore
  const inspector = new pg.Pool({ connectionString: databaseUrl, max: 1 })

  beforeAll(() => { store = openObserverStore(databaseUrl, 'observer_test') })
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
})
