import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import pg from 'pg'
import { installObserverSchema, openObserverStore, type ObserverStore } from '../src/lib/store'
import { createDisposableDatabase } from './disposable-database'

const adminUrl = process.env.OBSERVER_TEST_DATABASE_URL
if (!adminUrl) throw new Error('Disposable database URL required')

describe('observer schema migrations', () => {
  let databaseUrl = ''
  let dropDatabase: () => Promise<void> = async () => undefined
  let store: ObserverStore
  let inspector: pg.Pool

  beforeAll(async () => {
    const database = await createDisposableDatabase(adminUrl)
    databaseUrl = database.databaseUrl
    dropDatabase = database.drop
    store = openObserverStore(databaseUrl)
    inspector = new pg.Pool({ connectionString: databaseUrl, max: 1 })
  })
  beforeEach(async () => {
    await inspector.query('DROP SCHEMA IF EXISTS observer CASCADE')
  })
  afterAll(async () => {
    await store.close()
    await inspector.end()
    await dropDatabase()
  })

  it('installs schema observer twice and leaves public untouched', async () => {
    await installObserverSchema(store)
    await installObserverSchema(store)
    const marker = await inspector.query('SELECT version, schema_digest, catalog_fingerprint FROM observer.observer_schema_versions')
    expect(marker.rows).toHaveLength(1)
    expect(marker.rows[0]).toMatchObject({ version: 5 })
    expect(marker.rows[0].schema_digest).toMatch(/^[0-9a-f]{64}$/)
    expect(marker.rows[0].catalog_fingerprint).toMatch(/^[0-9a-f]{32}$/)
    expect((await inspector.query("SELECT to_regclass('observer.observer_reports') IS NOT NULL AS installed")).rows[0].installed).toBe(true)
    expect((await inspector.query("SELECT to_regclass('observer.observer_known_receipts') IS NOT NULL AS installed")).rows[0].installed).toBe(true)
    expect((await inspector.query("SELECT to_regclass('observer.observer_registry_cursor') IS NOT NULL AS installed")).rows[0].installed).toBe(true)
    expect((await inspector.query("SELECT to_regclass('observer.observer_witness_cursor') IS NOT NULL AS installed")).rows[0].installed).toBe(true)
    const outside = await inspector.query("SELECT to_regclass('public.observer_feeds') IS NULL AS untouched")
    expect(outside.rows[0].untouched).toBe(true)
  })

  it('serializes two first-time installers', async () => {
    const first = openObserverStore(databaseUrl)
    const second = openObserverStore(databaseUrl)
    try {
      await Promise.all([installObserverSchema(first), installObserverSchema(second)])
      const result = await inspector.query('SELECT version FROM observer.observer_schema_versions')
      expect(result.rows).toEqual([{ version: 5 }])
    } finally { await Promise.all([first.close(), second.close()]) }
  })

  it('upgrades a populated v1 installation without changing its retained feed', async () => {
    const sql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')
    const digest = createHash('sha256').update(sql).digest('hex')
    const client = await inspector.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('search_path', 'public', true)")
      await client.query("SELECT set_config('observer.schema_digest', $1, true)", [digest])
      await client.query(sql)
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
    const feedId = 'a'.repeat(64)
    await inspector.query("INSERT INTO observer.observer_feeds(feed_id, anchor_pin, signed_anchor, source_base_url) VALUES($1,$2,$3,$4)",
      [feedId, 'b'.repeat(64), Buffer.from('anchor'), 'https://source.example'])
    await inspector.query('INSERT INTO observer.observer_cursors(feed_id) VALUES($1)', [feedId])
    const upgrade = openObserverStore(databaseUrl)
    try {
      await inspector.query('DROP INDEX observer.observer_findings_unresolved_idx')
      await expect(installObserverSchema(upgrade)).rejects.toThrow(/catalog/i)
      await inspector.query('CREATE INDEX observer_findings_unresolved_idx ON observer.observer_findings(feed_id, first_seen_at) WHERE resolved_at IS NULL')
      await installObserverSchema(upgrade)
      await installObserverSchema(upgrade)
      expect((await inspector.query('SELECT version FROM observer.observer_schema_versions')).rows).toEqual([{ version: 5 }])
      expect((await inspector.query('SELECT feed_id FROM observer.observer_feeds')).rows).toEqual([{ feed_id: feedId }])
      expect((await inspector.query("SELECT to_regclass('observer.observer_reports') IS NOT NULL AS installed")).rows[0].installed).toBe(true)
      expect((await inspector.query("SELECT to_regclass('public.observer_feeds') IS NULL AS untouched")).rows[0].untouched).toBe(true)
      await inspector.query('ALTER TABLE observer.observer_reports ADD COLUMN unreviewed_text text')
      await expect(installObserverSchema(upgrade)).rejects.toThrow(/catalog has changed/)
      await inspector.query('DROP TABLE observer.observer_reports')
      await expect(installObserverSchema(upgrade)).rejects.toThrow(/catalog has changed|incomplete/i)
    } finally { await upgrade.close() }
  })

  it('upgrades a populated v2 installation and detects changed receipt schema on repeat', async () => {
    const v1 = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')
    const v2 = readFileSync(new URL('../schema-v2.sql', import.meta.url), 'utf8')
    const v1Digest = createHash('sha256').update(v1).digest('hex')
    const v2Digest = createHash('sha256').update(v2).digest('hex')
    const client = await inspector.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('search_path', 'public', true)")
      await client.query("SELECT set_config('observer.schema_digest', $1, true)", [v1Digest])
      await client.query(v1)
      await client.query("SELECT set_config('observer.previous_schema_digest', $1, true)", [v1Digest])
      await client.query("SELECT set_config('observer.schema_digest', $1, true)", [v2Digest])
      await client.query(v2)
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
    const feedId = 'f'.repeat(64)
    await inspector.query("INSERT INTO observer.observer_feeds(feed_id, anchor_pin, signed_anchor, source_base_url) VALUES($1,$2,$3,$4)",
      [feedId, 'e'.repeat(64), Buffer.from('anchor'), 'https://source.example'])
    await inspector.query('INSERT INTO observer.observer_cursors(feed_id) VALUES($1)', [feedId])
    const upgrade = openObserverStore(databaseUrl)
    try {
      await installObserverSchema(upgrade)
      await installObserverSchema(upgrade)
      expect((await inspector.query('SELECT version FROM observer.observer_schema_versions')).rows)
        .toEqual([{ version: 5 }])
      expect((await inspector.query('SELECT feed_id FROM observer.observer_feeds')).rows)
        .toEqual([{ feed_id: feedId }])
      await inspector.query('DROP INDEX observer.observer_known_receipts_feed_index_idx')
      await inspector.query('CREATE INDEX observer_known_receipts_feed_index_idx ON observer.observer_known_receipts(feed_id)')
      await expect(installObserverSchema(upgrade)).rejects.toThrow(/catalog has changed/)
    } finally { await upgrade.close() }
  })

  it('upgrades an existing v4 shared registry without reinterpreting legacy rows', async () => {
    const scripts = ['schema.sql', 'schema-v2.sql', 'schema-v3.sql', 'schema-v4.sql']
      .map(name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'))
    const digests = scripts.map(sql => createHash('sha256').update(sql).digest('hex'))
    const client = await inspector.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('search_path', 'public', true)")
      for (let index = 0; index < scripts.length; index++) {
        if (index > 0) await client.query(
          "SELECT set_config('observer.previous_schema_digest', $1, true)", [digests[index - 1]])
        await client.query("SELECT set_config('observer.schema_digest', $1, true)", [digests[index]])
        await client.query(scripts[index]!)
      }
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
    await inspector.query(`INSERT INTO observer.observer_registry_findings
      (finding_type, evidence_bytes) VALUES('source_nonconformance', $1)`, [Buffer.from('legacy')])
    const upgrade = openObserverStore(databaseUrl)
    try {
      await installObserverSchema(upgrade)
      await installObserverSchema(upgrade)
      expect((await inspector.query('SELECT version FROM observer.observer_schema_versions')).rows)
        .toEqual([{ version: 5 }])
      expect((await inspector.query('SELECT count(*)::integer AS count FROM observer.observer_registry_findings')).rows[0].count)
        .toBe(1)
      expect((await inspector.query("SELECT to_regclass('observer.observer_witness_cursor') IS NOT NULL AS installed")).rows[0].installed)
        .toBe(true)
      expect((await inspector.query("SELECT to_regclass('public.observer_witness_cursor') IS NULL AS untouched")).rows[0].untouched)
        .toBe(true)
    } finally { await upgrade.close() }
  })
})
