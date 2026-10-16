import { canonicalBytes, observerEvidenceSetDigest, parseCanonical, registryCheckpointHash, signingKeyId,
  verifyRegistryCheckpoint, verifyRegistryWitness,
  type SignedRegistryCheckpoint, type SignedRegistryWitness,
} from '@drvillo/1bridge-authority'
import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { ObserverStore } from './store'
import { transaction } from './store'

export interface WitnessCursor {
  acceptedHash: string
  acceptedSize: number
  accepted: SignedRegistryCheckpoint
  version: number
}

const RESOLVABLE_KINDS = ['registry_consistency_protocol', 'registry_invalid_extension']

async function activeFindingHashes(client: PoolClient, resolvingTarget?: string): Promise<string[]> {
  const result = await client.query<{ finding_hash: string }>(
    `SELECT finding_hash FROM observer_witness_findings WHERE resolved_at IS NULL
      AND ($1::text IS NULL OR target_hash IS DISTINCT FROM $1 OR finding_kind <> ALL($2::text[]))
      ORDER BY finding_hash`,
    [resolvingTarget ?? null, resolvingTarget ? RESOLVABLE_KINDS : []])
  if (result.rows.length > 10_000) throw new RangeError('Observer unresolved finding limit reached')
  return result.rows.map(row => row.finding_hash)
}

async function matchesFindings(report: SignedRegistryWitness, hashes: string[]): Promise<boolean> {
  const expected = report.statement.unresolvedFindings
  return expected.count === hashes.length
    && expected.digest === (hashes.length ? await observerEvidenceSetDigest(hashes) : null)
}

function count(value: string): number {
  const number = Number(value)
  if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(number)) {
    throw new TypeError('Invalid retained witness counter')
  }
  return number
}

export async function readWitnessCursor(store: ObserverStore, pin: {
  publisherKey: CryptoKey; signedGenesis: SignedRegistryCheckpoint; genesisHash: string
}): Promise<WitnessCursor> {
  const publisherKeyId = await signingKeyId(pin.publisherKey)
  const genesisBytes = Buffer.from(canonicalBytes(pin.signedGenesis))
  return transaction(store, async client => {
    await client.query(`INSERT INTO observer_witness_cursor
      (publisher_key_id, genesis_hash, signed_genesis, accepted_hash, accepted_size, signed_accepted)
      VALUES ($1,$2,$3,$2,0,$3) ON CONFLICT (singleton) DO NOTHING`,
    [publisherKeyId, pin.genesisHash, genesisBytes])
    const result = await client.query<{
      publisher_key_id: string; genesis_hash: string; signed_genesis: Buffer;
      accepted_hash: string; accepted_size: string; signed_accepted: Buffer; version: string
    }>('SELECT * FROM observer_witness_cursor WHERE singleton=1')
    const row = result.rows[0]
    if (!row || row.publisher_key_id !== publisherKeyId || row.genesis_hash !== pin.genesisHash
      || !row.signed_genesis.equals(genesisBytes)) throw new TypeError('Witness trust pin changed')
    const accepted = parseCanonical(row.signed_accepted) as unknown as SignedRegistryCheckpoint
    const acceptedSize = count(row.accepted_size)
    if (accepted.statement.size !== acceptedSize
      || await registryCheckpointHash(accepted.statement) !== row.accepted_hash
      || !await verifyRegistryCheckpoint(accepted, pin.publisherKey)) {
      throw new TypeError('Retained registry witness head is invalid')
    }
    return { acceptedHash: row.accepted_hash, acceptedSize, accepted, version: count(row.version) }
  })
}

/** Compare-and-swap keeps an older concurrent poll from overwriting a newer accepted root. */
export async function acceptRegistryWitness(store: ObserverStore, cursor: WitnessCursor,
  target: SignedRegistryCheckpoint, targetHash: string, report: SignedRegistryWitness,
  reportHash: string): Promise<boolean> {
  const acceptedBytes = Buffer.from(canonicalBytes(target))
  const reportBytes = Buffer.from(canonicalBytes(report))
  return transaction(store, async client => {
    const advances = targetHash !== cursor.acceptedHash
    const updated = await client.query(`UPDATE observer_witness_cursor
      SET accepted_hash=$1, accepted_size=$2, signed_accepted=$3, version=version+1
      WHERE singleton=1 AND accepted_hash=$4 AND version=$5`,
    [targetHash, target.statement.size, acceptedBytes, cursor.acceptedHash, cursor.version])
    if (updated.rowCount !== 1) return false
    const hashes = await activeFindingHashes(client, advances ? targetHash : undefined)
    if (!await matchesFindings(report, hashes)) throw new TypeError('Witness report omits active findings')
    if (advances) await client.query(`UPDATE observer_witness_findings SET resolved_at=clock_timestamp()
      WHERE target_hash=$1 AND finding_kind = ANY($2::text[]) AND resolved_at IS NULL`,
    [targetHash, RESOLVABLE_KINDS])
    await client.query(`INSERT INTO observer_witness_reports
      (report_hash, accepted_hash, signed_report, checked_at) VALUES($1,$2,$3,$4)`,
    [reportHash, targetHash, reportBytes, report.statement.checkedAt])
    return true
  })
}

export async function readLatestRegistryWitness(store: ObserverStore, pin: {
  publisherKey: CryptoKey; signedGenesis: SignedRegistryCheckpoint; genesisHash: string
}, observerKey: CryptoKey): Promise<{ report: SignedRegistryWitness; reportHash: string } | null> {
  const cursor = await readWitnessCursor(store, pin)
  return transaction(store, async client => {
    const result = await client.query<{ report_hash: string; accepted_hash: string; signed_report: Buffer }>(
      `SELECT report_hash, accepted_hash, signed_report FROM observer_witness_reports
       ORDER BY report_sequence DESC LIMIT 1`)
    const row = result.rows[0]
    if (!row) return null
    const report = parseCanonical(row.signed_report) as unknown as SignedRegistryWitness
    const digest = createHash('sha256').update(row.signed_report).digest('hex')
    if (digest !== row.report_hash || row.accepted_hash !== cursor.acceptedHash
      || report.statement.registryCheckpointHash !== cursor.acceptedHash
      || !await matchesFindings(report, await activeFindingHashes(client))
      || !await verifyRegistryWitness(report, pin.signedGenesis, [], observerKey, pin.publisherKey)) {
      throw new TypeError('Retained witness report is invalid')
    }
    return { report, reportHash: row.report_hash }
  })
}

export async function recordWitnessFinding(store: ObserverStore,
  evidence: { kind: string; [key: string]: unknown }, targetHash?: string): Promise<string> {
  const bytes = Buffer.from(canonicalBytes(evidence))
  if (bytes.length > 98_304) throw new RangeError('Witness finding exceeds evidence limit')
  const hash = createHash('sha256').update(bytes).digest('hex')
  await transaction(store, async client => {
    await client.query('SELECT version FROM observer_witness_cursor WHERE singleton=1 FOR UPDATE')
    const inserted = await client.query(`INSERT INTO observer_witness_findings
      (finding_hash, finding_kind, target_hash, evidence_bytes)
      VALUES($1,$2,$3,$4)
      ON CONFLICT (finding_hash) DO UPDATE SET resolved_at=NULL
        WHERE observer_witness_findings.resolved_at IS NOT NULL
      RETURNING finding_hash`,
    [hash, evidence.kind, targetHash ?? null, bytes])
    if (inserted.rowCount === 1) {
      await client.query('UPDATE observer_witness_cursor SET version=version+1 WHERE singleton=1')
    }
  })
  return hash
}

export async function readWitnessFindings(store: ObserverStore, resolvingTarget?: string): Promise<string[]> {
  return transaction(store, async client => {
    return activeFindingHashes(client, resolvingTarget)
  })
}
