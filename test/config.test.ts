import { describe, expect, it } from 'vitest'
import { loadObserverConfig } from '../src/lib/config'

const valid = {
  NODE_ENV: 'production',
  SOURCE_BASE_URL: 'https://evidence.example/',
  FEED_ID: 'a'.repeat(64),
  CHECKPOINT_PUBLIC_KEY: Buffer.from('checkpoint-key-fixture'.repeat(3)).toString('base64url'),
  DATABASE_URL: 'postgresql://observer:private@db.example/observer?sslmode=require',
  CRON_SECRET: 'a customer controlled secret with 32 bytes',
}

describe('loadObserverConfig', () => {
  it('accepts production settings and normalizes the source origin', () => {
    expect(loadObserverConfig(valid)).toEqual({
      sourceBaseUrl: 'https://evidence.example',
      feedId: valid.FEED_ID,
      checkpointPublicKey: valid.CHECKPOINT_PUBLIC_KEY,
      databaseUrl: valid.DATABASE_URL,
      cronSecret: valid.CRON_SECRET,
    })
  })

  it('allows a test fixture on loopback HTTP', () => {
    expect(loadObserverConfig({ ...valid, NODE_ENV: 'test', SOURCE_BASE_URL: 'http://127.0.0.1:3100/' }).sourceBaseUrl)
      .toBe('http://127.0.0.1:3100')
  })

  it.each([
    'https://EVIDENCE.EXAMPLE/',
    'https://evidence.example:443/',
    'HTTPS://EVIDENCE.EXAMPLE:443/',
  ])('normalizes a valid source origin: %s', (sourceBaseUrl) => {
    expect(loadObserverConfig({ ...valid, SOURCE_BASE_URL: sourceBaseUrl }).sourceBaseUrl)
      .toBe('https://evidence.example')
  })

  it.each([
    ['missing source', { SOURCE_BASE_URL: undefined }],
    ['malformed source', { SOURCE_BASE_URL: 'not a URL' }],
    ['HTTP in production', { SOURCE_BASE_URL: 'http://localhost:3100/' }],
    ['HTTP away from loopback', { NODE_ENV: 'test', SOURCE_BASE_URL: 'http://example.com/' }],
    ['embedded credentials', { SOURCE_BASE_URL: 'https://user:pass@evidence.example/' }],
    ['query', { SOURCE_BASE_URL: 'https://evidence.example/?key=private' }],
    ['fragment', { SOURCE_BASE_URL: 'https://evidence.example/#private' }],
    ['non-root path', { SOURCE_BASE_URL: 'https://evidence.example/feed' }],
    ['normalized non-root path', { SOURCE_BASE_URL: 'https://evidence.example/feed/../' }],
    ['non-HTTP scheme', { SOURCE_BASE_URL: 'ftp://evidence.example/' }],
    ['uppercase feed', { FEED_ID: 'A'.repeat(64) }],
    ['short feed', { FEED_ID: 'a'.repeat(63) }],
    ['padded key', { CHECKPOINT_PUBLIC_KEY: `${valid.CHECKPOINT_PUBLIC_KEY}=` }],
    ['invalid key alphabet', { CHECKPOINT_PUBLIC_KEY: 'not+base64/key' }],
    ['short key', { CHECKPOINT_PUBLIC_KEY: 'YWJj' }],
    ['wrong DB scheme', { DATABASE_URL: 'mysql://db.example/observer' }],
    ['missing DB host', { DATABASE_URL: 'postgresql:///observer' }],
    ['missing DB name', { DATABASE_URL: 'postgresql://db.example/' }],
    ['short cron secret', { CRON_SECRET: 'short' }],
    ['missing cron secret', { CRON_SECRET: undefined }],
  ])('rejects %s without revealing values', (_, change) => {
    const settings = { ...valid, ...change }
    expect(() => loadObserverConfig(settings)).toThrow()
    try {
      loadObserverConfig(settings)
    } catch (error) {
      const message = String(error)
      expect(message).not.toContain('private')
      expect(message).not.toContain(valid.CRON_SECRET)
    }
  })

  it('accepts the postgres scheme', () => {
    expect(loadObserverConfig({ ...valid, DATABASE_URL: 'postgres://db.example/observer' }).databaseUrl)
      .toBe('postgres://db.example/observer')
  })
})
