import {
  createGovernanceReplaySession,
  decodeBase64Url,
  parseCanonical,
  type GovernanceReplaySession,
  type GovernanceReplaySnapshot,
  type SignedAuthorityAnchor,
} from '@drvillo/1bridge-authority'
import type { ObserverConfig } from './config'
import { discoverFeedHead, fetchCheckpointPage, fetchLeafPage, SourceProtocolError } from './source'

export interface SourceVerificationBudget {
  maxLeaves: number
  maxCheckpoints: number
}

export class SourceIncompleteError extends Error {}

function budgetCount(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= 100_000
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/** Verifies one fixed source target in memory; it makes no durable observation claim. */
export async function verifySourceTarget(config: ObserverConfig,
  budget: SourceVerificationBudget): Promise<GovernanceReplaySnapshot> {
  if (!budgetCount(budget.maxLeaves) || !budgetCount(budget.maxCheckpoints)) {
    throw new TypeError('Invalid source verification budget')
  }
  const head = await discoverFeedHead(config)
  if (head.signedCheckpoint.statement.size > budget.maxLeaves) {
    throw new SourceIncompleteError('Fixed target exceeds leaf budget')
  }
  const anchor = parseCanonical(decodeBase64Url(config.signedAnchor, 16_384)) as unknown as SignedAuthorityAnchor
  let session: GovernanceReplaySession | null = null
  let after = 'start'
  let checkpointCount = 0
  let leafIndex = 0
  while (after !== head.checkpointHash) {
    const remaining = budget.maxCheckpoints - checkpointCount
    if (remaining <= 0) throw new SourceIncompleteError('Fixed target exceeds checkpoint budget')
    const page = await fetchCheckpointPage(config, head.checkpointHash, after, Math.min(remaining, 16))
    for (const item of page.items) {
      checkpointCount++
      if (!session) {
        session = await createGovernanceReplaySession(anchor, config.anchorPin, item.signed)
      } else {
        const end = item.signed.statement.size
        if (end > head.signedCheckpoint.statement.size) {
          throw new SourceProtocolError('Checkpoint exceeds fixed target size')
        }
        while (leafIndex < end) {
          const leaves = await fetchLeafPage(config, head.checkpointHash, leafIndex,
            head.signedCheckpoint.statement.size, Math.min(64, end - leafIndex))
          await session.appendLeaves(leaves.items, item.signed)
          leafIndex += leaves.items.length
        }
        await session.sealCheckpoint(item.signed)
      }
      after = item.hash
      if (after === head.checkpointHash && !equalBytes(item.bytes, head.signedCheckpointBytes)) {
        throw new SourceProtocolError('Fixed target checkpoint bytes changed')
      }
    }
  }
  if (!session || leafIndex !== head.signedCheckpoint.statement.size) {
    throw new SourceProtocolError('Incomplete fixed target')
  }
  return session.snapshot()
}
