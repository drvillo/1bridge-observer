import { readFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import * as authority from '@drvillo/1bridge-authority'
import { loadSharedObserverConfig, verifyRegistryPin } from '../src/lib/config'
import { installObserverSchema, openObserverStore } from '../src/lib/store'
import { acceptRegistryTarget, beginRegistryTarget, claimRegistryLease,
  initializeRegistry, readRegistryFeeds, readRegistryProgress, releaseRegistryLease,
  selectRegistryFeedBatch, type RegistryFeed,
  stageRegistryCheckpoint, stageRegistryEntries } from '../src/lib/registry-store'

const databaseUrl = process.env.OBSERVER_TEST_DATABASE_URL
if (!databaseUrl) throw new Error('OBSERVER_TEST_DATABASE_URL must identify a disposable database')
const vector = JSON.parse(readFileSync(new URL('./shared-registry-v1.json', import.meta.url), 'utf8'))
const config = loadSharedObserverConfig({ NODE_ENV: 'production',
  SOURCE_BASE_URL: 'https://evidence.example/', DATABASE_URL: databaseUrl,
  OBSERVER_SCHEMA: 'observer_registry', CRON_SECRET: 'x'.repeat(32),
  REGISTRY_PUBLISHER_PUBLIC_KEY: vector.publisherPublicKey,
  REGISTRY_SIGNED_GENESIS: authority.encodeBase64Url(authority.canonicalBytes(vector.genesis)) })
const inspector = new pg.Pool({ connectionString: databaseUrl, max: 1 })
const head = (signedCheckpoint: authority.SignedRegistryCheckpoint, checkpointHash: string) => ({
  provisional: true as const, signedCheckpoint, checkpointHash,
  signedCheckpointBytes: authority.canonicalBytes(signedCheckpoint) })
const item = (signed: authority.SignedRegistryCheckpoint, hash: string) => ({
  bytes: authority.canonicalBytes(signed), signed, hash })

describe('durable shared registry cursor', () => {
  afterAll(async () => { await inspector.end() })

  it('stages two offline targets across store restarts and fences competing workers', async () => {
    const pin = await verifyRegistryPin(config)
    let store = openObserverStore(databaseUrl, 'observer_registry')
    await installObserverSchema(store)
    await initializeRegistry(store, pin)
    await initializeRegistry(store, pin)
    const first = await claimRegistryLease(store, 'worker-a', 30_000)
    expect(first).not.toBeNull()
    expect(await claimRegistryLease(store, 'worker-b', 30_000)).toBeNull()
    let claim = await beginRegistryTarget(store, first!, head(vector.headOne, vector.snapshotOne.checkpointHash), pin.publisherKey)
    claim = await stageRegistryEntries(store, claim, 0,
      vector.entries.slice(0, 3).map((encoded: string) => authority.decodeBase64Url(encoded)))
    claim = await stageRegistryCheckpoint(store, claim,
      item(vector.headOne, vector.snapshotOne.checkpointHash), vector.proofOne, pin.publisherKey)
    expect((await readRegistryProgress(store, claim)).acceptedSize).toBe(0)
    await releaseRegistryLease(store, claim)
    await store.close()

    store = openObserverStore(databaseUrl, 'observer_registry')
    try {
      const resumed = await claimRegistryLease(store, 'worker-b', 30_000)
      expect(resumed).not.toBeNull()
      const pending = await readRegistryProgress(store, resumed!)
      expect(pending).toMatchObject({ acceptedSize: 0, stagedNextIndex: 3,
        checkpointAfter: vector.snapshotOne.checkpointHash,
        target: { checkpointHash: vector.snapshotOne.checkpointHash } })
      const acceptedOne = await acceptRegistryTarget(store, resumed!, pin.publisherKey)
      expect(acceptedOne).toEqual(vector.snapshotOne)
      expect((await inspector.query('SELECT accepted_size, target_hash FROM observer_registry.observer_registry_cursor')).rows)
        .toEqual([{ accepted_size: '3', target_hash: null }])
      await releaseRegistryLease(store, resumed!)

      const second = await claimRegistryLease(store, 'worker-b', 30_000)
      let next = await beginRegistryTarget(store, second!, head(vector.headTwo, vector.snapshotTwo.checkpointHash), pin.publisherKey)
      await expect(stageRegistryEntries(store, next, 4,
        [authority.decodeBase64Url(vector.entries[3])])).rejects.toThrow()
      next = await stageRegistryEntries(store, next, 3,
        [authority.decodeBase64Url(vector.entries[3])])
      next = await stageRegistryCheckpoint(store, next,
        item(vector.headTwo, vector.snapshotTwo.checkpointHash), vector.proofTwo, pin.publisherKey)
      expect(await acceptRegistryTarget(store, next, pin.publisherKey)).toEqual(vector.snapshotTwo)
      const published = await readRegistryFeeds(store, pin.publisherKey)
      expect(published.snapshot).toEqual(vector.snapshotTwo)
      expect(published.feeds.map(feed => feed.feedId)).toEqual(vector.feedIds)
      expect(published.feeds[0]!.advertisedHead?.checkpointHash)
        .toBe(vector.snapshotTwo.feeds[0]!.advertisedCheckpointHash)
      expect((await selectRegistryFeedBatch(store, published.feeds, 1)).map(feed => feed.feedId))
        .toEqual([vector.feedIds[0]])
      expect((await selectRegistryFeedBatch(store, published.feeds, 1)).map(feed => feed.feedId))
        .toEqual([vector.feedIds[1]])
      expect((await inspector.query('SELECT count(*) AS total FROM observer_registry.observer_registry_entries')).rows[0].total)
        .toBe('4')
      await releaseRegistryLease(store, next)
    } finally { await store.close() }
  })

  it('rotates a 25-feed catalog across daily 12-feed budgets and store restarts', async () => {
    const pin = await verifyRegistryPin(config)
    const schema = 'observer_registry_rotation'
    const anchor = authority.parseCanonical(authority.decodeBase64Url(vector.entries[0])) as unknown as
      Extract<authority.RegistryEntry, { kind: 'feed_anchor' }>
    const feeds: RegistryFeed[] = Array.from({ length: 25 }, (_, index) => ({
      feedId: (index + 1).toString(16).padStart(64, '0'),
      anchorPin: anchor.anchorPin, signedAnchor: anchor.signedAnchor, advertisedHead: null,
    }))
    const selected: string[][] = []
    for (let run = 0; run < 3; run++) {
      const store = openObserverStore(databaseUrl, schema)
      try {
        await installObserverSchema(store)
        await initializeRegistry(store, pin)
        selected.push((await selectRegistryFeedBatch(store, feeds, 12)).map(feed => feed.feedId))
      } finally { await store.close() }
    }
    expect(selected[0]).toEqual(feeds.slice(0, 12).map(feed => feed.feedId))
    expect(selected[1]).toEqual(feeds.slice(12, 24).map(feed => feed.feedId))
    expect(selected[2]).toEqual([feeds[24]!.feedId, ...feeds.slice(0, 11).map(feed => feed.feedId)])
    expect(new Set(selected.flat()).size).toBe(feeds.length)
  })
})
