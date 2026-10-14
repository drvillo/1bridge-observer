import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import pg, { type PoolClient } from 'pg'
import { decodeBase64Url } from '@drvillo/1bridge-authority'
import { verifyObserverAnchor, type ObserverConfig } from './config'

const HASH = /^[0-9a-f]{64}$/
const SCHEMA = /^[a-z_][a-z0-9_]{0,62}$/
const MAX_LEASE_MS = 300_000

export interface ObserverStore { close(): Promise<void> }
export interface ObserverLease {
  feedId: string
  workerId: string
  epoch: number
  version: number
  expiresAt: Date
}

interface StoreConnection { pool: pg.Pool; schema: string }
const connections = new WeakMap<ObserverStore, StoreConnection>()

function connectionFor(store: ObserverStore): StoreConnection {
  const connection = connections.get(store)
  if (!connection) throw new TypeError('Expected open observer store')
  return connection
}

async function transaction<T>(store: ObserverStore, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const { pool, schema } = connectionFor(store)
  const client = await pool.connect()
  let destroy = false
  try {
    await client.query('BEGIN')
    const namespace = await client.query<{ exists: boolean }>(
      'SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname = $1) AS exists', [schema])
    if (!namespace.rows[0]?.exists) throw new Error('Observer database schema does not exist')
    await client.query("SELECT set_config('search_path', $1, true)", [schema])
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { destroy = true }
    throw error
  } finally {
    client.release(destroy)
  }
}

function safeCount(value: unknown): number {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new TypeError('Invalid database counter')
  const number = Number(value)
  if (!Number.isSafeInteger(number)) throw new RangeError('Database counter exceeds safe integer range')
  return number
}

/** Opens one small, customer-owned Postgres pool under a pre-created schema. */
export function openObserverStore(connectionString: string, schema = 'public'): ObserverStore {
  if (typeof connectionString !== 'string' || !connectionString) throw new TypeError('Expected observer database URL')
  if (typeof schema !== 'string' || !SCHEMA.test(schema)) throw new TypeError('Expected simple observer schema name')
  const pool = new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 5_000 })
  pool.on('error', error => { console.error('Observer idle database connection failed:', error.message) })
  const store: ObserverStore = Object.freeze({ close: async () => { connections.delete(store); await pool.end() } })
  connections.set(store, { pool, schema })
  return store
}

/** Applies the reviewed SQL file atomically on one connection. */
export async function installObserverSchema(store: ObserverStore): Promise<void> {
  const sql = readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8')
  const digest = createHash('sha256').update(sql).digest('hex')
  await transaction(store, async client => {
    await client.query("SELECT set_config('observer.schema_digest', $1, true)", [digest])
    await client.query(sql)
  })
}

/** Registers exact independently pinned feed bytes without replacing an existing identity. */
export async function registerObserverFeed(store: ObserverStore, config: ObserverConfig): Promise<void> {
  const anchor = await verifyObserverAnchor(config)
  if (anchor.feedId !== config.feedId) throw new TypeError('Feed identity mismatch')
  const signedBytes = Buffer.from(decodeBase64Url(config.signedAnchor, 16_384))
  await transaction(store, async client => {
    const inserted = await client.query(
      'INSERT INTO observer_feeds(feed_id, anchor_pin, signed_anchor, source_base_url) VALUES($1,$2,$3,$4) ON CONFLICT (feed_id) DO NOTHING',
      [config.feedId, config.anchorPin, signedBytes, config.sourceBaseUrl])
    if (inserted.rowCount === 1) {
      await client.query('INSERT INTO observer_cursors(feed_id) VALUES($1)', [config.feedId])
      return
    }
    const existing = await client.query<{ anchor_pin: string; signed_anchor: Buffer; source_base_url: string }>(
      'SELECT anchor_pin, signed_anchor, source_base_url FROM observer_feeds WHERE feed_id=$1', [config.feedId])
    if (existing.rows.length !== 1 || existing.rows[0]?.anchor_pin !== config.anchorPin
      || existing.rows[0]?.source_base_url !== config.sourceBaseUrl
      || !existing.rows[0].signed_anchor.equals(signedBytes)) throw new TypeError('Observer feed registration conflicts with retained identity')
    const cursor = await client.query('SELECT 1 FROM observer_cursors WHERE feed_id=$1', [config.feedId])
    if (cursor.rows.length !== 1) throw new TypeError('Observer feed cursor is missing')
  })
}

/** Claims a bounded DB-time lease; every successful claim advances the fencing epoch. */
export async function claimObserverLease(store: ObserverStore, feedId: string, workerId: string,
  durationMs: number): Promise<ObserverLease | null> {
  if (typeof feedId !== 'string' || !HASH.test(feedId)) throw new TypeError('Invalid observer feed ID')
  if (typeof workerId !== 'string' || workerId.length < 1 || workerId.length > 256) throw new TypeError('Invalid observer worker ID')
  if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > MAX_LEASE_MS) throw new TypeError('Invalid observer lease duration')
  const result = await transaction(store, client => client.query<{ version: string; lease_epoch: string; lease_until: Date }>(
    `UPDATE observer_cursors
       SET lease_owner=$2, lease_until=clock_timestamp() + ($3::integer * interval '1 millisecond'),
           lease_epoch=lease_epoch+1
     WHERE feed_id=$1 AND (lease_until IS NULL OR lease_until <= clock_timestamp() OR lease_owner=$2)
       AND lease_epoch < 9007199254740991
     RETURNING version, lease_epoch, lease_until`, [feedId, workerId, durationMs]))
  if (result.rows.length === 0) return null
  const row = result.rows[0]!
  if (!(row.lease_until instanceof Date) || !Number.isFinite(row.lease_until.getTime())) throw new TypeError('Invalid database lease time')
  return { feedId, workerId, epoch: safeCount(row.lease_epoch), version: safeCount(row.version),
    expiresAt: new Date(row.lease_until) }
}
