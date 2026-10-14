import { readFileSync } from 'node:fs'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import pg from 'pg'
import * as authority from '@drvillo/1bridge-authority'
import { loadSharedObserverConfig } from '../src/lib/config'
import { pollSharedObserverOnce } from '../src/lib/shared-poll'
import * as feedPoll from '../src/lib/poll'
import { publishAggregateCoverage, readAggregateFeedStatusProof,
  readLatestAggregateCoverage } from '../src/lib/aggregate-store'
import { installObserverSchema, openObserverStore } from '../src/lib/store'

const databaseUrl = process.env.OBSERVER_TEST_DATABASE_URL
if (!databaseUrl) throw new Error('OBSERVER_TEST_DATABASE_URL must identify a disposable database')
const vector = JSON.parse(readFileSync(new URL('./shared-registry-v1.json', import.meta.url), 'utf8'))
const inspector = new pg.Pool({ connectionString: databaseUrl, max: 1 })
const encoded = (value: unknown) => authority.encodeBase64Url(authority.canonicalBytes(value))
const entries = vector.entries.map((item: string) => authority.parseCanonical(authority.decodeBase64Url(item)))
const heads = new Map<string, authority.SignedCheckpoint>(entries.filter((entry: authority.RegistryEntry) =>
  entry.kind === 'feed_head').map((entry: authority.RegistryEntry) =>
    [entry.feedId, (entry as Extract<authority.RegistryEntry, { kind: 'feed_head' }>).signedCheckpoint]))

function config(schema: string) {
  return loadSharedObserverConfig({ NODE_ENV: 'production', SOURCE_BASE_URL: 'https://source.example/',
    DATABASE_URL: databaseUrl, OBSERVER_SCHEMA: schema, CRON_SECRET: 'x'.repeat(32),
    REGISTRY_PUBLISHER_PUBLIC_KEY: vector.publisherPublicKey,
    REGISTRY_SIGNED_GENESIS: encoded(vector.genesis) })
}

function source(unavailableFeed?: string) {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(input)
    const target = vector.snapshotTwo.checkpointHash
    let envelope: unknown
    if (url.pathname === '/api/governance/v1/registry/head') {
      envelope = { version: 1, signedCheckpoint: encoded(vector.headTwo), checkpointHash: target }
    } else if (url.pathname === '/api/governance/v1/registry/checkpoints') {
      const after = url.searchParams.get('after')
      envelope = { version: 1, target, after,
        items: [encoded(after === vector.headOne.statement.previous ? vector.headOne : vector.headTwo)] }
    } else if (url.pathname === '/api/governance/v1/registry/entries') {
      const start = Number(url.searchParams.get('start'))
      envelope = { version: 1, target, start,
        items: vector.entries.slice(start, start + Number(url.searchParams.get('limit'))) }
    } else if (url.pathname === '/api/governance/v1/registry/consistency') {
      const old = url.searchParams.get('old')
      const next = url.searchParams.get('target')
      envelope = { version: 1, old, target: next,
        proof: next === vector.snapshotOne.checkpointHash ? vector.proofOne : vector.proofTwo }
    } else {
      const match = /^\/api\/governance\/v1\/feeds\/([0-9a-f]{64})\/(checkpoints|leaves)$/.exec(url.pathname)
      if (!match) throw new TypeError('Unknown feed route')
      if (match[1] === unavailableFeed) return new Response(null, { status: 503 })
      const signed = heads.get(match[1]!)
      if (!signed) return new Response(null, { status: 404 })
      envelope = match[2] === 'checkpoints'
        ? { version: 1, target: url.searchParams.get('target'),
          after: url.searchParams.get('after'), items: [encoded(signed)] }
        : { version: 1, target: url.searchParams.get('target'),
          start: Number(url.searchParams.get('start')), items: [] }
    }
    return new Response(authority.canonicalJson(envelope), { status: 200 })
  }))
}

const budget = { registry: { maxEntryPages: 4, maxCheckpoints: 4, maxMs: 15_000 },
  feed: { maxLeafPages: 4, maxCheckpoints: 4, maxMs: 10_000 }, maxFeeds: 2, maxMs: 30_000 }

describe('shared multi-feed observer', () => {
  afterEach(() => vi.unstubAllGlobals())
  afterAll(async () => { await inspector.end() })

  it('discovers and verifies two feeds without customer-specific configuration', async () => {
    source()
    const store = openObserverStore(databaseUrl, 'observer_shared_poll')
    try {
      await installObserverSchema(store)
      const result = await pollSharedObserverOnce(store, config('observer_shared_poll'), 'shared', budget)
      expect(result.registry).toMatchObject({ status: 'accepted', snapshot: vector.snapshotTwo })
      expect(result.feeds).toEqual(vector.feedIds.map((feedId: string) => ({ feedId, status: 'accepted' })))
      expect((await inspector.query('SELECT feed_id FROM observer_shared_poll.observer_feeds ORDER BY feed_id')).rows
        .map(row => row.feed_id)).toEqual(vector.feedIds)
      const signer = await authority.generateSigningKey()
      const report = await publishAggregateCoverage(store, config('observer_shared_poll'), signer)
      expect(report.signedReport.statement).toMatchObject({ coverageScope: 'shared_registry',
        registryCheckpointHash: vector.snapshotTwo.checkpointHash,
        verifiedFeeds: { count: 2 }, pendingFeeds: { count: 0 } })
      expect((await readLatestAggregateCoverage(store, config('observer_shared_poll'),
        signer.publicKey))?.reportHash).toBe(report.reportHash)
    } finally { await store.close() }
  })

  it('continues other feeds while one advertised feed is unavailable', async () => {
    source(vector.feedIds[1])
    const store = openObserverStore(databaseUrl, 'observer_shared_poll_partial')
    try {
      await installObserverSchema(store)
      const result = await pollSharedObserverOnce(store, config('observer_shared_poll_partial'), 'shared', budget)
      expect(result.feeds).toEqual([
        { feedId: vector.feedIds[0], status: 'accepted' },
        { feedId: vector.feedIds[1], status: 'unavailable' },
      ])
      expect((await inspector.query('SELECT accepted_size FROM observer_shared_poll_partial.observer_cursors ORDER BY feed_id')).rows)
        .toEqual([{ accepted_size: '0' }, { accepted_size: '0' }])
      const signer = await authority.generateSigningKey()
      const report = await publishAggregateCoverage(store, config('observer_shared_poll_partial'), signer)
      expect(report.signedReport.statement).toMatchObject({ verifiedFeeds: { count: 1 },
        pendingFeeds: { count: 1 } })
      const proof = await readAggregateFeedStatusProof(store, config('observer_shared_poll_partial'),
        signer.publicKey, report.reportHash, vector.feedIds[1])
      expect(proof?.status.status).toBe('pending')
      const publisher = await authority.importSigningPublicKey(vector.publisherPublicKey)
      expect(await authority.verifyAggregateFeedStatus(report.signedReport, proof!,
        signer.publicKey, publisher, vector.snapshotTwo.checkpointHash,
        vector.feedIds[1], vector.snapshotTwo.feeds[1].anchorPin)).toBe(true)
    } finally { await store.close() }
  })

  it('continues the next feed when a prior feed replay exceeds its local budget', async () => {
    source()
    const store = openObserverStore(databaseUrl, 'observer_shared_poll_error')
    const realPoll = feedPoll.pollObserverOnce
    const spy = vi.spyOn(feedPoll, 'pollObserverOnce').mockImplementation(async (currentStore, currentConfig,
      workerId, currentBudget, target) => {
      if (currentConfig.feedId === vector.feedIds[0]) throw new RangeError('Observer replay budget exceeded')
      return realPoll(currentStore, currentConfig, workerId, currentBudget, target)
    })
    try {
      await installObserverSchema(store)
      const result = await pollSharedObserverOnce(store, config('observer_shared_poll_error'), 'shared', budget)
      expect(result.feeds).toEqual([
        { feedId: vector.feedIds[0], status: 'error' },
        { feedId: vector.feedIds[1], status: 'accepted' },
      ])
    } finally { spy.mockRestore(); await store.close() }
  })
})
