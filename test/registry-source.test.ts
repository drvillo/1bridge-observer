import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canonicalBytes, decodeBase64Url, encodeBase64Url, registryCheckpointHash } from '@drvillo/1bridge-authority'
import { discoverRegistryHead, fetchRegistryCheckpointPage, fetchRegistryEntryPage,
  fetchRegistryConsistency } from '../src/lib/registry-source'

const vector = JSON.parse(readFileSync(new URL('./shared-registry-v1.json', import.meta.url), 'utf8'))
const config = { sourceBaseUrl: 'https://source.example' }
const encoded = (value: unknown) => encodeBase64Url(canonicalBytes(value))
const body = (value: unknown) => canonicalBytes(value)

afterEach(() => vi.unstubAllGlobals())

function respond(handler: (url: URL) => unknown) {
  const calls: URL[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(input)
    calls.push(url)
    return new Response(new TextDecoder().decode(body(handler(url))), { status: 200 })
  }))
  return calls
}

describe('fixed-target shared registry source', () => {
  it('discovers a provisional head and fetches a complete missed checkpoint chain', async () => {
    const calls = respond(url => {
      if (url.pathname.endsWith('/head')) return { version: 1,
        signedCheckpoint: encoded(vector.headTwo), checkpointHash: vector.snapshotTwo.checkpointHash }
      return { version: 1, target: vector.snapshotTwo.checkpointHash,
        after: url.searchParams.get('after'), items: [encoded(vector.headOne), encoded(vector.headTwo)] }
    })
    const head = await discoverRegistryHead(config)
    expect(head.checkpointHash).toBe(await registryCheckpointHash(vector.headTwo.statement))
    const page = await fetchRegistryCheckpointPage(config, head.checkpointHash,
      await registryCheckpointHash(vector.genesis.statement), 2)
    expect(page.items.map(item => item.hash)).toEqual([
      vector.snapshotOne.checkpointHash, vector.snapshotTwo.checkpointHash])
    expect(calls.map(url => url.pathname)).toEqual([
      '/api/governance/v1/registry/head', '/api/governance/v1/registry/checkpoints'])
  })

  it('fetches contiguous canonical entry pages and an exact consistency proof', async () => {
    respond(url => url.pathname.endsWith('/entries')
      ? { version: 1, target: vector.snapshotOne.checkpointHash, start: 0,
        items: vector.entries.slice(0, 3) }
      : { version: 1, old: vector.headOne.statement.previous, target: vector.snapshotOne.checkpointHash,
        proof: vector.proofOne })
    const entries = await fetchRegistryEntryPage(config, vector.snapshotOne.checkpointHash, 0, 3, 3)
    expect(entries.items).toEqual(vector.entries.slice(0, 3).map((item: string) => decodeBase64Url(item)))
    const proof = await fetchRegistryConsistency(config, vector.headOne.statement.previous, vector.snapshotOne.checkpointHash)
    expect(proof).toEqual(vector.proofOne)
  })

  it('rejects skipped checkpoints, malformed pages and a substituted head hash', async () => {
    respond(url => url.pathname.endsWith('/head')
      ? { version: 1, signedCheckpoint: encoded(vector.headOne), checkpointHash: 'f'.repeat(64) }
      : { version: 1, target: vector.snapshotTwo.checkpointHash,
        after: url.searchParams.get('after'), items: [encoded(vector.headTwo)] })
    await expect(discoverRegistryHead(config)).rejects.toThrow()
    await expect(fetchRegistryCheckpointPage(config, vector.snapshotTwo.checkpointHash,
      vector.snapshotOne.checkpointHash, 1)).resolves.toBeDefined()
    await expect(fetchRegistryCheckpointPage(config, vector.snapshotTwo.checkpointHash,
      vector.headOne.statement.previous, 1)).rejects.toThrow()
  })

  it('rejects empty nonterminal pages, wrong echoes, unsafe origins and redirects', async () => {
    respond(() => ({ version: 1, target: vector.snapshotOne.checkpointHash,
      start: 0, items: [] }))
    await expect(fetchRegistryEntryPage(config, vector.snapshotOne.checkpointHash, 0, 3, 3)).rejects.toThrow()
    await expect(fetchRegistryEntryPage({ sourceBaseUrl: 'http://external.example' },
      vector.snapshotOne.checkpointHash, 0, 3, 3)).rejects.toThrow()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null,
      { status: 302, headers: { location: 'https://evil.example' } })))
    await expect(discoverRegistryHead(config)).rejects.toThrow()
  })
})
