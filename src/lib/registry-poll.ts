import { canonicalBytes, encodeBase64Url,
  type RegistryReplaySnapshot } from '@drvillo/1bridge-authority'
import { verifyRegistryPin, type SharedObserverConfig } from './config'
import { acceptRegistryTarget, beginRegistryTarget, claimRegistryLease,
  initializeRegistry, quarantineRegistryTarget, readRegistryProgress,
  recordRegistryFinding, releaseRegistryLease, stageRegistryCheckpoint,
  stageRegistryEntries } from './registry-store'
import { discoverRegistryHead, fetchRegistryCheckpointPage,
  fetchRegistryConsistency, fetchRegistryEntryPage } from './registry-source'
import { SourceHttpError, SourceProtocolError, SourceTransportError } from './source'
import type { ObserverStore } from './store'

export interface RegistryPollBudget {
  maxEntryPages: number
  maxCheckpoints: number
  maxMs: number
}
export type RegistryPollResult =
  | { status: 'busy' | 'unavailable' | 'up_to_date' | 'source_nonconforming' }
  | { status: 'pending'; progressed: boolean }
  | { status: 'accepted'; snapshot: RegistryReplaySnapshot }
  | { status: 'quarantined' }

function validBudget(value: RegistryPollBudget): void {
  if (!value || !Number.isSafeInteger(value.maxEntryPages) || value.maxEntryPages < 1
    || value.maxEntryPages > 100 || !Number.isSafeInteger(value.maxCheckpoints)
    || value.maxCheckpoints < 1 || value.maxCheckpoints > 100
    || !Number.isSafeInteger(value.maxMs) || value.maxMs < 1 || value.maxMs > 60_000) {
    throw new TypeError('Invalid registry poll budget')
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index])
}

function finding(targetHash: string | null, signedTarget: Uint8Array | null,
  after: string, stagedNextIndex: number, reason: string): Uint8Array {
  return canonicalBytes({ version: 1, kind: 'observer.registry_nonconformance',
    targetHash, signedTarget: signedTarget ? encodeBase64Url(signedTarget) : null,
    after, stagedNextIndex, reason })
}

/** Pulls one immutable registry target, preserving a staged backlog across invocations. */
export async function pollRegistryOnce(store: ObserverStore, config: SharedObserverConfig,
  workerId: string, budget: RegistryPollBudget): Promise<RegistryPollResult> {
  validBudget(budget)
  const pin = await verifyRegistryPin(config)
  await initializeRegistry(store, pin)
  const deadline = Date.now() + budget.maxMs
  let lease = await claimRegistryLease(store, workerId, Math.min(300_000, budget.maxMs + 15_000))
  if (!lease) return { status: 'busy' }
  try {
    const progress = await readRegistryProgress(store, lease)
    let target = progress.target
    let targetIsStaged = target !== null
    let stagedNext = progress.stagedNextIndex
    let after = progress.checkpointAfter
    let entryPages = 0
    let checkpoints = 0
    let progressed = false
    const pending = (): RegistryPollResult => ({ status: 'pending', progressed })
    const requestOptions = () => ({ timeoutMs: Math.max(1, Math.min(10_000, deadline - Date.now())) })
    try {
      if (!target) {
        if (Date.now() >= deadline) return pending()
        target = await discoverRegistryHead(config, requestOptions())
        if (target.checkpointHash === progress.acceptedHash) {
          if (!sameBytes(target.signedCheckpointBytes, progress.acceptedCheckpointBytes)) {
            throw new SourceProtocolError('Registry source changed accepted checkpoint bytes')
          }
          return { status: 'up_to_date' }
        }
        if (target.signedCheckpoint.statement.size <= progress.acceptedSize) {
          throw new SourceProtocolError('Registry source is behind accepted coverage')
        }
        try {
          lease = await beginRegistryTarget(store, lease, target, pin.publisherKey)
          targetIsStaged = true
          progressed = true
        }
        catch (error) {
          if (error instanceof TypeError) throw new SourceProtocolError('Invalid signed registry target')
          throw error
        }
      }
      while (after !== target.checkpointHash) {
        if (checkpoints >= budget.maxCheckpoints || Date.now() >= deadline) return pending()
        const page = await fetchRegistryCheckpointPage(config, target.checkpointHash,
          after, 1, requestOptions())
        const checkpoint = page.items[0]
        if (!checkpoint) throw new SourceProtocolError('Registry checkpoint page is incomplete')
        while (stagedNext < checkpoint.signed.statement.size) {
          if (entryPages >= budget.maxEntryPages || Date.now() >= deadline) return pending()
          const entries = await fetchRegistryEntryPage(config, target.checkpointHash,
            stagedNext, target.signedCheckpoint.statement.size,
            Math.min(64, checkpoint.signed.statement.size - stagedNext), requestOptions())
          try { lease = await stageRegistryEntries(store, lease, stagedNext, entries.items) }
          catch (error) {
            if (error instanceof TypeError) throw new SourceProtocolError('Invalid staged registry entries')
            throw error
          }
          stagedNext += entries.items.length
          progressed = true
          entryPages++
        }
        const proof = await fetchRegistryConsistency(config, after, checkpoint.hash, requestOptions())
        try { lease = await stageRegistryCheckpoint(store, lease, checkpoint, proof, pin.publisherKey) }
        catch (error) {
          if (error instanceof TypeError) throw new SourceProtocolError('Invalid registry checkpoint extension')
          throw error
        }
        after = checkpoint.hash
        checkpoints++
        progressed = true
      }
      try { return { status: 'accepted', snapshot: await acceptRegistryTarget(store, lease, pin.publisherKey) } }
      catch (error) {
        if (!(error instanceof TypeError)) throw error
        await quarantineRegistryTarget(store, lease, finding(target.checkpointHash,
          target.signedCheckpointBytes, after, stagedNext, 'Registry replay rejected target'))
        return { status: 'quarantined' }
      }
    } catch (error) {
      if (error instanceof SourceHttpError || error instanceof SourceTransportError) {
        return { status: 'unavailable' }
      }
      if (error instanceof SourceProtocolError) {
        const evidence = finding(target?.checkpointHash ?? null,
          target?.signedCheckpointBytes ?? null, after, stagedNext, error.message)
        if (targetIsStaged) await quarantineRegistryTarget(store, lease, evidence, 'source_nonconformance')
        else await recordRegistryFinding(store, lease, 'source_nonconformance', evidence)
        return { status: 'source_nonconforming' }
      }
      throw error
    }
  } finally { await releaseRegistryLease(store, lease) }
}
