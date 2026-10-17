import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import pg, { type PoolClient } from 'pg'

const SCHEMA = /^[a-z_][a-z0-9_]{0,62}$/
export interface ObserverStore { close(): Promise<void> }

interface StoreConnection { pool: pg.Pool; schema: string }
const STORE_CONNECTIONS_KEY = Symbol.for('1bridge-observer.store-connections')
const RUNTIME_STORE_KEY = Symbol.for('1bridge-observer.runtime-store')

interface RuntimeObserverStoreState {
  connectionString: string
  schema: string
  store: ObserverStore
}

interface ObserverStoreGlobal {
  [STORE_CONNECTIONS_KEY]?: WeakMap<ObserverStore, StoreConnection>
  [RUNTIME_STORE_KEY]?: RuntimeObserverStoreState
}

function observerStoreGlobal(): typeof globalThis & ObserverStoreGlobal {
  return globalThis as typeof globalThis & ObserverStoreGlobal
}

const storeGlobal = observerStoreGlobal()
const connections = storeGlobal[STORE_CONNECTIONS_KEY] ?? new WeakMap<ObserverStore, StoreConnection>()
storeGlobal[STORE_CONNECTIONS_KEY] = connections

function connectionFor(store: ObserverStore): StoreConnection {
  const connection = connections.get(store)
  if (!connection) throw new TypeError('Expected open observer store')
  return connection
}

export async function transaction<T>(store: ObserverStore, work: (client: PoolClient) => Promise<T>): Promise<T> {
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

/** Opens one small, observer-operator-owned Postgres pool under a pre-created schema. */
export function openObserverStore(connectionString: string, schema = 'public'): ObserverStore {
  if (typeof connectionString !== 'string' || !connectionString) throw new TypeError('Expected observer database URL')
  if (typeof schema !== 'string' || !SCHEMA.test(schema)) throw new TypeError('Expected simple observer schema name')
  const pool = new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 5_000 })
  pool.on('error', error => { console.error('Observer idle database connection failed:', error.message) })
  const store: ObserverStore = Object.freeze({ close: async () => { connections.delete(store); await pool.end() } })
  connections.set(store, { pool, schema })
  return store
}

export function getRuntimeObserverStore(connectionString: string, schema = 'public'): ObserverStore {
  const runtime = observerStoreGlobal()
  const current = runtime[RUNTIME_STORE_KEY]
  if (current) {
    if (current.connectionString !== connectionString || current.schema !== schema) {
      throw new TypeError('Observer runtime store configuration changed')
    }
    return current.store
  }

  const store = openObserverStore(connectionString, schema)
  runtime[RUNTIME_STORE_KEY] = { connectionString, schema, store }
  return store
}

export async function closeRuntimeObserverStore(): Promise<void> {
  const runtime = observerStoreGlobal()
  const current = runtime[RUNTIME_STORE_KEY]
  if (!current) return
  delete runtime[RUNTIME_STORE_KEY]
  await current.store.close()
}

/** Installs or upgrades the reviewed observer schema atomically on one connection. */
export async function installObserverSchema(store: ObserverStore): Promise<void> {
  const v1 = readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8')
  const v2 = readFileSync(new URL('../../schema-v2.sql', import.meta.url), 'utf8')
  const v3 = readFileSync(new URL('../../schema-v3.sql', import.meta.url), 'utf8')
  const v4 = readFileSync(new URL('../../schema-v4.sql', import.meta.url), 'utf8')
  const v5 = readFileSync(new URL('../../schema-v5.sql', import.meta.url), 'utf8')
  const fingerprintSql = readFileSync(new URL('../../schema-fingerprint.sql', import.meta.url), 'utf8')
  const v1Digest = createHash('sha256').update(v1).digest('hex')
  const v2Digest = createHash('sha256').update(v2).digest('hex')
  const v3Digest = createHash('sha256').update(v3).digest('hex')
  const v4Digest = createHash('sha256').update(v4).digest('hex')
  const v5Digest = createHash('sha256').update(v5).digest('hex')
  await transaction(store, async client => {
    await client.query('SELECT pg_advisory_xact_lock(6704462056185601401)')
    const marker = await client.query<{ exists: boolean }>(
      "SELECT to_regclass(format('%I.observer_schema_versions', current_schema())) IS NOT NULL AS exists")
    let version: number | null = null
    if (marker.rows[0]?.exists) {
      const current = await client.query<{ version: number; catalog_fingerprint: string }>(
        'SELECT version, catalog_fingerprint FROM observer_schema_versions')
      if (current.rows.length !== 1) throw new TypeError('Invalid observer schema marker')
      version = current.rows[0]!.version
      if (version !== 1 && version !== 2 && version !== 3 && version !== 4 && version !== 5) throw new TypeError('Unsupported observer schema marker')
      const actual = await client.query<{ catalog_fingerprint: string }>(fingerprintSql)
      if (actual.rows.length !== 1
        || actual.rows[0]!.catalog_fingerprint !== current.rows[0]!.catalog_fingerprint) {
        throw new TypeError('Observer schema catalog has changed')
      }
    }
    if (version === null || version === 1) {
      await client.query("SELECT set_config('observer.schema_digest', $1, true)", [v1Digest])
      await client.query(v1)
    }
    if (version === null || version <= 2) {
      await client.query("SELECT set_config('observer.previous_schema_digest', $1, true)", [v1Digest])
      await client.query("SELECT set_config('observer.schema_digest', $1, true)", [v2Digest])
      await client.query(v2)
    }
    if (version === null || version <= 3) {
      await client.query("SELECT set_config('observer.previous_schema_digest', $1, true)", [v2Digest])
      await client.query("SELECT set_config('observer.schema_digest', $1, true)", [v3Digest])
      await client.query(v3)
    }
    if (version === null || version <= 4) {
      await client.query("SELECT set_config('observer.previous_schema_digest', $1, true)", [v3Digest])
      await client.query("SELECT set_config('observer.schema_digest', $1, true)", [v4Digest])
      await client.query(v4)
      await client.query("SELECT set_config('observer.schema_digest', $1, true)", [v5Digest])
      await client.query(v5)
      const fingerprint = await client.query<{ catalog_fingerprint: string }>(fingerprintSql)
      await client.query('UPDATE observer_schema_versions SET catalog_fingerprint=$1',
        [fingerprint.rows[0]!.catalog_fingerprint])
    }
  })
}
