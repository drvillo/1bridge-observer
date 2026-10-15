import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Hobby-compatible Vercel cron deployment', () => {
  it('schedules one daily invocation of the protected shared poll route', () => {
    const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as {
      crons: { path: string; schedule: string }[]
      functions: Record<string, { experimentalTriggers: { type: string; topic: string }[] }>
    }
    expect(config.crons).toEqual([{ path: '/api/shared-poll', schedule: '0 8 * * *' }])
    expect(config.functions['src/app/api/queues/shared-catchup/route.ts'].experimentalTriggers)
      .toEqual([{ type: 'queue/v2beta', topic: 'observer-catchup' }])
  })
})
