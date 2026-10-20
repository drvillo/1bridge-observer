import { readFileSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import pg from 'pg'
import * as authority from '@drvillo/1bridge-authority'
import { loadSharedObserverConfig, verifyRegistryPin } from '../src/lib/config'
import { pollRegistryWitnessOnce } from '../src/lib/registry-witness-poll'
import { acceptRegistryWitness, readLatestRegistryWitness, readWitnessCursor,
  recordWitnessFinding } from '../src/lib/registry-witness-store'
import { GET as latestWitness } from '../src/app/api/registry-witness/latest/route'
import { GET as pollWitness } from '../src/app/api/registry-witness/poll/route'
import { closeRuntimeObserverStore, installObserverSchema, openObserverStore } from '../src/lib/store'

function requiredTestDatabaseUrl(): string {
  const value = process.env.OBSERVER_TEST_DATABASE_URL
  if (!value) throw new Error('OBSERVER_TEST_DATABASE_URL must identify a disposable database')
  return value
}

const databaseUrl = requiredTestDatabaseUrl()
const vector = JSON.parse(readFileSync(new URL('./shared-registry-v1.json', import.meta.url), 'utf8'))
const inspector = new pg.Pool({ connectionString: databaseUrl, max: 1 })
const encoded = (value: unknown) => authority.encodeBase64Url(authority.canonicalBytes(value))
const runtimeRole = 'observer_compact_runtime'
const runtimePassword = 'observer-runtime-test'

function runtimeDatabaseUrl(): string {
  const url = new URL(databaseUrl)
  url.username = runtimeRole
  url.password = runtimePassword
  return url.toString()
}

function config(publisherPublicKey = vector.publisherPublicKey, genesis = vector.genesis) {
  return loadSharedObserverConfig({ NODE_ENV: 'production', SOURCE_BASE_URL: 'https://source.example/',
    DATABASE_URL: databaseUrl, OBSERVER_SCHEMA: 'observer_compact_witness', CRON_SECRET: 'x'.repeat(32),
    REGISTRY_SOURCE_API_KEY: 'k'.repeat(32),
    REGISTRY_PUBLISHER_PUBLIC_KEY: publisherPublicKey,
    REGISTRY_SIGNED_GENESIS: encoded(genesis) })
}

function source(head = vector.headTwo, proof: string[] = []) {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(input)
    calls.push(url.pathname)
    let envelope: unknown
    if (url.pathname.endsWith('/head')) {
      envelope = { version: 1, signedCheckpoint: encoded(head),
        checkpointHash: await authority.registryCheckpointHash(head.statement) }
    } else if (url.pathname.endsWith('/consistency')) {
      envelope = { version: 1, old: url.searchParams.get('old'),
        target: url.searchParams.get('target'), proof }
    } else throw new Error(`Unexpected non-registry request: ${url.pathname}`)
    return new Response(authority.canonicalJson(envelope), { status: 200 })
  }))
  return calls
}

describe('compact shared registry witness', () => {
  beforeAll(async () => {
    await inspector.query(`CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${runtimePassword}'`)
  })
  beforeEach(async () => {
    await inspector.query('DROP SCHEMA observer_compact_witness CASCADE')
    await inspector.query('CREATE SCHEMA observer_compact_witness')
  })
  afterEach(async () => {
    await closeRuntimeObserverStore()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })
  afterAll(async () => {
    await inspector.query(`DROP OWNED BY ${runtimeRole}`)
    await inspector.query(`DROP ROLE ${runtimeRole}`)
    await inspector.end()
  })

  it('accepts a latest signed root without downloading registry entries or any workspace feed', async () => {
    const calls = source()
    const signer = await authority.generateSigningKey()
    const store = openObserverStore(databaseUrl, 'observer_compact_witness')
    try {
      await installObserverSchema(store)
      const result = await pollRegistryWitnessOnce(store, config(), signer)
      expect(result.status).toBe('accepted')
      expect(calls).toEqual(['/api/governance/v1/registry/head',
        '/api/governance/v1/registry/consistency'])
      expect((await inspector.query(
        'SELECT accepted_size FROM observer_compact_witness.observer_witness_cursor')).rows)
        .toEqual([{ accepted_size: String(vector.headTwo.statement.size) }])
      expect(result.report).toBeDefined()
      expect(await authority.verifyRegistryWitness(result.report!, vector.genesis, [],
        signer.publicKey, await authority.importSigningPublicKey(vector.publisherPublicKey))).toBe(true)
      const second = await pollRegistryWitnessOnce(store, config(), signer)
      expect(second.status).toBe('up_to_date')
      expect(second.report).toBeDefined()
      expect(calls.at(-1)).toBe('/api/governance/v1/registry/head')
      vi.stubEnv('DATABASE_URL', databaseUrl)
      vi.stubEnv('OBSERVER_SCHEMA', 'observer_compact_witness')
      vi.stubEnv('REGISTRY_PUBLISHER_PUBLIC_KEY', vector.publisherPublicKey)
      vi.stubEnv('REGISTRY_SIGNED_GENESIS', encoded(vector.genesis))
      vi.stubEnv('OBSERVER_SIGNING_PUBLIC_KEY', await authority.exportSigningPublicKey(signer.publicKey))
      vi.stubEnv('OBSERVER_SIGNING_PRIVATE_KEY', await authority.exportSigningPrivateKey(signer.privateKey))
      vi.stubEnv('SOURCE_BASE_URL', 'https://source.example/')
      vi.stubEnv('REGISTRY_SOURCE_API_KEY', 'k'.repeat(32))
      vi.stubEnv('CRON_SECRET', 'x'.repeat(32))
      const published = await latestWitness()
      expect(published.status).toBe(200)
      expect((await published.json()).report.statement.registryCheckpointHash)
        .toBe(await authority.registryCheckpointHash(vector.headTwo.statement))
      expect((await pollWitness(new Request('https://observer.example/api/registry-witness/poll'))).status)
        .toBe(401)
      const manual = await pollWitness(new Request('https://observer.example/api/registry-witness/poll',
        { headers: { authorization: `Bearer ${'x'.repeat(32)}` } }))
      expect(manual.status).toBe(200)
      expect((await manual.json()).version).toBe(2)
    } finally { await store.close() }
  })

  it('serves requests without access to migration metadata', async () => {
    const signer = await authority.generateSigningKey()
    const store = openObserverStore(databaseUrl, 'observer_compact_witness')
    try {
      await installObserverSchema(store)
      source(vector.headOne)
      expect((await pollRegistryWitnessOnce(store, config(), signer)).status).toBe('accepted')
    } finally { await store.close() }

    await inspector.query(`GRANT USAGE ON SCHEMA observer_compact_witness TO ${runtimeRole}`)
    await inspector.query(`GRANT SELECT, INSERT, UPDATE ON
      observer_compact_witness.observer_witness_cursor,
      observer_compact_witness.observer_witness_reports,
      observer_compact_witness.observer_witness_findings TO ${runtimeRole}`)
    await inspector.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA observer_compact_witness TO ${runtimeRole}`)

    vi.stubEnv('DATABASE_URL', runtimeDatabaseUrl())
    vi.stubEnv('OBSERVER_SCHEMA', 'observer_compact_witness')
    vi.stubEnv('REGISTRY_PUBLISHER_PUBLIC_KEY', vector.publisherPublicKey)
    vi.stubEnv('REGISTRY_SIGNED_GENESIS', encoded(vector.genesis))
    vi.stubEnv('OBSERVER_SIGNING_PUBLIC_KEY', await authority.exportSigningPublicKey(signer.publicKey))
    vi.stubEnv('OBSERVER_SIGNING_PRIVATE_KEY', await authority.exportSigningPrivateKey(signer.privateKey))
    vi.stubEnv('SOURCE_BASE_URL', 'https://source.example/')
    vi.stubEnv('REGISTRY_SOURCE_API_KEY', 'k'.repeat(32))
    vi.stubEnv('CRON_SECRET', 'x'.repeat(32))
    source(vector.headOne)

    expect((await latestWitness()).status).toBe(200)
    const polled = await pollWitness(new Request('https://observer.example/api/registry-witness/poll',
      { headers: { authorization: `Bearer ${'x'.repeat(32)}` } }))
    expect(polled.status).toBe(200)
    expect((await polled.json()).status).toBe('up_to_date')
  })

  it('retains the prior root through an invalid extension and source outage', async () => {
    const signer = await authority.generateSigningKey()
    const store = openObserverStore(databaseUrl, 'observer_compact_witness')
    try {
      await installObserverSchema(store)
      source(vector.headOne)
      expect((await pollRegistryWitnessOnce(store, config(), signer)).status).toBe('accepted')
      source(vector.headTwo, [])
      const rejected = await pollRegistryWitnessOnce(store, config(), signer)
      expect(rejected.status).toBe('source_nonconforming')
      expect(rejected.report?.statement.unresolvedFindings.count).toBe(1)
      expect((await inspector.query(
        'SELECT count(*)::integer AS count FROM observer_compact_witness.observer_witness_findings')).rows[0].count)
        .toBe(1)
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
      expect((await pollRegistryWitnessOnce(store, config(), signer)).status).toBe('unavailable')
      const retained = await inspector.query(
        'SELECT accepted_hash FROM observer_compact_witness.observer_witness_cursor')
      expect(retained.rows[0].accepted_hash)
        .toBe(await authority.registryCheckpointHash(vector.headOne.statement))
      source(vector.headTwo, vector.proofTwo)
      const recovered = await pollRegistryWitnessOnce(store, config(), signer)
      expect(recovered.status).toBe('accepted')
      expect(recovered.report?.statement.unresolvedFindings.count).toBe(0)
    } finally { await store.close() }
  })

  it('accepts a valid new signature over the same checkpoint statement', async () => {
    const publisher = await authority.generateSigningKey()
    const signer = await authority.generateSigningKey()
    const statement = { version: 1 as const, size: 0, root: await authority.merkleRoot([]),
      signerKeyId: await authority.signingKeyId(publisher.publicKey), previous: null }
    const genesis = await authority.signRegistryCheckpoint(statement, publisher)
    const resigned = await authority.signRegistryCheckpoint(statement, publisher)
    expect(resigned.signature).not.toBe(genesis.signature)
    const store = openObserverStore(databaseUrl, 'observer_compact_witness')
    try {
      await installObserverSchema(store)
      source(resigned)
      const result = await pollRegistryWitnessOnce(store,
        config(await authority.exportSigningPublicKey(publisher.publicKey), genesis), signer)
      expect(result.status).toBe('up_to_date')
      expect(result.report?.statement.unresolvedFindings.count).toBe(0)
    } finally { await store.close() }
  })

  it('fences a report snapshot when a new finding is committed', async () => {
    const signer = await authority.generateSigningKey()
    const store = openObserverStore(databaseUrl, 'observer_compact_witness')
    try {
      await installObserverSchema(store)
      const pin = await verifyRegistryPin(config())
      source(vector.genesis)
      expect((await pollRegistryWitnessOnce(store, config(), signer)).status).toBe('up_to_date')
      const cursor = await readWitnessCursor(store, pin)
      const stale = await authority.signRegistryWitness(cursor.accepted, cursor.accepted, [], [],
        new Date().toISOString(), signer, pin.publisherKey)
      await recordWitnessFinding(store, { version: 2, kind: 'registry_source_protocol',
        acceptedHash: cursor.acceptedHash, error: 'SourceProtocolError' })
      expect(await acceptRegistryWitness(store, cursor, cursor.accepted, cursor.acceptedHash,
        stale, 'a'.repeat(64))).toBe(false)
      await expect(readLatestRegistryWitness(store, pin, signer.publicKey)).rejects.toThrow(/invalid/i)
      const refreshed = await pollRegistryWitnessOnce(store, config(), signer)
      expect(refreshed.report?.statement.unresolvedFindings.count).toBe(1)
    } finally { await store.close() }
  })

  it('retains a bounded exact finding for a large invalid signed head', async () => {
    const signer = await authority.generateSigningKey()
    const store = openObserverStore(databaseUrl, 'observer_compact_witness')
    try {
      await installObserverSchema(store)
      source({ ...vector.genesis, signature: 'a'.repeat(30_000) })
      const result = await pollRegistryWitnessOnce(store, config(), signer)
      expect(result.status).toBe('source_nonconforming')
      const finding = await inspector.query(
        'SELECT evidence_bytes FROM observer_compact_witness.observer_witness_findings')
      expect(finding.rows[0].evidence_bytes.length).toBeGreaterThan(16_384)
    } finally { await store.close() }
  })
})
