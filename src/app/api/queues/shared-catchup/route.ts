import { randomUUID } from 'node:crypto'
import { handleCallback } from '@vercel/queue'
import { nextSharedContinuation,
  parseSharedContinuation } from '../../../../lib/shared-continuation'
import { loadSharedPollContext, runSharedPollCycle,
  sharedPollBudget } from '../../../../lib/shared-poll-run'
import { sendSharedContinuation } from '../../../../lib/shared-queue'

export const runtime = 'nodejs'
export const maxDuration = 60

/** Vercel's queue trigger is private; each delivery reopens durable Postgres state. */
export const POST = handleCallback(async (message: unknown, metadata) => {
  const previous = parseSharedContinuation(message)
  const context = await loadSharedPollContext(process.env)
  const result = await runSharedPollCycle(context, randomUUID(), 'when_changed')
  const next = nextSharedContinuation(previous, { feedCount: result.feedCount,
    selectedCount: result.selectedCount, madeProgress: result.madeProgress,
    maxFeeds: sharedPollBudget.maxFeeds })
  await sendSharedContinuation(next, metadata.messageId)
})
