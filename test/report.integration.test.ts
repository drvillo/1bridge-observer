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
    expect(typeof exports.reconcileRetainedReceipts).toBe('function')
    const reconcile = exports.reconcileRetainedReceipts as (store: observerStore.ObserverStore,
      feedId: string, receipts: authority.CompletionReceipt[]) => Promise<string[]>
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
      expect(await reconcile(store, feedId, [history.firstReceipt, history.secondReceipt]))
        .toEqual(['pending', 'pending'])
      expect(await publish(store, feedId, signer)).toBeNull()
      expect((await pollObserverOnce(store, config, 'report-worker',
        { maxLeafPages: 16, maxCheckpoints: 16, maxMs: 20_000 })).status).toBe('accepted')
      const knownHashes = await Promise.all([history.firstReceipt, history.secondReceipt]
        .map(receipt => authority.completionReceiptHash(receipt)))
      for (const receipt of [history.firstReceipt, history.secondReceipt]) {
        expect((await observerStore.retainKnownReceipt(store, feedId, receipt)).inserted).toBe(true)
      }
      const report = await publish(store, feedId, signer)
      expect(report).not.toBeNull()
      expect(report!.statement).toMatchObject({ feedId, anchorPin: history.anchorPin,
        coverageScope: 'verified_prefix', knownReceipts: { kind: 'known_archive', count: 2,
          digest: await authority.observerEvidenceSetDigest(knownHashes.sort()) },
        unresolvedFindings: { count: 0, digest: null } })
      expect(await authority.verifyObserverReport(report!, signer.publicKey,
        { feedId, anchorPin: history.anchorPin })).toBe(true)
      expect(await publish(store, feedId, signer)).toEqual(report)
      expect((await inspector.query('SELECT count(*) AS total FROM observer_report.observer_reports')).rows[0].total).toBe('1')
      expect(await reconcile(store, feedId, [history.firstReceipt, history.secondReceipt,
        { ...history.secondReceipt, checkpoint: history.wrongRoot },
        { ...history.firstReceipt, leafHash: '0'.repeat(64) }]))
        .toEqual(['matched', 'matched', 'unmatched', 'unmatched'])
      const mutableReceipt = structuredClone(history.secondReceipt)
      const checkingSnapshot = reconcile(store, feedId, [history.firstReceipt, mutableReceipt])
      mutableReceipt.leafHash = '0'.repeat(64)
      expect(await checkingSnapshot).toEqual(['matched', 'matched'])

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

  it('keeps a later signed receipt pending even when its leaf index is already covered', async () => {
    const history = await buildGovernanceSource()
    const source = await startGovernanceSource(history)
    const store = observerStore.openObserverStore(databaseUrl, 'observer_receipt_partial')
    const signer = await authority.generateSigningKey()
    const feedId = history.signedAnchor.anchor.feedId
    const config: ObserverConfig = { sourceBaseUrl: source.baseUrl, feedId,
      anchorPin: history.anchorPin,
      signedAnchor: authority.encodeBase64Url(authority.canonicalBytes(history.signedAnchor)),
      databaseUrl, databaseSchema: 'observer_receipt_partial', cronSecret: 'x'.repeat(32) }
    const futureReceipt = { ...history.firstReceipt,
      checkpoint: history.checkpoints.at(-1)!,
      inclusionProof: await authority.inclusionProof(history.leaves, history.firstReceipt.leafIndex) }
    expect(await authority.verifyReceiptInclusion(futureReceipt,
      history.leaves[futureReceipt.leafIndex]!, futureReceipt.checkpoint)).toBe(true)
    const otherFeed = { ...history.secondReceipt, feedId: '9'.repeat(64),
      checkpoint: { ...history.secondReceipt.checkpoint,
        statement: { ...history.secondReceipt.checkpoint.statement, feedId: '9'.repeat(64) } } }
    try {
      await observerStore.installObserverSchema(store)
      await observerStore.registerObserverFeed(store, config)
      const head = history.checkpoints[2]!
      const lease = await observerStore.claimObserverLease(store, feedId, 'partial-worker', 30_000)
      expect(lease).not.toBeNull()
      const target = await observerStore.beginObserverTarget(store, lease!, {
        provisional: true, checkpointHash: await authority.checkpointHash(head.statement),
        signedCheckpoint: head, signedCheckpointBytes: authority.canonicalBytes(head) })
      const checkpoints = await Promise.all(history.checkpoints.slice(0, 3).map(async signed => ({
        bytes: authority.canonicalBytes(signed), signed, hash: await authority.checkpointHash(signed.statement) })))
      const staged = await observerStore.stageObserverBatch(store, target,
        { start: 0, leaves: history.leaves.slice(0, 2), checkpoints })
      expect((await observerStore.acceptObserverTarget(store, staged.claim)).size).toBe(2)
      await observerStore.releaseObserverLease(store, lease!)
      expect(await observerStore.reconcileRetainedReceipts(store, feedId, [futureReceipt, otherFeed]))
        .toEqual(['pending', 'unmatched'])
      const receiptHash = await authority.completionReceiptHash(futureReceipt)
      expect((await observerStore.retainKnownReceipt(store, feedId, futureReceipt)).inserted).toBe(true)
      const partial = await observerStore.publishObserverCoverage(store, feedId, signer)
      expect(partial!.statement.knownReceipts).toEqual({ kind: 'known_archive', count: 1,
        digest: await authority.observerEvidenceSetDigest([receiptHash]) })
      const unresolvedHash = await authority.observerFindingHash(authority.canonicalBytes({ version: 1,
        kind: 'observer.known_receipt_unresolved', feedId, receiptHash, status: 'pending',
        coveredCheckpointHash: await authority.checkpointHash(head.statement) }))
      expect(partial!.statement.unresolvedFindings).toEqual({ count: 1,
        digest: await authority.observerEvidenceSetDigest([unresolvedHash]) })
      expect((await pollObserverOnce(store, config, 'full-worker',
        { maxLeafPages: 16, maxCheckpoints: 16, maxMs: 20_000 })).status).toBe('accepted')
      expect(await observerStore.reconcileRetainedReceipts(store, feedId, [futureReceipt]))
        .toEqual(['matched'])
      const full = await observerStore.publishObserverCoverage(store, feedId, signer)
      expect(full!.statement.knownReceipts).toEqual(partial!.statement.knownReceipts)
      expect(full!.statement.unresolvedFindings).toEqual({ count: 0, digest: null })
      const contradictory = { ...history.secondReceipt, checkpoint: history.wrongRoot }
      const contradictoryHash = await authority.completionReceiptHash(contradictory)
      expect((await observerStore.retainKnownReceipt(store, feedId, contradictory)).inserted).toBe(true)
      const conflicted = await observerStore.publishObserverCoverage(store, feedId, signer)
      expect(conflicted!.statement.knownReceipts).toEqual({ kind: 'known_archive', count: 2,
        digest: await authority.observerEvidenceSetDigest([receiptHash, contradictoryHash].sort()) })
      const conflictHash = await authority.observerFindingHash(authority.canonicalBytes({ version: 1,
        kind: 'observer.known_receipt_unresolved', feedId, receiptHash: contradictoryHash,
        status: 'unmatched', coveredCheckpointHash: await authority.checkpointHash(history.checkpoints.at(-1)!.statement) }))
      expect(conflicted!.statement.unresolvedFindings).toEqual({ count: 1,
        digest: await authority.observerEvidenceSetDigest([conflictHash]) })
      await inspector.query(`INSERT INTO observer_receipt_partial.observer_findings
        (feed_id, finding_type, evidence_bytes)
        SELECT $1, 'source_nonconformance',
          convert_to(format('{"id":%s}', item), 'UTF8')
        FROM generate_series(1, 10000) AS item`, [feedId])
      await inspector.query(`UPDATE observer_receipt_partial.observer_cursors
        SET report_revision=report_revision+1 WHERE feed_id=$1`, [feedId])
      const crowded = await observerStore.publishObserverCoverage(store, feedId, signer)
      expect(crowded!.statement.unresolvedFindings.count).toBe(10_001)
      expect(await authority.verifyObserverReport(crowded!, signer.publicKey,
        { feedId, anchorPin: history.anchorPin })).toBe(true)
    } finally { await store.close(); await source.close() }
  })

  it('retains exact known receipt bytes once and advances the report revision only on insertion', async () => {
    const history = await buildGovernanceSource()
    const store = observerStore.openObserverStore(databaseUrl, 'observer_receipt_store')
    const feedId = history.signedAnchor.anchor.feedId
    const config: ObserverConfig = { sourceBaseUrl: 'https://source.example', feedId,
      anchorPin: history.anchorPin,
      signedAnchor: authority.encodeBase64Url(authority.canonicalBytes(history.signedAnchor)),
      databaseUrl, databaseSchema: 'observer_receipt_store', cronSecret: 'x'.repeat(32) }
    try {
      await observerStore.installObserverSchema(store)
      await observerStore.registerObserverFeed(store, config)
      const exports = observerStore as Record<string, unknown>
      expect(typeof exports.retainKnownReceipt).toBe('function')
      const retain = exports.retainKnownReceipt as (store: observerStore.ObserverStore,
        feedId: string, receipt: authority.CompletionReceipt) => Promise<{ receiptHash: string; inserted: boolean }>
      const firstHash = await authority.completionReceiptHash(history.firstReceipt)
      expect(await retain(store, feedId, history.firstReceipt)).toEqual({ receiptHash: firstHash, inserted: true })
      const first = await inspector.query<{ receipt_hash: string; leaf_index: string;
        checkpoint_hash: string; receipt_bytes: Buffer }>(
          'SELECT receipt_hash, leaf_index, checkpoint_hash, receipt_bytes FROM observer_receipt_store.observer_known_receipts')
      expect(first.rows).toHaveLength(1)
      expect(first.rows[0]).toMatchObject({ receipt_hash: firstHash,
        leaf_index: String(history.firstReceipt.leafIndex),
        checkpoint_hash: await authority.checkpointHash(history.firstReceipt.checkpoint.statement) })
      expect(first.rows[0]!.receipt_bytes).toEqual(Buffer.from(authority.canonicalBytes(history.firstReceipt)))
      expect((await inspector.query('SELECT report_revision FROM observer_receipt_store.observer_cursors')).rows[0].report_revision)
        .toBe('1')
      expect(await retain(store, feedId, history.firstReceipt)).toEqual({ receiptHash: firstHash, inserted: false })
      const mutable = structuredClone(history.secondReceipt)
      const retaining = retain(store, feedId, mutable)
      mutable.leafHash = '0'.repeat(64)
      expect(await retaining).toEqual({ receiptHash: await authority.completionReceiptHash(history.secondReceipt), inserted: true })
      const bytes = await inspector.query<{ receipt_bytes: Buffer }>(
        'SELECT receipt_bytes FROM observer_receipt_store.observer_known_receipts WHERE receipt_hash=$1',
        [await authority.completionReceiptHash(history.secondReceipt)])
      expect(bytes.rows[0]!.receipt_bytes).toEqual(Buffer.from(authority.canonicalBytes(history.secondReceipt)))
      await expect(retain(store, feedId, { ...history.firstReceipt, feedId: '9'.repeat(64),
        checkpoint: { ...history.firstReceipt.checkpoint,
          statement: { ...history.firstReceipt.checkpoint.statement, feedId: '9'.repeat(64) } } }))
        .rejects.toThrow(/feed/i)
      await expect(retain(store, feedId, { ...history.firstReceipt, leafHash: 'bad' }))
        .rejects.toThrow()
      expect((await inspector.query('SELECT count(*) AS total FROM observer_receipt_store.observer_known_receipts')).rows[0].total)
        .toBe('2')
      expect((await inspector.query('SELECT report_revision FROM observer_receipt_store.observer_cursors')).rows[0].report_revision)
        .toBe('2')
    } finally { await store.close() }
  })
})
