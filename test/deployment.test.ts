import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Hobby-compatible Vercel cron deployment', () => {
  it('schedules only the compact global registry witness poll', () => {
    const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as {
      crons: { path: string; schedule: string }[]
      functions?: Record<string, { experimentalTriggers: { type: string; topic: string }[] }>
    }
    expect(config.crons).toEqual([{ path: '/api/registry-witness/poll', schedule: '0 8 * * *' }])
    expect(config.functions).toBeUndefined()
  })
})
