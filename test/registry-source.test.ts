import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { canonicalBytes, canonicalJson, encodeBase64Url } from '@drvillo/1bridge-authority'
import { discoverRegistryHead, fetchRegistryConsistency } from '../src/lib/registry-source'
const vector = JSON.parse(readFileSync(new URL('./shared-registry-v1.json', import.meta.url), 'utf8'))
const config = { sourceBaseUrl: 'https://source.example' }
afterEach(() => vi.unstubAllGlobals())
it('reads only global head and fixed-target consistency', async () => {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(input); calls.push(url.pathname)
    return new Response(canonicalJson(url.pathname.endsWith('/head')
      ? { version: 1, signedCheckpoint: encodeBase64Url(canonicalBytes(vector.headOne)), checkpointHash: vector.snapshotOne.checkpointHash }
      : { version: 1, old: url.searchParams.get('old'), target: url.searchParams.get('target'), proof: vector.proofOne }))
  }))
  expect((await discoverRegistryHead(config)).checkpointHash).toBe(vector.snapshotOne.checkpointHash)
  expect(await fetchRegistryConsistency(config, vector.headOne.statement.previous, vector.snapshotOne.checkpointHash)).toEqual(vector.proofOne)
  expect(calls).toEqual(['/api/governance/v1/registry/head', '/api/governance/v1/registry/consistency'])
})
it('rejects substituted head hash, wrong consistency echoes, unsafe origins and redirects', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(canonicalJson({ version: 1,
    signedCheckpoint: encodeBase64Url(canonicalBytes(vector.headOne)), checkpointHash: 'f'.repeat(64) }))))
  await expect(discoverRegistryHead(config)).rejects.toThrow()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(canonicalJson({ version: 1,
    old: 'f'.repeat(64), target: vector.snapshotOne.checkpointHash, proof: [] }))))
  await expect(fetchRegistryConsistency(config, vector.headOne.statement.previous, vector.snapshotOne.checkpointHash)).rejects.toThrow()
  await expect(discoverRegistryHead({ sourceBaseUrl: 'http://external.example' })).rejects.toThrow()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 302 })))
  await expect(discoverRegistryHead(config)).rejects.toThrow()
})
