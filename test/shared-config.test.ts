import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { encodeBase64Url, canonicalBytes } from '@drvillo/1bridge-authority'
import { loadSharedObserverConfig, verifyRegistryPin } from '../src/lib/config'

const vector = JSON.parse(readFileSync(new URL('./shared-registry-v1.json', import.meta.url), 'utf8'))
const valid = {
  NODE_ENV: 'production', SOURCE_BASE_URL: 'https://evidence.example/',
  DATABASE_URL: 'postgresql://observer:private@db.example/observer?sslmode=require',
  CRON_SECRET: 'a distinct observer cron secret of sufficient length',
  REGISTRY_SOURCE_API_KEY: 'a distinct registry source credential with enough bytes',
  REGISTRY_PUBLISHER_PUBLIC_KEY: vector.publisherPublicKey,
  REGISTRY_SIGNED_GENESIS: encodeBase64Url(canonicalBytes(vector.genesis)),
}

describe('shared observer trust configuration', () => {
  it('loads a single public registry pin without per-customer feed settings', async () => {
    const config = loadSharedObserverConfig(valid)
    expect(config).toMatchObject({ sourceBaseUrl: 'https://evidence.example',
      registrySourceApiKey: valid.REGISTRY_SOURCE_API_KEY,
      databaseUrl: valid.DATABASE_URL, publisherPublicKeySpki: vector.publisherPublicKey })
    expect('databaseSchema' in config).toBe(false)
    expect('feedId' in config).toBe(false)
    const pin = await verifyRegistryPin(config)
    expect(pin.signedGenesis).toEqual(vector.genesis)
    expect(pin.genesisHash).toBe(vector.headOne.statement.previous)
  })

  it('rejects a substituted publisher key or non-genesis trust checkpoint', async () => {
    const key = vector.observerPublicKey
    await expect(verifyRegistryPin(loadSharedObserverConfig({ ...valid,
      REGISTRY_PUBLISHER_PUBLIC_KEY: key }))).rejects.toThrow()
    await expect(verifyRegistryPin(loadSharedObserverConfig({ ...valid,
      REGISTRY_SIGNED_GENESIS: encodeBase64Url(canonicalBytes(vector.headOne)) }))).rejects.toThrow()
  })

  it('rejects unsafe origin, missing pin and weak cron secret', () => {
    for (const changed of [
      { SOURCE_BASE_URL: 'http://remote.example/' },
      { REGISTRY_PUBLISHER_PUBLIC_KEY: '' },
      { REGISTRY_SIGNED_GENESIS: '' },
      { CRON_SECRET: 'short' },
      { REGISTRY_SOURCE_API_KEY: '' },
      { REGISTRY_SOURCE_API_KEY: 'short' },
    ]) expect(() => loadSharedObserverConfig({ ...valid, ...changed })).toThrow()
  })

  it('ignores OBSERVER_SCHEMA because the schema name is fixed in the migrations', () => {
    const config = loadSharedObserverConfig({ ...valid, OBSERVER_SCHEMA: 'public' })
    expect(config).toEqual(loadSharedObserverConfig(valid))
    expect(config).not.toHaveProperty('databaseSchema')
  })

  it('permits HTTP loopback only in local development or tests', () => {
    for (const environment of ['development', 'test']) {
      expect(loadSharedObserverConfig({ ...valid, NODE_ENV: environment,
        SOURCE_BASE_URL: 'http://localhost:3000' }).sourceBaseUrl).toBe('http://localhost:3000')
      expect(() => loadSharedObserverConfig({ ...valid, NODE_ENV: environment,
        SOURCE_BASE_URL: 'http://remote.example' })).toThrow()
    }
    expect(() => loadSharedObserverConfig({ ...valid,
      SOURCE_BASE_URL: 'http://localhost:3000' })).toThrow()
  })
})
