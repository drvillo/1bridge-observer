import { beforeAll, describe, expect, it } from 'vitest'
import {
  anchorHash,
  canonicalJson,
  createAuthorityAnchor,
  encodeBase64Url,
  generateSigningKey,
  signAuthorityAnchor,
  type SignedAuthorityAnchor,
} from '@drvillo/1bridge-authority'
import { loadObserverConfig, verifyObserverAnchor } from '../src/lib/config'

const valid = {
  NODE_ENV: 'production',
  SOURCE_BASE_URL: 'https://evidence.example/',
  FEED_ID: 'a'.repeat(64),
  ANCHOR_PIN: 'b'.repeat(64),
  SIGNED_ANCHOR: Buffer.from('{}').toString('base64url'),
  DATABASE_URL: 'postgresql://observer:private@db.example/observer?sslmode=require',
  CRON_SECRET: 'a customer controlled secret with 32 bytes',
}

describe('loadObserverConfig', () => {
  it('accepts production settings and normalizes the source origin', () => {
    expect(loadObserverConfig(valid)).toEqual({
      sourceBaseUrl: 'https://evidence.example',
      feedId: valid.FEED_ID,
      anchorPin: valid.ANCHOR_PIN,
      signedAnchor: valid.SIGNED_ANCHOR,
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
    ['uppercase anchor pin', { ANCHOR_PIN: 'B'.repeat(64) }],
    ['short anchor pin', { ANCHOR_PIN: 'b'.repeat(63) }],
    ['missing anchor pin', { ANCHOR_PIN: undefined }],
    ['padded signed anchor', { SIGNED_ANCHOR: `${valid.SIGNED_ANCHOR}=` }],
    ['invalid signed anchor alphabet', { SIGNED_ANCHOR: 'not+base64/anchor' }],
    ['empty signed anchor', { SIGNED_ANCHOR: '' }],
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

describe('verifyObserverAnchor', () => {
  let signed: SignedAuthorityAnchor
  let pin: string
  let settings: ReturnType<typeof loadObserverConfig>

  beforeAll(async () => {
    const [root, recovery, checkpoint] = await Promise.all([
      generateSigningKey(),
      generateSigningKey(),
      generateSigningKey(),
    ])
    const anchor = await createAuthorityAnchor({
      feedId: valid.FEED_ID,
      workspaceId: 'c'.repeat(64),
      rootPublicKey: root.publicKey,
      recoveryPublicKey: recovery.publicKey,
      checkpointPublicKey: checkpoint.publicKey,
    })
    signed = await signAuthorityAnchor(anchor, root, recovery)
    pin = await anchorHash(anchor)
    settings = loadObserverConfig({
      ...valid,
      ANCHOR_PIN: pin,
      SIGNED_ANCHOR: encodeBase64Url(new TextEncoder().encode(canonicalJson(signed))),
    })
  })

  it('accepts the independently pinned dual-signed anchor and exposes its initial checkpoint key', async () => {
    const state = await verifyObserverAnchor(settings)
    expect(state.feedId).toBe(valid.FEED_ID)
    expect(state.checkpointKeyId).toBe(signed.anchor.checkpointKeyId)
    expect(state.checkpointKeySpki).toBe(signed.anchor.checkpointKeySpki)
  })

  it('rejects a valid signed anchor when the configured pin differs', async () => {
    await expect(verifyObserverAnchor({ ...settings, anchorPin: 'd'.repeat(64) })).rejects.toThrow()
  })

  it('rejects a valid pinned anchor when the configured feed differs', async () => {
    await expect(verifyObserverAnchor({ ...settings, feedId: 'd'.repeat(64) })).rejects.toThrow()
  })

  it('rejects a substituted signed anchor', async () => {
    const [root, recovery, checkpoint] = await Promise.all([
      generateSigningKey(),
      generateSigningKey(),
      generateSigningKey(),
    ])
    const substituted = await signAuthorityAnchor(await createAuthorityAnchor({
      feedId: valid.FEED_ID,
      workspaceId: signed.anchor.workspaceId,
      rootPublicKey: root.publicKey,
      recoveryPublicKey: recovery.publicKey,
      checkpointPublicKey: checkpoint.publicKey,
    }), root, recovery)
    const encoded = encodeBase64Url(new TextEncoder().encode(canonicalJson(substituted)))
    await expect(verifyObserverAnchor({ ...settings, signedAnchor: encoded })).rejects.toThrow()
  })

  it('rejects a matching pin when a possession signature is substituted', async () => {
    const changed = { ...signed, rootSignature: signed.recoverySignature }
    const encoded = encodeBase64Url(new TextEncoder().encode(canonicalJson(changed)))
    await expect(verifyObserverAnchor({ ...settings, signedAnchor: encoded })).rejects.toThrow()
  })

  it('rejects noncanonical signed-anchor JSON even when base64url is canonical', async () => {
    const encoded = encodeBase64Url(new TextEncoder().encode(JSON.stringify(signed)))
    expect(encoded).not.toBe(settings.signedAnchor)
    await expect(verifyObserverAnchor({ ...settings, signedAnchor: encoded })).rejects.toThrow()
  })
})
