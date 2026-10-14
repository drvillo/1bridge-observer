import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { encodeBase64Url, canonicalBytes } from '@drvillo/1bridge-authority'
import { loadSharedObserverConfig, verifyRegistryPin } from '../src/lib/config'

const vector = JSON.parse(readFileSync(new URL('./shared-registry-v1.json', import.meta.url), 'utf8'))
const valid = {
  NODE_ENV: 'production', SOURCE_BASE_URL: 'https://evidence.example/',
  DATABASE_URL: 'postgresql://observer:private@db.example/observer?sslmode=require',
  OBSERVER_SCHEMA: 'shared_observer', CRON_SECRET: 'a distinct observer cron secret of sufficient length',
  REGISTRY_PUBLISHER_PUBLIC_KEY: vector.publisherPublicKey,
  REGISTRY_SIGNED_GENESIS: encodeBase64Url(canonicalBytes(vector.genesis)),
}

describe('shared observer trust configuration', () => {
  it('loads a single public registry pin without per-customer feed settings', async () => {
    const config = loadSharedObserverConfig(valid)
    expect(config).toMatchObject({ sourceBaseUrl: 'https://evidence.example',
      databaseSchema: 'shared_observer', publisherPublicKeySpki: vector.publisherPublicKey })
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

  it('rejects unsafe origin, missing pin, weak cron secret and invalid schema', () => {
    for (const changed of [
      { SOURCE_BASE_URL: 'http://remote.example/' },
      { REGISTRY_PUBLISHER_PUBLIC_KEY: '' },
      { REGISTRY_SIGNED_GENESIS: '' },
      { CRON_SECRET: 'short' },
      { OBSERVER_SCHEMA: 'public;DROP' },
    ]) expect(() => loadSharedObserverConfig({ ...valid, ...changed })).toThrow()
  })
})
