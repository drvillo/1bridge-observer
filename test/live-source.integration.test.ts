import { expect, it } from 'vitest'
import * as authority from '@drvillo/1bridge-authority'
import { loadSharedObserverConfig } from '../src/lib/config'
import { pollRegistryWitnessOnce } from '../src/lib/registry-witness-poll'
import { installObserverSchema, openObserverStore } from '../src/lib/store'
const env = process.env
const enabled = Boolean(env.OBSERVER_TEST_DATABASE_URL && env.OBSERVER_LIVE_SOURCE_BASE_URL
  && env.OBSERVER_LIVE_REGISTRY_PUBLIC_KEY && env.OBSERVER_LIVE_REGISTRY_GENESIS)
it.skipIf(!enabled)('witnesses a live 1Bridge global registry without customer configuration', async () => {
  const config = loadSharedObserverConfig({ NODE_ENV: 'test',
    SOURCE_BASE_URL: env.OBSERVER_LIVE_SOURCE_BASE_URL, DATABASE_URL: env.OBSERVER_TEST_DATABASE_URL,
    OBSERVER_SCHEMA: 'observer_live_source', CRON_SECRET: 'x'.repeat(32),
    REGISTRY_PUBLISHER_PUBLIC_KEY: env.OBSERVER_LIVE_REGISTRY_PUBLIC_KEY,
    REGISTRY_SIGNED_GENESIS: env.OBSERVER_LIVE_REGISTRY_GENESIS })
  const store = openObserverStore(config.databaseUrl, config.databaseSchema)
  try {
    await installObserverSchema(store)
    const result = await pollRegistryWitnessOnce(store, config, await authority.generateSigningKey())
    expect(['accepted', 'up_to_date']).toContain(result.status)
    expect(result.report).not.toBeNull()
  } finally { await store.close() }
})
