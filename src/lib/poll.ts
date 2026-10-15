import { canonicalBytes, encodeBase64Url, type GovernanceReplaySnapshot } from '@drvillo/1bridge-authority'
import type { ObserverConfig } from './config'
import { discoverFeedHead, fetchCheckpointPage, fetchLeafPage, type ProvisionalFeedHead,
  SourceHttpError, SourceProtocolError, SourceTransportError } from './source'
import { acceptObserverTarget, beginObserverTarget, claimObserverLease,
  quarantineObserverTarget, readObserverProgress, recordObserverFinding, registerObserverFeed,
  releaseObserverLease, stageObserverBatch,
  type ObserverStore } from './store'

export interface PollBudget {
  maxLeafPages: number
  maxCheckpoints: number
  maxMs: number
}

export type PollResult =
  | { status: 'busy' | 'unavailable' | 'up_to_date' | 'source_nonconforming' }
  | { status: 'pending'; progressed: boolean }
  | { status: 'accepted'; snapshot: GovernanceReplaySnapshot }
  | { status: 'quarantined'; findingId: number }

function validBudget(budget: PollBudget): void {
  if (!budget || !Number.isSafeInteger(budget.maxLeafPages) || budget.maxLeafPages < 1
    || budget.maxLeafPages > 100 || !Number.isSafeInteger(budget.maxCheckpoints)
    || budget.maxCheckpoints < 1 || budget.maxCheckpoints > 100
    || !Number.isSafeInteger(budget.maxMs) || budget.maxMs < 1 || budget.maxMs > 60_000) {
    throw new TypeError('Invalid observer poll budget')
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index])
}

/** Advances at most one fixed target by bounded HTTP pages, retaining every staged step. */
export async function pollObserverOnce(store: ObserverStore, config: ObserverConfig,
  workerId: string, budget: PollBudget, fixedTarget?: ProvisionalFeedHead): Promise<PollResult> {
  validBudget(budget)
  const deadline = Date.now() + budget.maxMs
  await registerObserverFeed(store, config)
  const lease = await claimObserverLease(store, config.feedId, workerId,
    Math.min(300_000, budget.maxMs + 15_000))
  if (!lease) return { status: 'busy' }
  try {
    const progress = await readObserverProgress(store, lease)
    let target = progress.target
    let claim = progress.targetClaim
    let stagedNext = progress.stagedNextIndex
    let after = progress.checkpointAfter
    let leafPages = 0
    let checkpoints = 0
    let progressed = false
    const pending = (): PollResult => ({ status: 'pending', progressed })
    const requestOptions = () => ({ timeoutMs: Math.max(1, Math.min(10_000, deadline - Date.now())) })
    try {
      if (!target) {
        if (Date.now() >= deadline) return pending()
        target = fixedTarget ?? await discoverFeedHead(config, requestOptions())
        if (target.checkpointHash === progress.acceptedHash) {
          if (!progress.acceptedCheckpointBytes
            || !equalBytes(target.signedCheckpointBytes, progress.acceptedCheckpointBytes)) {
            throw new SourceProtocolError('Source head bytes differ from retained accepted head')
          }
          return { status: 'up_to_date' }
        }
        if (target.signedCheckpoint.statement.size < progress.acceptedSize) {
          throw new SourceProtocolError('Source head is behind retained accepted coverage')
        }
        claim = await beginObserverTarget(store, lease, target)
        progressed = true
      }
      if (!claim) throw new TypeError('Observer target claim is missing')
      while (after !== target.checkpointHash) {
        if (checkpoints >= budget.maxCheckpoints || Date.now() >= deadline) return pending()
        const checkpointLimit = Math.min(16, budget.maxCheckpoints - checkpoints)
        const page = await fetchCheckpointPage(config, target.checkpointHash, after,
          checkpointLimit, requestOptions())
        const lastCheckpoint = page.items.at(-1)
        if (!lastCheckpoint) throw new SourceProtocolError('Missing fixed-target checkpoint')
        if (lastCheckpoint.signed.statement.size > target.signedCheckpoint.statement.size) {
          throw new SourceProtocolError('Checkpoint exceeds fixed target size')
        }
        while (stagedNext < lastCheckpoint.signed.statement.size) {
          if (leafPages >= budget.maxLeafPages || Date.now() >= deadline) return pending()
          const leaves = await fetchLeafPage(config, target.checkpointHash, stagedNext,
            target.signedCheckpoint.statement.size,
            Math.min(64, lastCheckpoint.signed.statement.size - stagedNext), requestOptions())
          const staged = await stageObserverBatch(store, claim,
            { start: stagedNext, leaves: leaves.items, checkpoints: [] })
          claim = staged.claim
          progressed = true
          stagedNext += leaves.items.length
          leafPages++
        }
        const staged = await stageObserverBatch(store, claim,
          { start: stagedNext, leaves: [], checkpoints: page.items })
        claim = staged.claim
        progressed = true
        after = lastCheckpoint.hash
        checkpoints += page.items.length
      }
      try { return { status: 'accepted', snapshot: await acceptObserverTarget(store, claim) } }
      catch (error) {
        if (!(error instanceof TypeError)) throw error
        return { status: 'quarantined', findingId: await quarantineObserverTarget(store, claim) }
      }
    } catch (error) {
      if (error instanceof SourceHttpError || error instanceof SourceTransportError) return { status: 'unavailable' }
      if (error instanceof SourceProtocolError) {
        const evidence = canonicalBytes({ version: 1, kind: 'observer.source_nonconformance',
          feedId: config.feedId, targetHash: target?.checkpointHash ?? null,
          signedTarget: target ? encodeBase64Url(target.signedCheckpointBytes) : null,
          after, stagedNextIndex: stagedNext, reason: error.message })
        await recordObserverFinding(store, claim ?? lease, 'source_nonconformance', evidence)
        return { status: 'source_nonconforming' }
      }
      throw error
    }
  } finally {
    await releaseObserverLease(store, lease)
  }
}
