import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gzipSync } from 'node:zlib'
import { canonicalBytes, checkpointHash, encodeBase64Url, generateSigningKey, signCheckpoint, signingKeyId } from '@drvillo/1bridge-authority'
import {
  discoverFeedHead, fetchCheckpointPage, fetchLeafPage,
  SourceHttpError, SourceProtocolError, SourceTransportError,
} from '../src/lib/source'
import type { ObserverConfig } from '../src/lib/config'
import { startSourceFixture, type SourceFixture } from './source-fixture'

let fixture: SourceFixture
let config: ObserverConfig

beforeEach(async () => {
  fixture = await startSourceFixture()
  config = {
    sourceBaseUrl: fixture.baseUrl, feedId: fixture.feedId,
    anchorPin: fixture.anchorPin, signedAnchor: fixture.signedAnchor,
    databaseUrl: 'postgres://db.example/observer', cronSecret: 'x'.repeat(32),
  }
})
afterEach(async () => { vi.unstubAllGlobals(); await fixture.close() })

function body(value: unknown): Uint8Array { return canonicalBytes(value) }
function alteredBody(value: unknown) { fixture.override = () => ({ bytes: body(value) }) }

describe('fixed-target source pull', () => {
  it('discovers an independently pinned anchor and provisional signed target over HTTP', async () => {
    const found = await discoverFeedHead(config)
    expect(found.provisional).toBe(true)
    expect(found.checkpointHash).toBe(await checkpointHash(fixture.signedCheckpoints[2]!.statement))
    expect(found.signedCheckpoint).toEqual(fixture.signedCheckpoints[2])
    expect(found.signedCheckpointBytes).toEqual(canonicalBytes(fixture.signedCheckpoints[2]))
    expect(fixture.calls[0]!.pathname).toBe(`/api/governance/v1/feeds/${fixture.feedId}/head`)
  })

  it('rejects a substituted source anchor or independent pin', async () => {
    await expect(discoverFeedHead({ ...config, anchorPin: 'd'.repeat(64) })).rejects.toThrow()
    alteredBody({ version: 1, signedAnchor: encodeBase64Url(body({ altered: true })),
      signedCheckpoint: encodeBase64Url(body(fixture.signedCheckpoints[2])),
      checkpointHash: await checkpointHash(fixture.signedCheckpoints[2]!.statement) })
    await expect(discoverFeedHead(config)).rejects.toThrow()
  })

  it('rejects wrong hash, feed, malformed signature, and extra head fields', async () => {
    const valid = { version: 1, signedAnchor: fixture.signedAnchor,
      signedCheckpoint: encodeBase64Url(body(fixture.signedCheckpoints[2])),
      checkpointHash: await checkpointHash(fixture.signedCheckpoints[2]!.statement) }
    for (const changed of [
      { ...valid, checkpointHash: 'f'.repeat(64) },
      { ...valid, signedCheckpoint: encodeBase64Url(body({ ...fixture.signedCheckpoints[2], statement: { ...fixture.signedCheckpoints[2]!.statement, feedId: 'f'.repeat(64) } })) },
      { ...valid, signedCheckpoint: encodeBase64Url(body({ ...fixture.signedCheckpoints[2], signature: 'bad' })) },
      { ...valid, extra: true },
    ]) {
      alteredBody(changed)
      await expect(discoverFeedHead(config)).rejects.toThrow()
    }
  })

  it('keeps an old or rotated-key head provisional until replay authenticates it', async () => {
    const old = fixture.signedCheckpoints[1]!
    const oldHash = await checkpointHash(old.statement)
    fixture.override = () => ({ bytes: body({ version: 1, signedAnchor: fixture.signedAnchor,
      signedCheckpoint: encodeBase64Url(body(old)), checkpointHash: oldHash }) })
    expect((await discoverFeedHead(config)).checkpointHash).toBe(oldHash)

    const rotated = await generateSigningKey()
    const signed = await signCheckpoint({ ...fixture.signedCheckpoints[2]!.statement,
      signerKeyId: await signingKeyId(rotated.publicKey), authorityRoot: 'f'.repeat(64) }, rotated)
    alteredBody({ version: 1, signedAnchor: fixture.signedAnchor,
      signedCheckpoint: encodeBase64Url(body(signed)), checkpointHash: await checkpointHash(signed.statement) })
    expect((await discoverFeedHead(config)).provisional).toBe(true)
  })

  it('pages signed checkpoints and contiguous leaves through an immutable target', async () => {
    const target = await discoverFeedHead(config)
    let after = 'start'
    const gathered: Uint8Array[] = []
    for (let index = 0; index < 3; index += 1) {
      const page = await fetchCheckpointPage(config, target.checkpointHash, after, 1)
      expect(page.items).toHaveLength(1)
      gathered.push(page.items[0]!.bytes)
      after = page.items[0]!.hash
    }
    expect(after).toBe(target.checkpointHash)
    expect(gathered).toEqual(fixture.signedCheckpoints.map(body))
    expect((await fetchCheckpointPage(config, target.checkpointHash, after, 1)).items).toEqual([])
    const leaves = [
      ...(await fetchLeafPage(config, target.checkpointHash, 0, target.signedCheckpoint.statement.size, 1)).items,
      ...(await fetchLeafPage(config, target.checkpointHash, 1, target.signedCheckpoint.statement.size, 1)).items,
    ]
    expect(leaves).toEqual(fixture.leaves)
    expect((await fetchLeafPage(config, target.checkpointHash, 2, 2, 1)).items).toEqual([])
  })

  it('rejects nonterminal empty pages and echo mismatches', async () => {
    const target = await discoverFeedHead(config)
    for (const changed of [
      { version: 1, target: target.checkpointHash, after: 'start', items: [] },
      { version: 1, target: 'f'.repeat(64), after: 'start', items: [] },
      { version: 1, target: target.checkpointHash, after: 'f'.repeat(64), items: [] },
    ]) {
      alteredBody(changed)
      await expect(fetchCheckpointPage(config, target.checkpointHash, 'start', 1)).rejects.toThrow()
    }
    for (const changed of [
      { version: 1, target: target.checkpointHash, start: 0, items: [] },
      { version: 1, target: 'f'.repeat(64), start: 0, items: [] },
      { version: 1, target: target.checkpointHash, start: 1, items: [] },
    ]) {
      alteredBody(changed)
      await expect(fetchLeafPage(config, target.checkpointHash, 0, 2, 1)).rejects.toThrow()
    }
  })

  it('rejects a skipped checkpoint predecessor and an overlong page', async () => {
    const target = await discoverFeedHead(config)
    alteredBody({ version: 1, target: target.checkpointHash, after: 'start',
      items: [encodeBase64Url(body(fixture.signedCheckpoints[1]))] })
    await expect(fetchCheckpointPage(config, target.checkpointHash, 'start', 1)).rejects.toThrow()
    alteredBody({ version: 1, target: target.checkpointHash, after: 'start',
      items: fixture.signedCheckpoints.slice(0, 2).map(item => encodeBase64Url(body(item))) })
    await expect(fetchCheckpointPage(config, target.checkpointHash, 'start', 1)).rejects.toThrow()
  })

  it('rejects malformed canonical envelopes and inner bytes', async () => {
    const target = await discoverFeedHead(config)
    fixture.override = () => ({ bytes: new TextEncoder().encode('{"version":1,"version":1}') })
    await expect(fetchLeafPage(config, target.checkpointHash, 0, 2, 1)).rejects.toThrow()
    alteredBody({ version: 1, target: target.checkpointHash, start: 0, items: ['e30='] })
    await expect(fetchLeafPage(config, target.checkpointHash, 0, 2, 1)).rejects.toThrow()
    alteredBody({ version: 1, target: target.checkpointHash, after: 'start', items: [encodeBase64Url(new TextEncoder().encode('{"z":1,"a":2}'))] })
    await expect(fetchCheckpointPage(config, target.checkpointHash, 'start', 1)).rejects.toThrow()
  })

  it('caps decoded chunked and gzip responses before parsing', async () => {
    const target = await discoverFeedHead(config)
    fixture.override = () => ({ bytes: new Uint8Array(256 * 1024 + 1).fill(65) })
    await expect(fetchLeafPage(config, target.checkpointHash, 0, 2, 1)).rejects.toThrow(/limit/i)
    await expect(fetchLeafPage(config, target.checkpointHash, 0, 2, 1)).rejects.toBeInstanceOf(SourceProtocolError)
    fixture.override = () => ({ bytes: gzipSync(new Uint8Array(64 * 1024 + 1).fill(65)), headers: { 'content-encoding': 'gzip' } })
    await expect(fetchCheckpointPage(config, target.checkpointHash, 'start', 1)).rejects.toThrow(/limit/i)
  })

  it('rejects redirects and timeouts without exposing response text', async () => {
    fixture.override = () => ({ status: 302, headers: { location: 'https://elsewhere.example/secret' } })
    await expect(discoverFeedHead(config)).rejects.toThrow()
    fixture.override = () => ({ status: 500, bytes: new TextEncoder().encode('private diagnostic') })
    await expect(discoverFeedHead(config)).rejects.not.toThrow(/private diagnostic/)
    await expect(discoverFeedHead(config)).rejects.toMatchObject({ status: 500 })
    fixture.override = () => ({ delayMs: 100, bytes: new Uint8Array() })
    await expect(discoverFeedHead(config, { timeoutMs: 5 })).rejects.toThrow(/timed out/i)
    await expect(discoverFeedHead(config, { timeoutMs: 5 })).rejects.toBeInstanceOf(SourceTransportError)
  })

  it('exposes HTTP status without response bodies and rejects unsafe requests', async () => {
    fixture.override = () => ({ status: 403, bytes: new TextEncoder().encode('credential: secret') })
    await expect(discoverFeedHead(config)).rejects.toBeInstanceOf(SourceHttpError)
    await expect(fetchCheckpointPage(config, 'bad', 'start', 1)).rejects.toThrow(/request/)
    await expect(fetchLeafPage(config, 'a'.repeat(64), 3, 2, 1)).rejects.toThrow(/request/)
    await expect(discoverFeedHead({ ...config, sourceBaseUrl: 'http://evil.example' })).rejects.toThrow(/protocol/)
  })

  it('classifies malformed successful responses as protocol nonconformance', async () => {
    fixture.override = () => ({ bytes: new TextEncoder().encode('{"version":1,"version":1}') })
    await expect(discoverFeedHead(config)).rejects.toBeInstanceOf(SourceProtocolError)
    const target = await checkpointHash(fixture.signedCheckpoints[2]!.statement)
    alteredBody({ version: 1, target, start: 0, items: [] })
    await expect(fetchLeafPage(config, target, 0, 2, 1)).rejects.toBeInstanceOf(SourceProtocolError)
  })

  it('classifies a failed connection as transport unavailability', async () => {
    await fixture.close()
    fixture.close = async () => undefined
    await expect(discoverFeedHead(config)).rejects.toBeInstanceOf(SourceTransportError)
  })

  it('cancels an unbounded HTTP error body without draining it', async () => {
    let cancellations = 0
    let pulls = 0
    const stream = new ReadableStream<Uint8Array>({
      pull() { pulls += 1; return new Promise<void>(() => undefined) },
      cancel() { cancellations += 1 },
    })
    vi.stubGlobal('fetch', async () => new Response(stream, { status: 403 }))
    await expect(discoverFeedHead(config)).rejects.toMatchObject({ status: 403 })
    expect(cancellations).toBe(1)
    expect(pulls).toBeLessThanOrEqual(1)
  })
})
