import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as authority from '@drvillo/1bridge-authority'

const bytes = readFileSync(new URL('./shared-registry-v1.json', import.meta.url))
const vector = JSON.parse(bytes.toString('utf8'))

describe('pinned shared-registry cross-repository vector', () => {
  it('replays the exact two-feed published checkpoint chain', async () => {
    expect(createHash('sha256').update(bytes).digest('hex'))
      .toBe('8ccfd1b9440873bd52cb5f38336645bbd896ad736b1e96d9bbb0c9229e91f5eb')
    const publisher = await authority.importSigningPublicKey(vector.publisherPublicKey)
    const observer = await authority.importSigningPublicKey(vector.observerPublicKey)
    const entries: Uint8Array[] = vector.entries.map((encoded: string) => authority.decodeBase64Url(encoded))
    const replay = await authority.createRegistryReplaySession(vector.genesis, publisher)
    await replay.appendRegistryEntries(entries.slice(0, 3), vector.headOne)
    await replay.sealRegistryCheckpoint(vector.headOne, vector.proofOne)
    expect(replay.snapshot()).toEqual(vector.snapshotOne)
    expect(await authority.verifyAggregateReport(vector.aggregateOne, observer, publisher,
      vector.snapshotOne.checkpointHash)).toBe(true)
    expect(await authority.verifyAggregateFeedStatus(vector.aggregateOne, vector.pendingProof,
      observer, publisher, vector.snapshotOne.checkpointHash,
      vector.snapshotOne.feeds[1].feedId, vector.snapshotOne.feeds[1].anchorPin)).toBe(true)
    await replay.appendRegistryEntries(entries.slice(3), vector.headTwo)
    await replay.sealRegistryCheckpoint(vector.headTwo, vector.proofTwo)
    expect(replay.snapshot()).toEqual(vector.snapshotTwo)
  })
})
