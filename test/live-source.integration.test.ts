import pg from 'pg'
import { expect, it } from 'vitest'
import * as authority from '@drvillo/1bridge-authority'
import { loadSharedObserverConfig, verifyRegistryPin } from '../src/lib/config'
import { pollRegistryWitnessOnce } from '../src/lib/registry-witness-poll'
import { installObserverSchema, openObserverStore } from '../src/lib/store'
import { createDisposableDatabase } from './disposable-database'

const env = process.env
const expectedSize = Number(env.OBSERVER_LIVE_EXPECTED_REGISTRY_SIZE)
const enabled = Boolean(env.OBSERVER_TEST_DATABASE_URL && env.OBSERVER_LIVE_SOURCE_BASE_URL
  && env.OBSERVER_LIVE_REGISTRY_PUBLIC_KEY && env.OBSERVER_LIVE_REGISTRY_GENESIS
  && /^[0-9a-f]{64}$/.test(env.OBSERVER_LIVE_REGISTRY_TARGET ?? '')
  && Number.isSafeInteger(expectedSize) && expectedSize >= 4)

/** Opt-in contract for an app-owned HTTP registry source and separate disposable observer Postgres. */
it.skipIf(!enabled)('witnesses the exact two-feed registry backlog without customer configuration', async () => {
  const adminUrl = env.OBSERVER_TEST_DATABASE_URL
  if (!adminUrl) throw new Error('Disposable database URL required')
  const database = await createDisposableDatabase(adminUrl)
  const inspector = new pg.Pool({ connectionString: database.databaseUrl, max: 1 })
  try {
    const config = loadSharedObserverConfig({ NODE_ENV: 'test',
      SOURCE_BASE_URL: env.OBSERVER_LIVE_SOURCE_BASE_URL, DATABASE_URL: database.databaseUrl,
      CRON_SECRET: 'x'.repeat(32),
      REGISTRY_SOURCE_API_KEY: env.REGISTRY_SOURCE_API_KEY,
      REGISTRY_PUBLISHER_PUBLIC_KEY: env.OBSERVER_LIVE_REGISTRY_PUBLIC_KEY,
      REGISTRY_SIGNED_GENESIS: env.OBSERVER_LIVE_REGISTRY_GENESIS })
    const store = openObserverStore(config.databaseUrl)
    try {
      await installObserverSchema(store)
      const signer = await authority.generateSigningKey()
      const result = await pollRegistryWitnessOnce(store, config, signer)
      expect(result.status).toBe('accepted')
      expect(result.report?.statement.registryCheckpointHash).toBe(env.OBSERVER_LIVE_REGISTRY_TARGET)
      expect(result.report?.statement.registryCheckpoint.statement.size).toBe(expectedSize)
      const cursor = await inspector.query<{ accepted_size: string; accepted_hash: string }>(
        'SELECT accepted_size, accepted_hash FROM observer.observer_witness_cursor')
      expect(cursor.rows).toEqual([{ accepted_size: String(expectedSize),
        accepted_hash: env.OBSERVER_LIVE_REGISTRY_TARGET }])
      const { publisherKey, signedGenesis } = await verifyRegistryPin(config)
      expect(await authority.verifyRegistryWitness(result.report!, signedGenesis, [],
        signer.publicKey, publisherKey)).toBe(true)
    } finally { await store.close() }
  } finally {
    await inspector.end()
    await database.drop()
  }
})
