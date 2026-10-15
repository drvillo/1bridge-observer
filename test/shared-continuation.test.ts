import { describe, expect, it } from 'vitest'
import { nextSharedContinuation } from '../src/lib/shared-continuation'

const oneFeed = { feedCount: 1, selectedCount: 1, maxFeeds: 12 }

describe('bounded shared-observer queue continuation', () => {
  it('continues staged work and stops after the next complete no-progress sweep', () => {
    const first = nextSharedContinuation(null, { ...oneFeed, madeProgress: true })
    expect(first).toEqual({ version: 1, scansRemaining: 0,
      sweepProgressed: false, callsRemaining: 128 })
    expect(nextSharedContinuation(first, { ...oneFeed, madeProgress: false })).toBeNull()
  })

  it('scans all 25 feeds even if the first batch is already current', () => {
    const first = nextSharedContinuation(null,
      { feedCount: 25, selectedCount: 12, maxFeeds: 12, madeProgress: false })
    expect(first).toMatchObject({ scansRemaining: 2, sweepProgressed: false })
    const second = nextSharedContinuation(first,
      { feedCount: 25, selectedCount: 12, maxFeeds: 12, madeProgress: false })
    expect(second).toMatchObject({ scansRemaining: 1, sweepProgressed: false })
    expect(nextSharedContinuation(second,
      { feedCount: 25, selectedCount: 1, maxFeeds: 12, madeProgress: false })).toBeNull()
  })

  it('starts one more sweep after progress in a later batch', () => {
    const first = nextSharedContinuation(null,
      { feedCount: 25, selectedCount: 12, maxFeeds: 12, madeProgress: false })!
    const second = nextSharedContinuation(first,
      { feedCount: 25, selectedCount: 12, maxFeeds: 12, madeProgress: true })!
    expect(second).toMatchObject({ scansRemaining: 1, sweepProgressed: true })
    const third = nextSharedContinuation(second,
      { feedCount: 25, selectedCount: 1, maxFeeds: 12, madeProgress: false })
    expect(third).toMatchObject({ scansRemaining: 2, sweepProgressed: false })
  })

  it('does not hot-loop on a source outage or continue past its call cap', () => {
    expect(nextSharedContinuation(null, { ...oneFeed, madeProgress: false })).toBeNull()
    expect(nextSharedContinuation({ version: 1, scansRemaining: 0,
      sweepProgressed: true, callsRemaining: 1 }, { ...oneFeed, madeProgress: true })).toBeNull()
  })

  it('rejects malformed scheduling messages and impossible counts', () => {
    expect(() => nextSharedContinuation({ version: 2, scansRemaining: 0,
      sweepProgressed: false, callsRemaining: 1 } as never,
    { ...oneFeed, madeProgress: false })).toThrow(TypeError)
    expect(() => nextSharedContinuation(null,
      { feedCount: 1, selectedCount: 2, maxFeeds: 12, madeProgress: false })).toThrow(TypeError)
  })
})
