import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as authority from '@drvillo/1bridge-authority'
import { verifySourceTarget } from '../src/lib/verify-source'
import { startGovernanceSource } from './governance-source-fixture'
import type { ObserverConfig } from '../src/lib/config'

interface GovernanceVector {
  version: 1
  profile: '1bridge.governance/v1'
  anchorPin: string
  signedAnchor: string
  leaves: string[]
  checkpoints: string[]
  expected: authority.GovernanceReplaySnapshot
}

const VECTOR_SHA256 = 'ae3fa8c88bc7e841101b8e8ffadf167a8b4d323d3645bc034fb7284c60945ef8'
const VECTOR_URL = new URL('./governance-v1.json', import.meta.url)

function vector(): GovernanceVector {
  const bytes = readFileSync(VECTOR_URL)
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(VECTOR_SHA256)
  return authority.parseCanonical(bytes) as unknown as GovernanceVector
}

function config(fixture: GovernanceVector, sourceBaseUrl: string): ObserverConfig {
  return { sourceBaseUrl, feedId: fixture.expected.feedId,
    anchorPin: fixture.anchorPin, signedAnchor: fixture.signedAnchor,
    databaseUrl: 'postgres://db.example/observer', databaseSchema: 'public', cronSecret: 'x'.repeat(32) }
}

function sourceHistory(fixture: GovernanceVector) {
  const leaves = fixture.leaves.map(item => authority.decodeBase64Url(item))
  return {
    signedAnchor: authority.parseCanonical(authority.decodeBase64Url(fixture.signedAnchor)) as unknown as authority.SignedAuthorityAnchor,
    leaves,
    checkpoints: fixture.checkpoints.map(item => authority.parseCanonical(authority.decodeBase64Url(item)) as unknown as authority.SignedCheckpoint),
    alternateLastLeaf: leaves[1]!,
  }
}

describe('frozen authority-to-observer governance vector', () => {
  it('replays exact public bytes through the real HTTP pull contract', async () => {
    const fixture = vector()
    expect(fixture.expected.anchorPin).toBe(fixture.anchorPin)
    const source = await startGovernanceSource(sourceHistory(fixture))
    try {
      await expect(verifySourceTarget(config(fixture, source.baseUrl),
        { maxLeaves: 64, maxCheckpoints: 16 })).resolves.toEqual(fixture.expected)
    } finally { await source.close() }
  })

  it('rejects a changed canonical leaf under the frozen signed head', async () => {
    const fixture = vector()
    const source = await startGovernanceSource(sourceHistory(fixture), undefined, undefined, { changeLastLeaf: true })
    try {
      await expect(verifySourceTarget(config(fixture, source.baseUrl),
        { maxLeaves: 64, maxCheckpoints: 16 })).rejects.toThrow(/Unauthorized action/)
    } finally { await source.close() }
  })
})
