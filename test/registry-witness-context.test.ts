import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { canonicalBytes, encodeBase64Url, exportSigningPrivateKey, exportSigningPublicKey, generateSigningKey } from '@drvillo/1bridge-authority'
import { loadRegistryWitnessContext } from '../src/lib/registry-witness-context'

const vector = JSON.parse(readFileSync(new URL('./shared-registry-v1.json', import.meta.url), 'utf8'))
it('loads the global poll signer and rejects mismatched signing keys', async () => {
  const key = await generateSigningKey()
  const other = await generateSigningKey()
  const env = { NODE_ENV: 'test' as const, SOURCE_BASE_URL: 'https://source.example', DATABASE_URL: 'postgres://user:pass@db.example/observer',
    CRON_SECRET: 'x'.repeat(32), REGISTRY_SOURCE_API_KEY: 'k'.repeat(32),
    REGISTRY_PUBLISHER_PUBLIC_KEY: vector.publisherPublicKey,
    REGISTRY_SIGNED_GENESIS: encodeBase64Url(canonicalBytes(vector.genesis)),
    OBSERVER_SIGNING_PRIVATE_KEY: await exportSigningPrivateKey(key.privateKey),
    OBSERVER_SIGNING_PUBLIC_KEY: await exportSigningPublicKey(key.publicKey) }
  expect((await loadRegistryWitnessContext(env)).config.sourceBaseUrl).toBe(env.SOURCE_BASE_URL)
  await expect(loadRegistryWitnessContext({ ...env,
    OBSERVER_SIGNING_PUBLIC_KEY: await exportSigningPublicKey(other.publicKey) })).rejects.toThrow('do not match')
})
