import { afterAll, describe, expect, it, vi } from 'vitest'
import pg from 'pg'
import * as authority from '@drvillo/1bridge-authority'
import { GET } from '../src/app/api/poll/route'
import { buildGovernanceSource, startGovernanceSource } from './governance-source-fixture'

const databaseUrl = process.env.OBSERVER_TEST_DATABASE_URL
if (!databaseUrl) throw new Error('OBSERVER_TEST_DATABASE_URL must identify a disposable database')
const inspector = new pg.Pool({ connectionString: databaseUrl, max: 1 })

describe('protected observer poll route', () => {
  afterAll(async () => { vi.unstubAllEnvs(); await inspector.end() })

  it('rejects callers without the cron secret before database access, then advances the pinned feed', async () => {
    const history = await buildGovernanceSource()
    const source = await startGovernanceSource(history)
    const secret = 'a customer controlled observer cron secret'
    try {
      vi.stubEnv('SOURCE_BASE_URL', source.baseUrl)
      vi.stubEnv('FEED_ID', history.signedAnchor.anchor.feedId)
      vi.stubEnv('ANCHOR_PIN', history.anchorPin)
      vi.stubEnv('SIGNED_ANCHOR', authority.encodeBase64Url(authority.canonicalBytes(history.signedAnchor)))
      vi.stubEnv('DATABASE_URL', databaseUrl)
      vi.stubEnv('OBSERVER_SCHEMA', 'observer_route')
      vi.stubEnv('CRON_SECRET', secret)
      const denied = await GET(new Request('http://localhost/api/poll',
        { headers: { authorization: 'Bearer wrong' } }))
      expect(denied.status).toBe(401)
      expect((await inspector.query("SELECT to_regclass('observer_route.observer_feeds') AS table_name")).rows[0].table_name)
        .toBeNull()

      const authorized = new Request('http://localhost/api/poll',
        { headers: { authorization: `Bearer ${secret}` } })
      const first = await GET(authorized)
      expect(first.status).toBe(200)
      expect(await first.json()).toMatchObject({ status: 'accepted', snapshot: { size: history.leaves.length } })
      expect((await inspector.query('SELECT accepted_size FROM observer_route.observer_cursors')).rows[0].accepted_size)
        .toBe('7')
      const repeat = await GET(authorized)
      expect(repeat.status).toBe(200)
      expect(await repeat.json()).toMatchObject({ status: 'up_to_date' })
    } finally { await source.close() }
  })
})
