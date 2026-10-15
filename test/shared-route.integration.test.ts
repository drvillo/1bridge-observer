import { readFileSync } from 'node:fs'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import pg from 'pg'
import * as authority from '@drvillo/1bridge-authority'
import { GET as poll } from '../src/app/api/shared-poll/route'
import { GET as latest } from '../src/app/api/shared-reports/latest/route'
import { GET as status } from '../src/app/api/shared-reports/status/route'

const databaseUrl = process.env.OBSERVER_TEST_DATABASE_URL
if (!databaseUrl) throw new Error('OBSERVER_TEST_DATABASE_URL must identify a disposable database')
const vector = JSON.parse(readFileSync(new URL('./shared-registry-v1.json', import.meta.url), 'utf8'))
const inspector = new pg.Pool({ connectionString: databaseUrl, max: 1 })
const encoded = (value: unknown) => authority.encodeBase64Url(authority.canonicalBytes(value))
const entry = authority.parseCanonical(authority.decodeBase64Url(vector.entries[1])) as unknown as authority.RegistryEntry
if (entry.kind !== 'feed_head') throw new TypeError('Shared fixture lacks first feed head')
const feedHead = entry

function source() {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(input)
    const target = vector.snapshotTwo.checkpointHash
    let envelope: unknown
    if (url.pathname === '/api/governance/v1/registry/head') {
      envelope = { version: 1, checkpointHash: target, signedCheckpoint: encoded(vector.headTwo) }
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
    } else if (url.pathname === `/api/governance/v1/feeds/${vector.feedIds[0]}/checkpoints`) {
      envelope = { version: 1, target: url.searchParams.get('target'),
        after: url.searchParams.get('after'), items: [encoded(feedHead.signedCheckpoint)] }
    } else if (url.pathname === `/api/governance/v1/feeds/${vector.feedIds[1]}/checkpoints`) {
      return new Response(null, { status: 503 })
    } else if (url.pathname === `/api/governance/v1/feeds/${vector.feedIds[0]}/leaves`) {
      envelope = { version: 1, target: url.searchParams.get('target'),
        start: Number(url.searchParams.get('start')), items: [] }
    } else throw new TypeError('Unknown test source route')
    return new Response(authority.canonicalJson(envelope), { status: 200 })
  }))
}

describe('shared observer Vercel routes', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })
  afterAll(async () => { await inspector.end() })

  it('protects polling and publicly serves signed aggregate and scoped status proof', async () => {
    source()
    const observer = await authority.generateSigningKey()
    const secret = 'a private observer cron secret of sufficient length'
    vi.stubEnv('SOURCE_BASE_URL', 'https://source.example/')
    vi.stubEnv('DATABASE_URL', databaseUrl)
    vi.stubEnv('OBSERVER_SCHEMA', 'observer_shared_route')
    vi.stubEnv('CRON_SECRET', secret)
    vi.stubEnv('REGISTRY_PUBLISHER_PUBLIC_KEY', vector.publisherPublicKey)
    vi.stubEnv('REGISTRY_SIGNED_GENESIS', encoded(vector.genesis))
    vi.stubEnv('OBSERVER_SIGNING_PRIVATE_KEY', await authority.exportSigningPrivateKey(observer.privateKey))
    vi.stubEnv('OBSERVER_SIGNING_PUBLIC_KEY', await authority.exportSigningPublicKey(observer.publicKey))
    expect((await poll(new Request('https://observer.example/api/shared-poll'))).status).toBe(401)
    expect((await inspector.query("SELECT to_regclass('observer_shared_route.observer_registry_cursor') AS installed")).rows[0].installed)
      .toBeNull()
    const run = await poll(new Request('https://observer.example/api/shared-poll',
      { headers: { authorization: `Bearer ${secret}` } }))
    expect(run.status).toBe(200)
    const result = await run.json()
    expect(result.report.statement).toMatchObject({ coverageScope: 'shared_registry',
      verifiedFeeds: { count: 1 }, pendingFeeds: { count: 1 } })
    const publicReport = await latest()
    expect(publicReport.status).toBe(200)
    expect(publicReport.headers.get('access-control-allow-origin')).toBe('*')
    const response = await publicReport.json()
    expect(response.signedReport).toEqual(result.report)
    const proofResponse = await status(new Request(`https://observer.example/api/shared-reports/status?reportHash=${response.reportHash}&feedId=${vector.feedIds[1]}`))
    expect(proofResponse.status).toBe(200)
    expect(proofResponse.headers.get('access-control-allow-origin')).toBe('*')
    const proof = (await proofResponse.json()).proof
    const publisher = await authority.importSigningPublicKey(vector.publisherPublicKey)
    expect(await authority.verifyAggregateFeedStatus(response.signedReport, proof,
      observer.publicKey, publisher, vector.snapshotTwo.checkpointHash,
      vector.feedIds[1], vector.snapshotTwo.feeds[1].anchorPin)).toBe(true)
  })
})
