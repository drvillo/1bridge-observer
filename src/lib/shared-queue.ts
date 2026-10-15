import { send } from '@vercel/queue'
import type { SharedContinuation } from './shared-continuation'

export const sharedCatchupTopic = 'observer-catchup'

/** Queue delivery is an optional wake-up; the database cursor is the durable state. */
export async function sendSharedContinuation(next: SharedContinuation | null,
  parentMessageId?: string): Promise<'not_needed' | 'local_only' | 'queued'> {
  if (!next) return 'not_needed'
  if (process.env.VERCEL !== '1') return 'local_only'
  await send(sharedCatchupTopic, next, { retentionSeconds: 3600,
    ...(parentMessageId ? { idempotencyKey: `${sharedCatchupTopic}:${parentMessageId}` } : {}) })
  return 'queued'
}
