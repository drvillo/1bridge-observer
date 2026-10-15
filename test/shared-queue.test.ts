import { afterEach, describe, expect, it, vi } from 'vitest'
import { send } from '@vercel/queue'
import { loadSharedPollContext, runSharedPollCycle } from '../src/lib/shared-poll-run'
import { POST } from '../src/app/api/queues/shared-catchup/route'

vi.mock('@vercel/queue', () => ({
  handleCallback: (handler: (message: unknown, metadata: { messageId: string }) => Promise<void>) => handler,
  send: vi.fn(),
}))
vi.mock('../src/lib/shared-poll-run', () => ({
  loadSharedPollContext: vi.fn(async () => ({})),
  runSharedPollCycle: vi.fn(),
  sharedPollBudget: { maxFeeds: 12 },
}))

const deliver = POST as unknown as (message: unknown, metadata: { messageId: string }) => Promise<void>
const message = { version: 1, scansRemaining: 0, sweepProgressed: false, callsRemaining: 2 }

describe('private shared catch-up queue consumer', () => {
  afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs() })

  it('polls from durable state and sends a bounded successor after progress', async () => {
    vi.stubEnv('VERCEL', '1')
    vi.mocked(runSharedPollCycle).mockResolvedValue({
      feedCount: 1, selectedCount: 1, madeProgress: true,
    } as never)
    await deliver(message, { messageId: 'parent-123' })
    expect(loadSharedPollContext).toHaveBeenCalledOnce()
    expect(runSharedPollCycle).toHaveBeenCalledOnce()
    expect(runSharedPollCycle).toHaveBeenCalledWith(expect.anything(), expect.any(String), 'when_changed')
    expect(send).toHaveBeenCalledWith('observer-catchup',
      { version: 1, scansRemaining: 0, sweepProgressed: false, callsRemaining: 1 },
      { retentionSeconds: 3600, idempotencyKey: 'observer-catchup:parent-123' })
  })

  it('stops without a successor on a no-progress sweep', async () => {
    vi.stubEnv('VERCEL', '1')
    vi.mocked(runSharedPollCycle).mockResolvedValue({
      feedCount: 1, selectedCount: 1, madeProgress: false,
    } as never)
    await deliver(message, { messageId: 'parent-123' })
    expect(send).not.toHaveBeenCalled()
  })

  it('rejects a malformed message before reading shared credentials or database', async () => {
    await expect(deliver({ version: 1, callsRemaining: -1 },
      { messageId: 'parent-123' })).rejects.toThrow(TypeError)
    expect(loadSharedPollContext).not.toHaveBeenCalled()
  })
})
