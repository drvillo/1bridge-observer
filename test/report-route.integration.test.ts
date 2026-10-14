import { afterAll, describe, expect, it, vi } from 'vitest'
import pg from 'pg'
import * as authority from '@drvillo/1bridge-authority'
import { installObserverSchema, openObserverStore, publishObserverCoverage } from '../src/lib/store'
import { pollObserverOnce } from '../src/lib/poll'
import { buildGovernanceSource, startGovernanceSource } from './governance-source-fixture'

const databaseUrl = process.env.OBSERVER_TEST_DATABASE_URL
if (!databaseUrl) throw new Error('OBSERVER_TEST_DATABASE_URL must identify a disposable database')

describe('read-only signed report route', () => {
  const inspector = new pg.Pool({ connectionString: databaseUrl, max: 1 })
  afterAll(async () => { vi.unstubAllEnvs(); await inspector.end() })

  it('requires its own read token and returns the latest report under the configured public key', async () => {
    const routePath = '../src/app/api/reports/latest/route'
    const route = await import(/* @vite-ignore */ routePath).catch(() => null)
    const pollRoute = await import('../src/app/api/poll/route')
    expect(typeof route?.GET).toBe('function')
    const history = await buildGovernanceSource()
    const source = await startGovernanceSource(history)
    const signer = await authority.generateSigningKey()
    const readToken = 'customer-controlled-report-read-token-123'
    const cronSecret = 'customer-controlled-cron-secret-456'
    const feedId = history.signedAnchor.anchor.feedId
    const store = openObserverStore(databaseUrl, 'observer_report_route')
    try {
      vi.stubEnv('SOURCE_BASE_URL', source.baseUrl)
      vi.stubEnv('FEED_ID', feedId)
      vi.stubEnv('ANCHOR_PIN', history.anchorPin)
      vi.stubEnv('SIGNED_ANCHOR', authority.encodeBase64Url(authority.canonicalBytes(history.signedAnchor)))
      vi.stubEnv('DATABASE_URL', databaseUrl)
      vi.stubEnv('OBSERVER_SCHEMA', 'observer_report_route')
      vi.stubEnv('CRON_SECRET', cronSecret)
      vi.stubEnv('REPORT_READ_TOKEN', readToken)
      vi.stubEnv('OBSERVER_SIGNING_PUBLIC_KEY', await authority.exportSigningPublicKey(signer.publicKey))
      const url = 'http://localhost/api/reports/latest'
      expect((await route!.GET(new Request(url, { headers: { authorization: `Bearer ${cronSecret}` } }))).status).toBe(401)
      vi.stubEnv('REPORT_READ_TOKEN', cronSecret)
      expect((await route!.GET(new Request(url, { headers: { authorization: `Bearer ${cronSecret}` } }))).status).toBe(503)
      expect((await pollRoute.GET(new Request('http://localhost/api/poll',
        { headers: { authorization: `Bearer ${cronSecret}` } }))).status).toBe(503)
      vi.stubEnv('REPORT_READ_TOKEN', readToken)
      expect((await inspector.query("SELECT to_regclass('observer_report_route.observer_feeds') AS table_name")).rows[0].table_name)
        .toBeNull()
      await installObserverSchema(store)
      expect((await route!.GET(new Request(url, { headers: { authorization: `Bearer ${readToken}` } }))).status).toBe(404)
      const config = { sourceBaseUrl: source.baseUrl, feedId, anchorPin: history.anchorPin,
        signedAnchor: authority.encodeBase64Url(authority.canonicalBytes(history.signedAnchor)),
        databaseUrl, databaseSchema: 'observer_report_route', cronSecret }
      expect((await pollObserverOnce(store, config, 'report-route-worker',
        { maxLeafPages: 16, maxCheckpoints: 16, maxMs: 20_000 })).status).toBe('accepted')
      const signed = await publishObserverCoverage(store, feedId, signer)
      const response = await route!.GET(new Request(url,
        { headers: { authorization: `Bearer ${readToken}` } }))
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toEqual({ version: 1, signedReport: signed })
      vi.stubEnv('ANCHOR_PIN', 'a'.repeat(64))
      expect((await route!.GET(new Request(url,
        { headers: { authorization: `Bearer ${readToken}` } }))).status).toBe(500)
      vi.stubEnv('ANCHOR_PIN', history.anchorPin)
      vi.stubEnv('SOURCE_BASE_URL', '')
      vi.stubEnv('SIGNED_ANCHOR', '')
      vi.stubEnv('CRON_SECRET', '')
      const withoutPollConfig = await route!.GET(new Request(url,
        { headers: { authorization: `Bearer ${readToken}` } }))
      expect(withoutPollConfig.status).toBe(200)
      expect(await withoutPollConfig.json()).toEqual({ version: 1, signedReport: signed })
    } finally { await store.close(); await source.close() }
  })
})
