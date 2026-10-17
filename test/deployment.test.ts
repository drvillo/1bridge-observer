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

  it('applies observer migrations before the Vercel build', () => {
    const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as {
      buildCommand?: string
    }
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      engines?: { node?: string }
      scripts: Record<string, string>
      type?: string
    }

    expect(packageJson.type).toBe('module')
    expect(packageJson.engines?.node).toBe('>=22.6.0')
    expect(packageJson.scripts['db:migrate:deploy'])
      .toBe('node --experimental-strip-types scripts/migrate.ts')
    expect(config.buildCommand).toBe('pnpm db:migrate:deploy && pnpm build')
  })
})
