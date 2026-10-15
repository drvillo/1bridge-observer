import { afterAll, expect, it } from 'vitest'
import pg from 'pg'
import * as authority from '@drvillo/1bridge-authority'
import { loadSharedObserverConfig, verifyRegistryPin } from '../src/lib/config'
import { pollSharedObserverOnce } from '../src/lib/shared-poll'
import { publishAggregateCoverage, readAggregateFeedStatusProof } from '../src/lib/aggregate-store'
import { installObserverSchema, openObserverStore } from '../src/lib/store'

const databaseUrl = process.env.OBSERVER_TEST_DATABASE_URL
const sourceUrl = process.env.OBSERVER_LIVE_SOURCE_BASE_URL
const publisherSpki = process.env.OBSERVER_LIVE_REGISTRY_PUBLIC_KEY
const genesis = process.env.OBSERVER_LIVE_REGISTRY_GENESIS
const expectedFeeds = process.env.OBSERVER_LIVE_FEEDS
  ? JSON.parse(process.env.OBSERVER_LIVE_FEEDS) as { feedId: string; anchorPin: string }[]
  : []
const enabled = Boolean(databaseUrl && sourceUrl && publisherSpki && genesis
  && expectedFeeds.length > 0)

const inspector = enabled ? new pg.Pool({ connectionString: databaseUrl, max: 1 }) : null
afterAll(async () => inspector?.end())

/** Opt-in contract for a real, disposable 1Bridge source and a separate Postgres instance. */
it.skipIf(!enabled)('pulls live 1Bridge routes into observer-owned Postgres and signs feed coverage', async () => {
  const config = loadSharedObserverConfig({ NODE_ENV: 'test',
    SOURCE_BASE_URL: sourceUrl, DATABASE_URL: databaseUrl,
    OBSERVER_SCHEMA: 'observer_live_source', CRON_SECRET: 'x'.repeat(32),
    REGISTRY_PUBLISHER_PUBLIC_KEY: publisherSpki,
    REGISTRY_SIGNED_GENESIS: genesis })
  const store = openObserverStore(config.databaseUrl, config.databaseSchema)
  try {
    await installObserverSchema(store)
    const budget = { registry: { maxEntryPages: 8, maxCheckpoints: 8, maxMs: 15_000 },
      feed: { maxLeafPages: 8, maxCheckpoints: 8, maxMs: 15_000 },
      maxFeeds: 8, maxMs: 30_000 }
    let result = await pollSharedObserverOnce(store, config, 'live-1', budget)
    if (result.registry.status === 'pending') {
      result = await pollSharedObserverOnce(store, config, 'live-2', budget)
    }
    expect(['accepted', 'up_to_date']).toContain(result.registry.status)
    const signer = await authority.generateSigningKey()
    const report = await publishAggregateCoverage(store, config, signer)
    const { publisherKey } = await verifyRegistryPin(config)
    for (const { feedId, anchorPin } of expectedFeeds) {
      expect(result.feeds).toContainEqual({ feedId,
        status: expect.stringMatching(/^(accepted|up_to_date)$/) })
      const persisted = await inspector!.query(
        `SELECT f.feed_id, f.anchor_pin, c.accepted_size
         FROM observer_live_source.observer_feeds f
         JOIN observer_live_source.observer_cursors c USING (feed_id)
         WHERE f.feed_id = $1`,
        [feedId],
      )
      expect(persisted.rows).toHaveLength(1)
      expect(persisted.rows[0]).toMatchObject({ feed_id: feedId, anchor_pin: anchorPin })
      expect(Number(persisted.rows[0].accepted_size)).toBeGreaterThan(0)
      const proof = await readAggregateFeedStatusProof(store, config, signer.publicKey,
        report.reportHash, feedId)
      expect(proof?.status.status).toBe('verified')
      expect(await authority.verifyAggregateFeedStatus(report.signedReport, proof!,
        signer.publicKey, publisherKey, result.registryHash,
        feedId, anchorPin)).toBe(true)
    }
  } finally {
    await store.close()
  }
})
