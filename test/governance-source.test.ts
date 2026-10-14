import { describe, expect, it } from 'vitest'
import * as authority from '@drvillo/1bridge-authority'
import { discoverFeedHead, fetchCheckpointPage, fetchLeafPage } from '../src/lib/source'
import type { ObserverConfig } from '../src/lib/config'
import { buildGovernanceSource, startGovernanceSource } from './governance-source-fixture'

function config(history: Awaited<ReturnType<typeof buildGovernanceSource>>, baseUrl: string): ObserverConfig {
  return { sourceBaseUrl: baseUrl, feedId: history.signedAnchor.anchor.feedId,
    anchorPin: history.anchorPin, signedAnchor: authority.encodeBase64Url(authority.canonicalBytes(history.signedAnchor)),
    databaseUrl: 'postgres://db.example/observer', databaseSchema: 'public', cronSecret: 'x'.repeat(32) }
}

async function pullHistory(settings: ObserverConfig) {
  const head = await discoverFeedHead(settings)
  const checkpoints: authority.SignedCheckpoint[] = []
  let after = 'start'
  while (after !== head.checkpointHash) {
    const page = await fetchCheckpointPage(settings, head.checkpointHash, after, 2)
    expect(page.items.length).toBeGreaterThan(0)
    for (const item of page.items) checkpoints.push(item.signed)
    after = page.items.at(-1)!.hash
  }
  const leaves: Uint8Array[] = []
  while (leaves.length < head.signedCheckpoint.statement.size) {
    const page = await fetchLeafPage(settings, head.checkpointHash, leaves.length,
      head.signedCheckpoint.statement.size, 3)
    expect(page.items.length).toBeGreaterThan(0)
    leaves.push(...page.items)
  }
  expect(checkpoints.at(-1)).toEqual(head.signedCheckpoint)
  const signedAnchor = authority.parseCanonical(authority.decodeBase64Url(settings.signedAnchor, 16384)) as unknown as authority.SignedAuthorityAnchor
  return { head, checkpoints, leaves, signedAnchor }
}

describe('mixed governance source over HTTP', () => {
  it('replays two actor streams across policy and provider rotation', async () => {
    const history = await buildGovernanceSource()
    const source = await startGovernanceSource(history)
    try {
      const pulled = await pullHistory(config(history, source.baseUrl))
      expect(pulled.head.provisional).toBe(true)
      expect(pulled.checkpoints).toEqual(history.checkpoints)
      expect(pulled.leaves).toEqual(history.leaves)
      expect(source.calls.filter(call => call.pathname.endsWith('/checkpoints'))).toHaveLength(4)
      expect(source.calls.filter(call => call.pathname.endsWith('/leaves'))).toHaveLength(3)
      const accepted = await authority.replayGovernanceHistory(pulled.signedAnchor,
        history.anchorPin, pulled.leaves, pulled.checkpoints)
      expect(accepted.size).toBe(7)
      expect(accepted.policyEpoch).toBe(1)
      expect(accepted.checkpointHash).toBe(pulled.head.checkpointHash)
      expect(accepted.actorHeads.map(actor => actor.actorKeyId).sort()).toEqual([...history.actorKeyIds].sort())
      expect(history.secondActionPredecessor).toBe(history.firstActionHash)
    } finally {
      await source.close()
    }
  })

  it.each(['wrongRoot', 'wrongPolicy'] as const)(
    'keeps a validly provider-signed %s target provisional until replay rejects it', async candidateName => {
      const history = await buildGovernanceSource()
      const candidate = history[candidateName]
      expect(await authority.verifyCheckpoint(candidate, history.rotatedPublicKey)).toBe(true)
      const source = await startGovernanceSource(history, candidate)
      try {
        const pulled = await pullHistory(config(history, source.baseUrl))
        expect(pulled.head.provisional).toBe(true)
        expect(pulled.checkpoints.at(-1)).toEqual(candidate)
        await expect(authority.replayGovernanceHistory(pulled.signedAnchor,
          history.anchorPin, pulled.leaves, pulled.checkpoints)).rejects.toThrow(/disagrees/)
      } finally {
        await source.close()
      }
    },
  )
})
