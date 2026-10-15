import { describe, expect, it } from 'vitest'
import * as authority from '@drvillo/1bridge-authority'
import { SourceIncompleteError, verifySourceTarget } from '../src/lib/verify-source'
import { SourceHttpError, SourceProtocolError } from '../src/lib/source'
import type { ObserverConfig } from '../src/lib/config'
import { buildGovernanceSource, startGovernanceSource } from './governance-source-fixture'

function config(history: Awaited<ReturnType<typeof buildGovernanceSource>>, baseUrl: string): ObserverConfig {
  return { sourceBaseUrl: baseUrl, feedId: history.signedAnchor.anchor.feedId,
    anchorPin: history.anchorPin, signedAnchor: authority.encodeBase64Url(authority.canonicalBytes(history.signedAnchor)),
    databaseUrl: 'postgres://db.example/observer', databaseSchema: 'public', cronSecret: 'x'.repeat(32) }
}

const budget = { maxLeaves: 64, maxCheckpoints: 16 }

describe('fixed-target source verification', () => {
  it('authenticates every checkpoint and leaf in the mixed source history', async () => {
    const history = await buildGovernanceSource()
    const source = await startGovernanceSource(history)
    try {
      const result = await verifySourceTarget(config(history, source.baseUrl), budget)
      expect(result.size).toBe(history.leaves.length)
      expect(result.checkpointHash).toBe(await authority.checkpointHash(history.checkpoints.at(-1)!.statement))
      expect(result.policyEpoch).toBe(1)
      expect(result.actorHeads.map(actor => actor.actorKeyId).sort()).toEqual([...history.actorKeyIds].sort())
      expect(source.calls.some(call => call.pathname.endsWith('/checkpoints'))).toBe(true)
      expect(source.calls.some(call => call.pathname.endsWith('/leaves'))).toBe(true)
    } finally { await source.close() }
  })

  it('detects a suppressed action when a later signed action cites its retained receipt', async () => {
    const history = await buildGovernanceSource()
    const suppressed = history.suppressedFirst
    expect(suppressed.leaves).toHaveLength(history.leaves.length - 1)
    expect(suppressed.laterActionPredecessor).toBe(history.firstActionHash)
    expect(await Promise.all(suppressed.leaves.map(leaf => authority.hashLeaf(leaf))))
      .not.toContain(history.firstReceipt.leafHash)
    expect(suppressed.checkpoints.at(-1)!.statement.historyRoot)
      .toBe(await authority.merkleRoot(suppressed.leaves))
    const unlinked = await startGovernanceSource({ ...history,
      leaves: history.suppressedWithoutCitation.leaves,
      checkpoints: history.suppressedWithoutCitation.checkpoints })
    try {
      const accepted = await verifySourceTarget(config(history, unlinked.baseUrl), budget)
      expect(accepted.size).toBe(suppressed.leaves.length)
    } finally { await unlinked.close() }
    const source = await startGovernanceSource({ ...history, leaves: suppressed.leaves,
      checkpoints: suppressed.checkpoints })
    try {
      await expect(verifySourceTarget(config(history, source.baseUrl), budget))
        .rejects.toThrow(/First action/)
      expect(source.calls.some(call => call.pathname.endsWith('/leaves'))).toBe(true)
    } finally { await source.close() }
  })

  it.each(['wrongRoot', 'wrongPolicy'] as const)('rejects a signed %s target after replay', async candidateName => {
    const history = await buildGovernanceSource()
    const source = await startGovernanceSource(history, history[candidateName])
    try {
      await expect(verifySourceTarget(config(history, source.baseUrl), budget)).rejects.toThrow(/disagrees/)
    } finally { await source.close() }
  })

  it('reports budget exhaustion as incomplete verification', async () => {
    const history = await buildGovernanceSource()
    const source = await startGovernanceSource(history)
    try {
      await expect(verifySourceTarget(config(history, source.baseUrl),
        { maxLeaves: history.leaves.length - 1, maxCheckpoints: 16 })).rejects.toBeInstanceOf(SourceIncompleteError)
      await expect(verifySourceTarget(config(history, source.baseUrl),
        { maxLeaves: 64, maxCheckpoints: 2 })).rejects.toBeInstanceOf(SourceIncompleteError)
    } finally { await source.close() }
  })

  it('rejects a valid alternate signature on the fixed target when its bytes differ from discovery', async () => {
    const history = await buildGovernanceSource()
    const final = history.checkpoints.at(-1)!
    expect(history.resignedFinal.statement).toEqual(final.statement)
    expect(history.resignedFinal.signature).not.toBe(final.signature)
    const source = await startGovernanceSource(history, final, history.resignedFinal)
    try {
      await expect(verifySourceTarget(config(history, source.baseUrl), budget)).rejects.toBeInstanceOf(SourceProtocolError)
    } finally { await source.close() }
  })

  it('rejects a source-supplied replacement anchor under the independent pin', async () => {
    const history = await buildGovernanceSource()
    const source = await startGovernanceSource(history)
    try {
      const settings = { ...config(history, source.baseUrl), anchorPin: '0'.repeat(64) }
      await expect(verifySourceTarget(settings, budget)).rejects.toThrow(/pin mismatch/i)
    } finally { await source.close() }
  })

  it.each(['omitGenesis', 'omitTarget', 'skipLeaf'] as const)(
    'does not verify a source that %s', async fault => {
      const history = await buildGovernanceSource()
      const source = await startGovernanceSource(history, undefined, undefined, { [fault]: true })
      try {
        await expect(verifySourceTarget(config(history, source.baseUrl), budget))
          .rejects.toBeInstanceOf(SourceProtocolError)
      } finally { await source.close() }
    },
  )

  it('rejects a different valid action leaf at the final Merkle checkpoint', async () => {
    const history = await buildGovernanceSource()
    expect(history.alternateLastLeaf).not.toEqual(history.leaves.at(-1))
    const source = await startGovernanceSource(history, undefined, undefined, { changeLastLeaf: true })
    try {
      await expect(verifySourceTarget(config(history, source.baseUrl), budget)).rejects.toThrow(/disagrees/)
    } finally { await source.close() }
  })

  it('keeps source unavailability separate from authenticated invalidity', async () => {
    const history = await buildGovernanceSource()
    const source = await startGovernanceSource(history, undefined, undefined, { unavailableLeaves: true })
    try {
      await expect(verifySourceTarget(config(history, source.baseUrl), budget)).rejects.toMatchObject({
        constructor: SourceHttpError, status: 503,
      })
    } finally { await source.close() }
  })
})
