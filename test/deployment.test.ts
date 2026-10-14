import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Hobby-compatible Vercel cron deployment', () => {
  it('schedules one daily invocation of the protected poll route', () => {
    const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as {
      crons: { path: string; schedule: string }[]
    }
    expect(config.crons).toEqual([{ path: '/api/poll', schedule: '0 8 * * *' }])
  })
})
