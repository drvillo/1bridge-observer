import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { afterAll, expect, it } from 'vitest'
import pg from 'pg'
import * as authority from '@drvillo/1bridge-authority'
import { loadSharedObserverConfig } from '../src/lib/config'
import { pollSharedObserverOnce } from '../src/lib/shared-poll'
import { nextSharedContinuation } from '../src/lib/shared-continuation'
import { runSharedPollCycle } from '../src/lib/shared-poll-run'
import { publishAggregateCoverage, readAggregateFeedStatusProof } from '../src/lib/aggregate-store'
import { installObserverSchema, openObserverStore } from '../src/lib/store'

const databaseUrl = process.env.OBSERVER_TEST_DATABASE_URL
if (!databaseUrl) throw new Error('OBSERVER_TEST_DATABASE_URL must identify a disposable database')
const vector = JSON.parse(readFileSync(new URL('./shared-registry-v1.json', import.meta.url), 'utf8'))
const encoded = (value: unknown) => authority.encodeBase64Url(authority.canonicalBytes(value))
const inspector = new pg.Pool({ connectionString: databaseUrl, max: 1 })
afterAll(async () => inspector.end())

const budget = { registry: { maxEntryPages: 4, maxCheckpoints: 1, maxMs: 15_000 },
  feed: { maxLeafPages: 4, maxCheckpoints: 4, maxMs: 10_000 }, maxFeeds: 2, maxMs: 30_000 }

async function startSharedHttpSource() {
  const calls: URL[] = []
  const heads = new Map<string, authority.SignedCheckpoint>()
  for (const item of vector.entries as string[]) {
    const entry = authority.parseCanonical(authority.decodeBase64Url(item)) as unknown as authority.RegistryEntry
    if (entry.kind === 'feed_head') heads.set(entry.feedId, entry.signedCheckpoint)
  }
  const fixture = { unavailableFeed: null as string | null, skipRegistryCheckpoint: false }
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    calls.push(url)
    const target = vector.snapshotTwo.checkpointHash
    const after = url.searchParams.get('after')
    let body: unknown
    if (url.pathname === '/api/governance/v1/registry/head') {
      body = { version: 1, checkpointHash: target, signedCheckpoint: encoded(vector.headTwo) }
    } else if (url.pathname === '/api/governance/v1/registry/checkpoints') {
      const next = after === vector.headOne.statement.previous
        ? fixture.skipRegistryCheckpoint ? vector.headTwo : vector.headOne :
        after === vector.snapshotOne.checkpointHash ? vector.headTwo : null
      if (!next || url.searchParams.get('target') !== target) { res.writeHead(409).end(); return }
      body = { version: 1, target, after, items: [encoded(next)] }
    } else if (url.pathname === '/api/governance/v1/registry/entries') {
      const start = Number(url.searchParams.get('start'))
      const limit = Number(url.searchParams.get('limit'))
      if (url.searchParams.get('target') !== target || !Number.isSafeInteger(start)
        || !Number.isSafeInteger(limit) || start < 0 || limit < 1 || limit > 64) {
        res.writeHead(400).end(); return
      }
      body = { version: 1, target, start, items: vector.entries.slice(start, start + limit) }
    } else if (url.pathname === '/api/governance/v1/registry/consistency') {
      const old = url.searchParams.get('old')
      const next = url.searchParams.get('target')
      if (next !== vector.snapshotOne.checkpointHash && next !== target) {
        res.writeHead(409).end(); return
      }
      body = { version: 1, old, target: next,
        proof: next === vector.snapshotOne.checkpointHash ? vector.proofOne : vector.proofTwo }
    } else {
      const match = /^\/api\/governance\/v1\/feeds\/([0-9a-f]{64})\/(checkpoints|leaves)$/.exec(url.pathname)
      const head = match ? heads.get(match[1]!) : undefined
      if (!match || !head) { res.writeHead(404).end(); return }
      if (match[1] === fixture.unavailableFeed) { res.writeHead(503).end(); return }
      const feedTarget = vector.snapshotTwo.feeds.find((feed: { feedId: string }) => feed.feedId === match[1])
      if (url.searchParams.get('target') !== feedTarget?.advertisedCheckpointHash) {
        res.writeHead(409).end(); return
      }
      body = match[2] === 'checkpoints'
        ? { version: 1, target: feedTarget.advertisedCheckpointHash, after, items: [encoded(head)] }
        : { version: 1, target: feedTarget.advertisedCheckpointHash,
          start: Number(url.searchParams.get('start')), items: [] }
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(authority.canonicalJson(body))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind TCP port')
  return { baseUrl: `http://127.0.0.1:${address.port}`, calls,
    get unavailableFeed() { return fixture.unavailableFeed },
    set unavailableFeed(value: string | null) { fixture.unavailableFeed = value },
    get skipRegistryCheckpoint() { return fixture.skipRegistryCheckpoint },
    set skipRegistryCheckpoint(value: boolean) { fixture.skipRegistryCheckpoint = value },
    close: () => new Promise<void>((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve())) }
}

it('pulls pinned registry and two feeds over HTTP, catches up after an outage, and verifies public proof', async () => {
  const source = await startSharedHttpSource()
  const config = loadSharedObserverConfig({ NODE_ENV: 'test', SOURCE_BASE_URL: source.baseUrl,
    DATABASE_URL: databaseUrl, OBSERVER_SCHEMA: 'observer_shared_http', CRON_SECRET: 'x'.repeat(32),
    REGISTRY_PUBLISHER_PUBLIC_KEY: vector.publisherPublicKey,
    REGISTRY_SIGNED_GENESIS: encoded(vector.genesis) })
  const store = openObserverStore(databaseUrl, config.databaseSchema)
  try {
    await installObserverSchema(store)
    source.unavailableFeed = vector.feedIds[0]
    const first = await pollSharedObserverOnce(store, config, 'first', budget)
    expect(first.registry.status).toBe('pending')
    const firstContinuation = nextSharedContinuation(null, { feedCount: first.feedCount,
      selectedCount: first.selectedCount, madeProgress: first.madeProgress,
      maxFeeds: budget.maxFeeds })
    expect(firstContinuation).not.toBeNull()
    expect((await inspector.query('SELECT accepted_size, staged_next_index FROM observer_shared_http.observer_registry_cursor')).rows)
      .toEqual([{ accepted_size: '0', staged_next_index: '3' }])
    const second = await pollSharedObserverOnce(store, config, 'second', budget)
    expect(second.registry.status).toBe('accepted')
    const secondContinuation = nextSharedContinuation(firstContinuation, {
      feedCount: second.feedCount, selectedCount: second.selectedCount,
      madeProgress: second.madeProgress, maxFeeds: budget.maxFeeds })
    expect(secondContinuation).not.toBeNull()
    expect(second.feeds).toEqual([
      { feedId: vector.feedIds[0], status: 'unavailable' },
      { feedId: vector.feedIds[1], status: 'accepted' },
    ])
    const signer = await authority.generateSigningKey()
    const pendingReport = await publishAggregateCoverage(store, config, signer)
    const pendingProof = await readAggregateFeedStatusProof(store, config, signer.publicKey,
      pendingReport.reportHash, vector.feedIds[0])
    const publisher = await authority.importSigningPublicKey(vector.publisherPublicKey)
    expect(pendingProof?.status.status).toBe('pending')
    expect(await authority.verifyAggregateFeedStatus(pendingReport.signedReport, pendingProof!,
      signer.publicKey, publisher, vector.snapshotTwo.checkpointHash,
      vector.feedIds[0], vector.snapshotTwo.feeds[0].anchorPin)).toBe(true)
    const outage = await runSharedPollCycle({ config, signer }, 'outage', 'when_changed')
    expect(outage.feeds[0]?.status).toBe('unavailable')
    expect(outage.report).toBeNull()
    expect((await inspector.query('SELECT count(*) AS total FROM observer_shared_http.observer_aggregate_reports')).rows[0].total)
      .toBe('1')
    expect(nextSharedContinuation(secondContinuation, { feedCount: outage.feedCount,
      selectedCount: outage.selectedCount, madeProgress: outage.madeProgress,
      maxFeeds: budget.maxFeeds })).toBeNull()
    source.unavailableFeed = null
    const caughtUp = await pollSharedObserverOnce(store, config, 'catch-up', budget)
    expect(caughtUp.feeds).toEqual(vector.feedIds.map((feedId: string) => ({ feedId,
      status: feedId === vector.feedIds[0] ? 'accepted' : 'up_to_date' })))
    const report = await publishAggregateCoverage(store, config, signer)
    const proof = await readAggregateFeedStatusProof(store, config, signer.publicKey,
      report.reportHash, vector.feedIds[0])
    expect(proof?.status.status).toBe('verified')
    expect(await authority.verifyAggregateFeedStatus(report.signedReport, proof!,
      signer.publicKey, publisher, vector.snapshotTwo.checkpointHash,
      vector.feedIds[0], vector.snapshotTwo.feeds[0].anchorPin)).toBe(true)
    expect(source.calls.some(url => url.pathname.endsWith('/registry/entries'))).toBe(true)
    expect(source.calls.some(url => url.pathname.endsWith(`/feeds/${vector.feedIds[1]}/checkpoints`))).toBe(true)
  } finally { await store.close(); await source.close() }
})

it('retains a missing registry checkpoint finding and resolves it after HTTP catch-up', async () => {
  const source = await startSharedHttpSource()
  const config = loadSharedObserverConfig({ NODE_ENV: 'test', SOURCE_BASE_URL: source.baseUrl,
    DATABASE_URL: databaseUrl, OBSERVER_SCHEMA: 'observer_shared_http_gap', CRON_SECRET: 'x'.repeat(32),
    REGISTRY_PUBLISHER_PUBLIC_KEY: vector.publisherPublicKey,
    REGISTRY_SIGNED_GENESIS: encoded(vector.genesis) })
  const store = openObserverStore(databaseUrl, config.databaseSchema)
  try {
    await installObserverSchema(store)
    source.skipRegistryCheckpoint = true
    const missing = await pollSharedObserverOnce(store, config, 'missing',
      { ...budget, registry: { ...budget.registry, maxCheckpoints: 4 } })
    expect(missing.registry.status).toBe('source_nonconforming')
    expect((await inspector.query('SELECT accepted_size FROM observer_shared_http_gap.observer_registry_cursor')).rows)
      .toEqual([{ accepted_size: '0' }])
    expect((await inspector.query('SELECT finding_type FROM observer_shared_http_gap.observer_registry_findings')).rows)
      .toEqual([{ finding_type: 'source_nonconformance' }])
    source.skipRegistryCheckpoint = false
    const caughtUp = await pollSharedObserverOnce(store, config, 'recovered',
      { ...budget, registry: { ...budget.registry, maxCheckpoints: 4 } })
    expect(caughtUp.registry.status).toBe('accepted')
    expect((await inspector.query('SELECT resolved_at IS NOT NULL AS resolved FROM observer_shared_http_gap.observer_registry_findings')).rows)
      .toEqual([{ resolved: true }])
  } finally { await store.close(); await source.close() }
})
