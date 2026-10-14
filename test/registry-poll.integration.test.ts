import { readFileSync } from 'node:fs'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import pg from 'pg'
import * as authority from '@drvillo/1bridge-authority'
import { loadSharedObserverConfig } from '../src/lib/config'
import { pollRegistryOnce } from '../src/lib/registry-poll'
import { installObserverSchema, openObserverStore } from '../src/lib/store'

const databaseUrl = process.env.OBSERVER_TEST_DATABASE_URL
if (!databaseUrl) throw new Error('OBSERVER_TEST_DATABASE_URL must identify a disposable database')
const vector = JSON.parse(readFileSync(new URL('./shared-registry-v1.json', import.meta.url), 'utf8'))
const inspector = new pg.Pool({ connectionString: databaseUrl, max: 1 })
const hashZero = vector.headOne.statement.previous
const encoded = (value: unknown) => authority.encodeBase64Url(authority.canonicalBytes(value))

function config(schema: string) {
  return loadSharedObserverConfig({ NODE_ENV: 'production', SOURCE_BASE_URL: 'https://source.example/',
    DATABASE_URL: databaseUrl, OBSERVER_SCHEMA: schema, CRON_SECRET: 'x'.repeat(32),
    REGISTRY_PUBLISHER_PUBLIC_KEY: vector.publisherPublicKey,
    REGISTRY_SIGNED_GENESIS: encoded(vector.genesis) })
}

function source(skipFirstCheckpoint = false, advertisedHead = vector.headTwo) {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(input)
    const target = advertisedHead === vector.headOne
      ? vector.snapshotOne.checkpointHash : vector.snapshotTwo.checkpointHash
    let envelope: unknown
    if (url.pathname.endsWith('/head')) {
      envelope = { version: 1, signedCheckpoint: encoded(advertisedHead), checkpointHash: target }
    } else if (url.pathname.endsWith('/checkpoints')) {
      const after = url.searchParams.get('after')
      const next = after === hashZero
        ? skipFirstCheckpoint ? vector.headTwo : vector.headOne : vector.headTwo
      envelope = { version: 1, target, after, items: [encoded(next)] }
    } else if (url.pathname.endsWith('/entries')) {
      const start = Number(url.searchParams.get('start'))
      const limit = Number(url.searchParams.get('limit'))
      envelope = { version: 1, target, start, items: vector.entries.slice(start, start + limit) }
    } else if (url.pathname.endsWith('/consistency')) {
      const old = url.searchParams.get('old')
      const next = url.searchParams.get('target')
      envelope = { version: 1, old, target: next,
        proof: next === vector.snapshotOne.checkpointHash ? vector.proofOne : vector.proofTwo }
    } else throw new TypeError('Unknown registry route')
    return new Response(authority.canonicalJson(envelope), { status: 200 })
  }))
}

describe('autonomous durable registry poll', () => {
  afterEach(async () => { vi.unstubAllGlobals() })
  afterAll(async () => { await inspector.end() })

  it('resumes a missed checkpoint backlog within bounded cron budgets', async () => {
    source()
    const store = openObserverStore(databaseUrl, 'observer_registry_poll')
    try {
      await installObserverSchema(store)
      const first = await pollRegistryOnce(store, config('observer_registry_poll'), 'first',
        { maxEntryPages: 4, maxCheckpoints: 1, maxMs: 20_000 })
      expect(first).toMatchObject({ status: 'pending' })
      expect((await inspector.query('SELECT accepted_size, staged_next_index FROM observer_registry_poll.observer_registry_cursor')).rows)
        .toEqual([{ accepted_size: '0', staged_next_index: '3' }])
      const second = await pollRegistryOnce(store, config('observer_registry_poll'), 'second',
        { maxEntryPages: 4, maxCheckpoints: 4, maxMs: 20_000 })
      expect(second).toEqual({ status: 'accepted', snapshot: vector.snapshotTwo })
      expect(await pollRegistryOnce(store, config('observer_registry_poll'), 'third',
        { maxEntryPages: 4, maxCheckpoints: 4, maxMs: 20_000 })).toEqual({ status: 'up_to_date' })
    } finally { await store.close() }
  })

  it('retains a source gap finding without advancing accepted coverage', async () => {
    source(true, vector.headOne)
    const store = openObserverStore(databaseUrl, 'observer_registry_poll_gap')
    try {
      await installObserverSchema(store)
      expect(await pollRegistryOnce(store, config('observer_registry_poll_gap'), 'gap',
        { maxEntryPages: 4, maxCheckpoints: 4, maxMs: 20_000 }))
        .toMatchObject({ status: 'source_nonconforming' })
      expect((await inspector.query('SELECT accepted_size FROM observer_registry_poll_gap.observer_registry_cursor')).rows)
        .toEqual([{ accepted_size: '0' }])
      expect((await inspector.query('SELECT finding_type FROM observer_registry_poll_gap.observer_registry_findings')).rows)
        .toEqual([{ finding_type: 'source_nonconformance' }])
      source()
      expect(await pollRegistryOnce(store, config('observer_registry_poll_gap'), 'recovered',
        { maxEntryPages: 4, maxCheckpoints: 4, maxMs: 20_000 }))
        .toEqual({ status: 'accepted', snapshot: vector.snapshotTwo })
      expect((await inspector.query(
        'SELECT resolved_at IS NOT NULL AS resolved FROM observer_registry_poll_gap.observer_registry_findings')).rows)
        .toEqual([{ resolved: true }])
    } finally { await store.close() }
  })
})
