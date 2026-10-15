export interface SharedContinuation {
  version: 1
  scansRemaining: number
  sweepProgressed: boolean
  callsRemaining: number
}

export interface SharedPollSummary {
  feedCount: number
  selectedCount: number
  maxFeeds: number
  madeProgress: boolean
}

const maxContinuationCalls = 128

export function parseSharedContinuation(value: unknown): SharedContinuation {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid shared continuation message')
  const item = value as Partial<SharedContinuation>
  if (item.version !== 1
    || !Number.isSafeInteger(item.scansRemaining) || item.scansRemaining! < 0
    || !Number.isSafeInteger(item.callsRemaining) || item.callsRemaining! < 1
    || item.callsRemaining! > maxContinuationCalls
    || typeof item.sweepProgressed !== 'boolean') {
    throw new TypeError('Invalid shared continuation message')
  }
  return item as SharedContinuation
}

/** Queues only the next wake-up; durable observer cursors remain in Postgres. */
export function nextSharedContinuation(previous: SharedContinuation | null,
  summary: SharedPollSummary): SharedContinuation | null {
  if (!summary || !Number.isSafeInteger(summary.feedCount) || summary.feedCount < 0
    || !Number.isSafeInteger(summary.selectedCount) || summary.selectedCount < 0
    || !Number.isSafeInteger(summary.maxFeeds) || summary.maxFeeds < 1 || summary.maxFeeds > 100
    || summary.selectedCount > summary.feedCount || summary.selectedCount > summary.maxFeeds
    || typeof summary.madeProgress !== 'boolean') {
    throw new TypeError('Invalid shared poll summary')
  }
  if (previous) previous = parseSharedContinuation(previous)
  const callsRemaining = previous ? previous.callsRemaining - 1 : maxContinuationCalls
  if (callsRemaining < 1) return null
  const batches = Math.max(1, Math.ceil(summary.feedCount / summary.maxFeeds))
  const scansRemaining = previous ? previous.scansRemaining - 1 : batches - 1
  const sweepProgressed = (previous?.sweepProgressed ?? false) || summary.madeProgress
  if (scansRemaining > 0) {
    return { version: 1, scansRemaining, sweepProgressed, callsRemaining }
  }
  if (!sweepProgressed) return null
  return { version: 1, scansRemaining: batches - 1,
    sweepProgressed: false, callsRemaining }
}
