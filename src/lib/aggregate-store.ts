import { createHash } from 'node:crypto'
import { aggregateFeedStatusProof, canonicalBytes, observerFindingHash,
  parseCanonical, signAggregateReport, signingKeyId,
  verifyAggregateFeedStatus, verifyAggregateReport,
  type AggregateFeedStatusProof, type GovernanceReplaySnapshot,
  type RegistryReplaySnapshot, type SignedAggregateReport } from '@drvillo/1bridge-authority'
import { verifyRegistryPin, type SharedObserverConfig, type SharedReportReadConfig } from './config'
import { readRegistryFeeds } from './registry-store'
import { readAcceptedObserverReplay, transaction, type ObserverStore } from './store'
import type { PoolClient } from 'pg'

const HASH = /^[0-9a-f]{64}$/

export interface StoredAggregateReport {
  reportHash: string
  signedReport: SignedAggregateReport
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function findingHashes(client: PoolClient): Promise<string[]> {
  const findings = await client.query<{ evidence_bytes: Buffer }>(
    `SELECT evidence_bytes FROM observer_registry_findings WHERE resolved_at IS NULL
     UNION ALL SELECT evidence_bytes FROM observer_findings WHERE resolved_at IS NULL`)
  return [...new Set(await Promise.all(findings.rows.map(row =>
    observerFindingHash(new Uint8Array(row.evidence_bytes)))))].sort()
}

/** Signs exact registry coverage and retains the inputs needed for later compact status proofs. */
export async function publishAggregateCoverage(store: ObserverStore, config: SharedObserverConfig,
  signer: CryptoKeyPair): Promise<StoredAggregateReport> {
  const pin = await verifyRegistryPin(config)
  const registry = await readRegistryFeeds(store, pin.publisherKey)
  const verified: GovernanceReplaySnapshot[] = []
  for (const feed of registry.feeds) {
    if (!feed.advertisedHead) continue
    const accepted = await readAcceptedObserverReplay(store, feed.feedId)
    if (accepted && accepted.checkpointHash === feed.advertisedHead.checkpointHash
      && accepted.anchorPin === feed.anchorPin) verified.push(accepted)
  }
  const registryBytes = canonicalBytes(registry.snapshot)
  const verifiedBytes = canonicalBytes(verified)
  if (registryBytes.length > 32 * 1024 * 1024 || verifiedBytes.length > 32 * 1024 * 1024) {
    throw new RangeError('Aggregate report storage budget exceeded')
  }
  const observerKeyId = await signingKeyId(signer.publicKey)
  return transaction(store, async client => {
    const cursor = await client.query<{ accepted_hash: string }>(
      'SELECT accepted_hash FROM observer_registry_cursor WHERE singleton=1 FOR SHARE')
    if (cursor.rows[0]?.accepted_hash !== registry.snapshot.checkpointHash) {
      throw new TypeError('Registry head advanced during aggregate signing')
    }
    await client.query(
      'LOCK TABLE observer_cursors, observer_feeds, observer_registry_findings, observer_findings IN SHARE MODE')
    const ids = registry.feeds.map(feed => feed.feedId)
    const current = await client.query<{ feed_id: string; accepted_checkpoint_hash: string | null;
      anchor_pin: string }>(
      `SELECT c.feed_id, c.accepted_checkpoint_hash, f.anchor_pin FROM observer_cursors c
       JOIN observer_feeds f ON f.feed_id=c.feed_id WHERE c.feed_id = ANY($1::text[])
       ORDER BY c.feed_id FOR SHARE OF c, f`, [ids])
    const state = new Map(current.rows.map(row => [row.feed_id, row]))
    const verifiedIds = new Set(verified.map(feed => feed.feedId))
    for (const feed of registry.feeds) {
      const row = state.get(feed.feedId)
      const isAccepted = Boolean(feed.advertisedHead && row
        && row.accepted_checkpoint_hash === feed.advertisedHead.checkpointHash
        && row.anchor_pin === feed.anchorPin)
      if (isAccepted !== verifiedIds.has(feed.feedId)) {
        throw new TypeError('Feed coverage advanced during aggregate signing')
      }
    }
    const findings = await findingHashes(client)
    const signedReport = await signAggregateReport(registry.snapshot, registry.signedHead,
      verified, findings, new Date().toISOString(), signer)
    const reportBytes = canonicalBytes(signedReport)
    if (reportBytes.length > 16_384) throw new RangeError('Aggregate report storage budget exceeded')
    const reportHash = digest(reportBytes)
    await client.query(
      `INSERT INTO observer_aggregate_reports(report_hash, registry_hash,
         observer_key_id, signed_report, registry_snapshot, verified_snapshots)
       VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (report_hash) DO NOTHING`,
      [reportHash, registry.snapshot.checkpointHash, observerKeyId,
        Buffer.from(reportBytes), Buffer.from(registryBytes), Buffer.from(verifiedBytes)])
    return { reportHash, signedReport }
  })
}

interface StoredRow {
  report_hash: string
  registry_hash: string
  signed_report: Buffer
  registry_snapshot: Buffer
  verified_snapshots: Buffer
}

async function readReport(store: ObserverStore, config: SharedReportReadConfig,
  observerKey: CryptoKey, reportHash?: string): Promise<{
  report: StoredAggregateReport
  registry: RegistryReplaySnapshot
  verified: GovernanceReplaySnapshot[]
} | null> {
  const pin = await verifyRegistryPin(config)
  const row = await transaction(store, client => client.query<StoredRow>(reportHash
    ? `SELECT report_hash, registry_hash, signed_report, registry_snapshot,
              verified_snapshots FROM observer_aggregate_reports WHERE report_hash=$1`
    : `SELECT report_hash, registry_hash, signed_report, registry_snapshot,
              verified_snapshots FROM observer_aggregate_reports
       ORDER BY created_at DESC, report_hash DESC LIMIT 1`, reportHash ? [reportHash] : []))
  const stored = row.rows[0]
  if (!stored) return null
  if (digest(stored.signed_report) !== stored.report_hash) {
    throw new TypeError('Stored aggregate report hash mismatch')
  }
  const signedReport = parseCanonical(stored.signed_report) as unknown as SignedAggregateReport
  if (!await verifyAggregateReport(signedReport, observerKey, pin.publisherKey, stored.registry_hash)) {
    throw new TypeError('Stored aggregate report fails pinned verification')
  }
  const registry = parseCanonical(stored.registry_snapshot) as unknown as RegistryReplaySnapshot
  const verified = parseCanonical(stored.verified_snapshots) as unknown as GovernanceReplaySnapshot[]
  if (registry.checkpointHash !== stored.registry_hash || !Array.isArray(verified)) {
    throw new TypeError('Stored aggregate context differs from report')
  }
  return { report: { reportHash: stored.report_hash, signedReport }, registry, verified }
}

export async function readLatestAggregateCoverage(store: ObserverStore,
  config: SharedReportReadConfig, observerKey: CryptoKey): Promise<StoredAggregateReport | null> {
  return (await readReport(store, config, observerKey))?.report ?? null
}

export async function readAggregateFeedStatusProof(store: ObserverStore,
  config: SharedReportReadConfig, observerKey: CryptoKey, reportHash: string,
  feedId: string): Promise<AggregateFeedStatusProof | null> {
  if (!HASH.test(reportHash) || !HASH.test(feedId)) throw new TypeError('Invalid aggregate proof request')
  const stored = await readReport(store, config, observerKey, reportHash)
  if (!stored) return null
  const proof = await aggregateFeedStatusProof(stored.registry, stored.verified, feedId)
  const pin = await verifyRegistryPin(config)
  if (!await verifyAggregateFeedStatus(stored.report.signedReport, proof,
    observerKey, pin.publisherKey, stored.registry.checkpointHash,
    proof.status.feedId, proof.status.anchorPin)) {
    throw new TypeError('Stored aggregate status proof does not match signed report')
  }
  return proof
}
