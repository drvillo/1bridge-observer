import { afterAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import * as authority from '@drvillo/1bridge-authority'
import * as observerStore from '../src/lib/store'
import { pollObserverOnce } from '../src/lib/poll'
import { buildGovernanceSource, startGovernanceSource } from './governance-source-fixture'
import type { ObserverConfig } from '../src/lib/config'

const databaseUrl = process.env.OBSERVER_TEST_DATABASE_URL
if (!databaseUrl) throw new Error('OBSERVER_TEST_DATABASE_URL must identify a disposable database')

describe('signed observer coverage', () => {
  const inspector = new pg.Pool({ connectionString: databaseUrl, max: 1 })
  afterAll(async () => { await inspector.end() })

  it('recovers after acceptance, signs a verified prefix and reuses the report for an unchanged cursor', async () => {
    const exports = observerStore as Record<string, unknown>
    expect(typeof exports.publishObserverCoverage).toBe('function')
    const publish = exports.publishObserverCoverage as (store: observerStore.ObserverStore, feedId: string,
      signer: CryptoKeyPair) => Promise<authority.SignedObserverReport | null>
    expect(typeof exports.readLatestObserverCoverage).toBe('function')
    const readLatest = exports.readLatestObserverCoverage as (store: observerStore.ObserverStore,
      feedId: string, trustedPin: string, trustedKey: CryptoKey) => Promise<authority.SignedObserverReport | null>
    const history = await buildGovernanceSource()
    const source = await startGovernanceSource(history)
    const store = observerStore.openObserverStore(databaseUrl, 'observer_report')
    const signer = await authority.generateSigningKey()
    const feedId = history.signedAnchor.anchor.feedId
    const config: ObserverConfig = { sourceBaseUrl: source.baseUrl, feedId,
      anchorPin: history.anchorPin,
      signedAnchor: authority.encodeBase64Url(authority.canonicalBytes(history.signedAnchor)),
      databaseUrl, databaseSchema: 'observer_report', cronSecret: 'x'.repeat(32) }
    try {
      await observerStore.installObserverSchema(store)
      await observerStore.registerObserverFeed(store, config)
      expect(await publish(store, feedId, signer)).toBeNull()
      expect((await pollObserverOnce(store, config, 'report-worker',
        { maxLeafPages: 16, maxCheckpoints: 16, maxMs: 20_000 })).status).toBe('accepted')
      const report = await publish(store, feedId, signer)
      expect(report).not.toBeNull()
      expect(report!.statement).toMatchObject({ feedId, anchorPin: history.anchorPin,
        coverageScope: 'verified_prefix', knownReceipts: { kind: 'none', count: 0, digest: null },
        unresolvedFindings: { count: 0, digest: null } })
      expect(await authority.verifyObserverReport(report!, signer.publicKey,
        { feedId, anchorPin: history.anchorPin })).toBe(true)
      expect(await publish(store, feedId, signer)).toEqual(report)
      expect((await inspector.query('SELECT count(*) AS total FROM observer_report.observer_reports')).rows[0].total).toBe('1')

      const stagingLease = await observerStore.claimObserverLease(store, feedId, 'staging-worker', 30_000)
      expect(stagingLease).not.toBeNull()
      const signedCheckpoint = history.checkpoints.at(-1)!
      await observerStore.beginObserverTarget(store, stagingLease!, {
        provisional: true, checkpointHash: await authority.checkpointHash(signedCheckpoint.statement),
        signedCheckpoint, signedCheckpointBytes: authority.canonicalBytes(signedCheckpoint) })
      await observerStore.releaseObserverLease(store, stagingLease!)
      expect(await publish(store, feedId, signer)).toEqual(report)
      expect((await inspector.query('SELECT count(*) AS total FROM observer_report.observer_reports')).rows[0].total).toBe('1')

      const lease = await observerStore.claimObserverLease(store, feedId, 'finding-worker', 30_000)
      expect(lease).not.toBeNull()
      await observerStore.recordObserverFinding(store, lease!, 'source_nonconformance',
        authority.canonicalBytes({ kind: 'test.conflict', feedId }))
      await observerStore.releaseObserverLease(store, lease!)
      const updated = await publish(store, feedId, signer)
      expect(updated!.statement.unresolvedFindings.count).toBe(1)
      expect(await authority.verifyObserverReport(updated!, signer.publicKey,
        { feedId, anchorPin: history.anchorPin })).toBe(true)
      expect((await inspector.query('SELECT count(*) AS total FROM observer_report.observer_reports')).rows[0].total).toBe('2')
      expect(await readLatest(store, feedId, history.anchorPin, signer.publicKey)).toEqual(updated)
      await expect(readLatest(store, feedId, 'a'.repeat(64), signer.publicKey))
        .rejects.toThrow(/pin mismatch/i)
      expect(await readLatest(store, feedId, history.anchorPin,
        (await authority.generateSigningKey()).publicKey)).toBeNull()
      const earlierHash = await authority.checkpointHash(history.checkpoints.at(-2)!.statement)
      await inspector.query(`UPDATE observer_report.observer_reports SET covered_checkpoint_hash=$1
        WHERE report_revision=(SELECT max(report_revision) FROM observer_report.observer_reports)`, [earlierHash])
      await expect(readLatest(store, feedId, history.anchorPin, signer.publicKey))
        .rejects.toThrow(/identity mismatch/i)
    } finally { await store.close(); await source.close() }
  })
})
