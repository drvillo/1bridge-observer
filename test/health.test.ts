import { describe, expect, it } from 'vitest'
import { GET } from '../src/app/api/health/route'

describe('GET /api/health', () => {
  it('reports only process liveness', async () => {
    const response = GET()
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toEqual({ status: 'up' })
  })
})
