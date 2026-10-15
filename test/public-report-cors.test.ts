import { afterEach, describe, expect, it, vi } from 'vitest'
import { GET as latest } from '../src/app/api/shared-reports/latest/route'
import { GET as status } from '../src/app/api/shared-reports/status/route'

describe('public shared-report browser reads', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('allows cross-origin noncredentialed reads of unavailable and malformed reports', async () => {
    vi.stubEnv('REGISTRY_PUBLISHER_PUBLIC_KEY', '')
    const responses = [
      await latest(),
      await status(new Request('https://observer.example/api/shared-reports/status')),
      await status(new Request(`https://observer.example/api/shared-reports/status?reportHash=${'a'.repeat(64)}&feedId=${'b'.repeat(64)}`)),
    ]
    expect(responses.map(response => response.status)).toEqual([503, 400, 503])
    for (const response of responses) {
      expect(response.headers.get('access-control-allow-origin')).toBe('*')
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
  })
})
