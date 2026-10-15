import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pollSharedObserverOnce } from '../src/lib/shared-poll'
import { publishAggregateCoverage } from '../src/lib/aggregate-store'
import { runSharedPollCycle } from '../src/lib/shared-poll-run'

const close = vi.fn(async () => {})
vi.mock('../src/lib/store', () => ({
  openObserverStore: () => ({ close }), installObserverSchema: vi.fn(),
}))
vi.mock('../src/lib/shared-poll', () => ({ pollSharedObserverOnce: vi.fn() }))
vi.mock('../src/lib/aggregate-store', () => ({ publishAggregateCoverage: vi.fn() }))

const context = { config: { databaseUrl: 'disposable', databaseSchema: 'public' },
  signer: {} } as never

describe('shared poll report cadence', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('does not retain a new full snapshot for every staged queue page', async () => {
    vi.mocked(pollSharedObserverOnce).mockResolvedValue({ registry: { status: 'pending', progressed: true },
      feeds: [{ feedId: 'a'.repeat(64), status: 'pending' }], feedCount: 1,
      selectedCount: 1, madeProgress: true } as never)
    const result = await runSharedPollCycle(context, 'queue-worker', 'when_changed')
    expect(result.report).toBeNull()
    expect(publishAggregateCoverage).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })

  it('signs after accepted coverage and on every daily cron seed', async () => {
    vi.mocked(publishAggregateCoverage).mockResolvedValue({ reportHash: 'h', signedReport: {} } as never)
    vi.mocked(pollSharedObserverOnce).mockResolvedValue({ registry: { status: 'up_to_date' },
      feeds: [{ feedId: 'a'.repeat(64), status: 'accepted' }], feedCount: 1,
      selectedCount: 1, madeProgress: true } as never)
    expect((await runSharedPollCycle(context, 'queue-worker', 'when_changed')).report?.reportHash).toBe('h')
    vi.mocked(pollSharedObserverOnce).mockResolvedValue({ registry: { status: 'up_to_date' },
      feeds: [{ feedId: 'a'.repeat(64), status: 'up_to_date' }], feedCount: 1,
      selectedCount: 1, madeProgress: false } as never)
    expect((await runSharedPollCycle(context, 'cron-worker', 'always')).report?.reportHash).toBe('h')
    expect(publishAggregateCoverage).toHaveBeenCalledTimes(2)
  })
})
