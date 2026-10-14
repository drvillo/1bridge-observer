import type { PoolClient } from 'pg'
import { canonicalBytes, checkpointHash, createRegistryReplaySession, hashLeaf, parseCanonical,
  registryCheckpointHash, registryEntryBytes, signingKeyId,
  verifyRegistryCheckpoint, verifyRegistryExtension,
  type Hash, type RegistryEntry, type RegistryReplaySnapshot,
  type SignedRegistryCheckpoint } from '@drvillo/1bridge-authority'
import type { RegistryHead, RegistryCheckpointItem } from './registry-source'
import type { ProvisionalFeedHead } from './source'
import { transaction, type ObserverStore } from './store'

const HASH = /^[0-9a-f]{64}$/
const MAX_LEASE_MS = 300_000

export interface RegistryPin {
  publisherKey: CryptoKey
  signedGenesis: SignedRegistryCheckpoint
  genesisHash: string
}
export interface RegistryLease {
  workerId: string
  epoch: number
  version: number
  expiresAt: Date
}
export interface RegistryProgress {
  acceptedSize: number
  acceptedHash: string
  acceptedCheckpointBytes: Uint8Array
  stagedNextIndex: number
  checkpointAfter: string
  target: RegistryHead | null
}

interface CursorRow {
  publisher_key_id: string
  genesis_hash: string
  signed_genesis: Buffer
  accepted_hash: string
  accepted_size: string
  target_hash: string | null
  target_size: string | null
  signed_target: Buffer | null
  staged_next_index: string
  staged_checkpoint_tail_hash: string | null
  version: string
  lease_epoch: string
  lease_owner: string | null
  lease_valid: boolean
}

function number(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new TypeError('Invalid registry database counter')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new RangeError('Registry counter exceeds safe integer')
  return parsed
}

function validHash(value: unknown): value is Hash {
  return typeof value === 'string' && HASH.test(value)
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right))
}

function dense<T>(value: readonly T[], maximum: number): T[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < 1 || value.length > maximum
    || Reflect.ownKeys(value).length !== value.length + 1) {
    throw new TypeError('Expected bounded nonempty registry page')
  }
  const copy: T[] = []
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('Expected registry page data item')
    }
    copy.push(descriptor.value)
  }
  return copy
}

async function locked(client: PoolClient, lease: RegistryLease): Promise<CursorRow> {
  if (!lease || typeof lease.workerId !== 'string' || lease.workerId.length < 1
    || lease.workerId.length > 256 || !Number.isSafeInteger(lease.epoch)
    || !Number.isSafeInteger(lease.version)) throw new TypeError('Invalid registry lease')
  const result = await client.query<CursorRow>(
    `SELECT publisher_key_id, genesis_hash, signed_genesis, accepted_hash,
            accepted_size, target_hash, target_size, signed_target,
            staged_next_index, staged_checkpoint_tail_hash, version,
            lease_epoch, lease_owner, lease_until > clock_timestamp() AS lease_valid
       FROM observer_registry_cursor WHERE singleton=1 FOR UPDATE`)
  const row = result.rows[0]
  if (!row || row.lease_owner !== lease.workerId || !row.lease_valid
    || number(row.lease_epoch) !== lease.epoch || number(row.version) !== lease.version) {
    throw new TypeError('Stale registry lease')
  }
  return row
}

function nextLease(lease: RegistryLease): RegistryLease {
  if (lease.version >= Number.MAX_SAFE_INTEGER) throw new RangeError('Registry version overflow')
  return { ...lease, version: lease.version + 1 }
}

/** Pins the publisher and exact signed genesis in observer-owned storage. */
export async function initializeRegistry(store: ObserverStore, pin: RegistryPin): Promise<void> {
  if (!pin || !validHash(pin.genesisHash)
    || pin.signedGenesis.statement.size !== 0
    || await registryCheckpointHash(pin.signedGenesis.statement) !== pin.genesisHash
    || !await verifyRegistryCheckpoint(pin.signedGenesis, pin.publisherKey)) {
    throw new TypeError('Invalid pinned registry genesis')
  }
  const bytes = Buffer.from(canonicalBytes(pin.signedGenesis))
  if (bytes.length > 16_384) throw new RangeError('Registry genesis exceeds storage limit')
  const publisherId = await signingKeyId(pin.publisherKey)
  await transaction(store, async client => {
    await client.query(
      `INSERT INTO observer_registry_cursor(publisher_key_id, genesis_hash, signed_genesis, accepted_hash)
       VALUES($1,$2,$3,$2) ON CONFLICT (singleton) DO NOTHING`,
      [publisherId, pin.genesisHash, bytes])
    const cursor = await client.query<{ publisher_key_id: string; genesis_hash: string; signed_genesis: Buffer }>(
      'SELECT publisher_key_id, genesis_hash, signed_genesis FROM observer_registry_cursor WHERE singleton=1 FOR UPDATE')
    const current = cursor.rows[0]
    if (!current || current.publisher_key_id !== publisherId
      || current.genesis_hash !== pin.genesisHash || !sameBytes(current.signed_genesis, bytes)) {
      throw new TypeError('Registry trust pin conflicts with retained database identity')
    }
    await client.query(
      `INSERT INTO observer_registry_checkpoints(position, statement_hash, checkpoint_size,
         previous_hash, signed_checkpoint, consistency_proof)
       VALUES(0,$1,0,NULL,$2,'[]'::jsonb) ON CONFLICT (position) DO NOTHING`,
      [pin.genesisHash, bytes])
    const checkpoint = await client.query<{ statement_hash: string; signed_checkpoint: Buffer }>(
      'SELECT statement_hash, signed_checkpoint FROM observer_registry_checkpoints WHERE position=0')
    if (checkpoint.rows.length !== 1 || checkpoint.rows[0]!.statement_hash !== pin.genesisHash
      || !sameBytes(checkpoint.rows[0]!.signed_checkpoint, bytes)) {
      throw new TypeError('Stored registry genesis conflicts with trust pin')
    }
  })
}

export async function claimRegistryLease(store: ObserverStore, workerId: string,
  durationMs: number): Promise<RegistryLease | null> {
  if (typeof workerId !== 'string' || workerId.length < 1 || workerId.length > 256
    || !Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > MAX_LEASE_MS) {
    throw new TypeError('Invalid registry lease request')
  }
  const result = await transaction(store, client => client.query<{
    version: string; lease_epoch: string; lease_until: Date
  }>(`UPDATE observer_registry_cursor
        SET lease_owner=$1, lease_until=clock_timestamp() + ($2::integer * interval '1 millisecond'),
            lease_epoch=lease_epoch+1
      WHERE singleton=1 AND (lease_until IS NULL OR lease_until <= clock_timestamp() OR lease_owner=$1)
        AND lease_epoch < 9007199254740991
      RETURNING version, lease_epoch, lease_until`, [workerId, durationMs]))
  const row = result.rows[0]
  if (!row) return null
  if (!(row.lease_until instanceof Date) || !Number.isFinite(row.lease_until.getTime())) {
    throw new TypeError('Invalid registry lease time')
  }
  return { workerId, epoch: number(row.lease_epoch), version: number(row.version),
    expiresAt: new Date(row.lease_until) }
}

export async function releaseRegistryLease(store: ObserverStore, lease: RegistryLease): Promise<boolean> {
  if (!lease || typeof lease.workerId !== 'string' || !Number.isSafeInteger(lease.epoch)) {
    throw new TypeError('Invalid registry lease')
  }
  const result = await transaction(store, client => client.query(
    `UPDATE observer_registry_cursor SET lease_owner=NULL, lease_until=NULL
      WHERE singleton=1 AND lease_owner=$1 AND lease_epoch=$2`, [lease.workerId, lease.epoch]))
  return result.rowCount === 1
}

export async function readRegistryProgress(store: ObserverStore,
  lease: RegistryLease): Promise<RegistryProgress> {
  return transaction(store, async client => {
    const cursor = await locked(client, lease)
    const accepted = await client.query<{ signed_checkpoint: Buffer }>(
      'SELECT signed_checkpoint FROM observer_registry_checkpoints WHERE statement_hash=$1',
      [cursor.accepted_hash])
    if (accepted.rows.length !== 1) throw new TypeError('Accepted registry checkpoint is missing')
    const acceptedSigned = parseCanonical(accepted.rows[0]!.signed_checkpoint) as unknown as SignedRegistryCheckpoint
    if (await registryCheckpointHash(acceptedSigned.statement) !== cursor.accepted_hash
      || acceptedSigned.statement.size !== number(cursor.accepted_size)) {
      throw new TypeError('Accepted registry checkpoint has changed')
    }
    let target: RegistryHead | null = null
    if (cursor.target_hash && cursor.signed_target && cursor.target_size !== null) {
      const signed = parseCanonical(cursor.signed_target) as unknown as SignedRegistryCheckpoint
      if (await registryCheckpointHash(signed.statement) !== cursor.target_hash
        || signed.statement.size !== number(cursor.target_size)) {
        throw new TypeError('Stored registry target has changed')
      }
      target = { provisional: true, checkpointHash: cursor.target_hash,
        signedCheckpoint: signed, signedCheckpointBytes: new Uint8Array(cursor.signed_target) }
    }
    return { acceptedSize: number(cursor.accepted_size), acceptedHash: cursor.accepted_hash,
      acceptedCheckpointBytes: new Uint8Array(accepted.rows[0]!.signed_checkpoint),
      stagedNextIndex: number(cursor.staged_next_index),
      checkpointAfter: cursor.staged_checkpoint_tail_hash ?? cursor.accepted_hash, target }
  })
}

export async function recordRegistryFinding(store: ObserverStore, lease: RegistryLease,
  findingType: 'source_nonconformance' | 'invalid_replay' | 'fork',
  evidence: Uint8Array): Promise<void> {
  if (!(evidence instanceof Uint8Array) || evidence.length < 1 || evidence.length > 16_384) {
    throw new TypeError('Invalid registry finding evidence')
  }
  await transaction(store, async client => {
    const cursor = await locked(client, lease)
    await client.query(
      `INSERT INTO observer_registry_findings(target_hash, finding_type, evidence_bytes)
       VALUES($1,$2,$3) ON CONFLICT (finding_type, evidence_bytes)
       DO UPDATE SET resolved_at=NULL`,
      [cursor.target_hash, findingType, Buffer.from(evidence)])
  })
}

export async function quarantineRegistryTarget(store: ObserverStore,
  lease: RegistryLease, evidence: Uint8Array,
  findingType: 'source_nonconformance' | 'invalid_replay' = 'invalid_replay'): Promise<void> {
  if (!(evidence instanceof Uint8Array) || evidence.length < 1 || evidence.length > 16_384) {
    throw new TypeError('Invalid registry finding evidence')
  }
  await transaction(store, async client => {
    const cursor = await locked(client, lease)
    if (!cursor.target_hash) throw new TypeError('No registry target to quarantine')
    await client.query(
      `INSERT INTO observer_registry_findings(target_hash, finding_type, evidence_bytes)
       VALUES($1,$2,$3) ON CONFLICT (finding_type, evidence_bytes)
       DO UPDATE SET resolved_at=NULL`,
      [cursor.target_hash, findingType, Buffer.from(evidence)])
    await client.query('DELETE FROM observer_registry_staged_entries WHERE target_hash=$1', [cursor.target_hash])
    await client.query('DELETE FROM observer_registry_staged_checkpoints WHERE target_hash=$1', [cursor.target_hash])
    await client.query(
      `UPDATE observer_registry_cursor SET target_hash=NULL, target_size=NULL,
         signed_target=NULL, staged_next_index=accepted_size,
         staged_checkpoint_tail_hash=NULL, version=version+1 WHERE singleton=1`)
  })
}

export async function beginRegistryTarget(store: ObserverStore, lease: RegistryLease,
  target: RegistryHead, publisherKey: CryptoKey): Promise<RegistryLease> {
  if (!target || target.provisional !== true || !validHash(target.checkpointHash)
    || !(target.signedCheckpointBytes instanceof Uint8Array)
    || target.signedCheckpointBytes.length > 16_384
    || !sameBytes(target.signedCheckpointBytes, canonicalBytes(target.signedCheckpoint))
    || target.checkpointHash !== await registryCheckpointHash(target.signedCheckpoint.statement)
    || !await verifyRegistryCheckpoint(target.signedCheckpoint, publisherKey)) {
    throw new TypeError('Invalid registry target')
  }
  const bytes = Buffer.from(target.signedCheckpointBytes)
  return transaction(store, async client => {
    const cursor = await locked(client, lease)
    if (cursor.publisher_key_id !== await signingKeyId(publisherKey)) {
      throw new TypeError('Registry publisher pin changed')
    }
    if (cursor.target_hash) {
      if (cursor.target_hash !== target.checkpointHash || !cursor.signed_target
        || !sameBytes(cursor.signed_target, bytes)) {
        throw new TypeError('Different provisional registry target is already staged')
      }
      return lease
    }
    if (target.signedCheckpoint.statement.size <= number(cursor.accepted_size)) {
      throw new TypeError('Registry target does not advance accepted head')
    }
    await client.query(
      `UPDATE observer_registry_cursor SET target_hash=$1, target_size=$2, signed_target=$3,
        staged_next_index=accepted_size, staged_checkpoint_tail_hash=NULL, version=version+1
       WHERE singleton=1`, [target.checkpointHash, target.signedCheckpoint.statement.size, bytes])
    return nextLease(lease)
  })
}

export async function stageRegistryEntries(store: ObserverStore, lease: RegistryLease,
  start: number, entries: readonly Uint8Array[]): Promise<RegistryLease> {
  if (!Number.isSafeInteger(start) || start < 0) throw new TypeError('Invalid registry page start')
  const page = dense(entries, 64)
  const snapshots: { index: number; bytes: Buffer; hash: Hash }[] = []
  let total = 0
  for (const bytes of page) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > 32 * 1024) {
      throw new TypeError('Invalid registry entry bytes')
    }
    total += bytes.length
    if (total > 256 * 1024) throw new RangeError('Registry page exceeds byte limit')
    const entry = parseCanonical(bytes) as unknown as RegistryEntry
    if (entry.index !== start + snapshots.length
      || !sameBytes(registryEntryBytes(entry), bytes)) throw new TypeError('Invalid registry entry order')
    snapshots.push({ index: entry.index, bytes: Buffer.from(bytes), hash: await hashLeaf(bytes) })
  }
  return transaction(store, async client => {
    const cursor = await locked(client, lease)
    if (!cursor.target_hash || cursor.target_size === null
      || start !== number(cursor.staged_next_index)
      || start + snapshots.length > number(cursor.target_size)) {
      throw new TypeError('Registry page differs from fixed target cursor')
    }
    for (const entry of snapshots) await client.query(
      `INSERT INTO observer_registry_staged_entries(target_hash, entry_index, leaf_hash, entry_bytes)
       VALUES($1,$2,$3,$4)`, [cursor.target_hash, entry.index, entry.hash, entry.bytes])
    await client.query(
      'UPDATE observer_registry_cursor SET staged_next_index=$1, version=version+1 WHERE singleton=1',
      [start + snapshots.length])
    return nextLease(lease)
  })
}

export async function stageRegistryCheckpoint(store: ObserverStore, lease: RegistryLease,
  item: RegistryCheckpointItem, proof: readonly Hash[], publisherKey: CryptoKey): Promise<RegistryLease> {
  if (!item || !validHash(item.hash) || !(item.bytes instanceof Uint8Array)
    || item.bytes.length > 16_384 || !sameBytes(item.bytes, canonicalBytes(item.signed))
    || item.hash !== await registryCheckpointHash(item.signed.statement)
    || !Array.isArray(proof) || proof.length > 64 || proof.some(hash => !validHash(hash))) {
    throw new TypeError('Invalid registry checkpoint or consistency path')
  }
  return transaction(store, async client => {
    const cursor = await locked(client, lease)
    const after = cursor.staged_checkpoint_tail_hash ?? cursor.accepted_hash
    if (!cursor.target_hash || cursor.publisher_key_id !== await signingKeyId(publisherKey)
      || item.signed.statement.previous !== after
      || item.signed.statement.size !== number(cursor.staged_next_index)
      || item.signed.statement.size > number(cursor.target_size!)) {
      throw new TypeError('Registry checkpoint differs from staged prefix')
    }
    const previous = cursor.staged_checkpoint_tail_hash
      ? await client.query<{ position: string; signed_checkpoint: Buffer }>(
        `SELECT position, signed_checkpoint FROM observer_registry_staged_checkpoints
         WHERE target_hash=$1 AND statement_hash=$2`, [cursor.target_hash, after])
      : await client.query<{ position: string; signed_checkpoint: Buffer }>(
        'SELECT position, signed_checkpoint FROM observer_registry_checkpoints WHERE statement_hash=$1', [after])
    const row = previous.rows[0]
    if (!row || !await verifyRegistryExtension(
      parseCanonical(row.signed_checkpoint) as unknown as SignedRegistryCheckpoint,
      item.signed, proof, publisherKey)) throw new TypeError('Registry checkpoint does not extend witnessed prefix')
    await client.query(
      `INSERT INTO observer_registry_staged_checkpoints(target_hash, position, statement_hash,
         checkpoint_size, previous_hash, signed_checkpoint, consistency_proof)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`, [cursor.target_hash, number(row.position) + 1,
        item.hash, item.signed.statement.size, after, Buffer.from(item.bytes), JSON.stringify(proof)])
    await client.query(
      `UPDATE observer_registry_cursor SET staged_checkpoint_tail_hash=$1,
         version=version+1 WHERE singleton=1`, [item.hash])
    return nextLease(lease)
  })
}

interface EntryRow { entry_index: string; entry_bytes: Buffer }
interface CheckpointRow {
  position: string
  statement_hash: string
  signed_checkpoint: Buffer
  consistency_proof: unknown
}

async function replayRows(genesisBytes: Uint8Array, genesisHash: string,
  entries: readonly EntryRow[], checkpoints: readonly CheckpointRow[],
  expectedHash: string, expectedSize: number, publisherKey: CryptoKey): Promise<RegistryReplaySnapshot> {
  const genesis = parseCanonical(genesisBytes) as unknown as SignedRegistryCheckpoint
  const retainedGenesis = checkpoints[0]
  if (!retainedGenesis || number(retainedGenesis.position) !== 0
    || retainedGenesis.statement_hash !== genesisHash
    || !sameBytes(retainedGenesis.signed_checkpoint, genesisBytes)) {
    throw new TypeError('Retained registry genesis differs from trust pin')
  }
  const replay = await createRegistryReplaySession(genesis, publisherKey)
  let entryIndex = 0
  for (let position = 1; position < checkpoints.length; position++) {
    const row = checkpoints[position]!
    if (number(row.position) !== position) throw new TypeError('Registry checkpoint position gap')
    const signed = parseCanonical(row.signed_checkpoint) as unknown as SignedRegistryCheckpoint
    const nextSize = signed.statement.size
    while (entryIndex < nextSize) {
      const page: Uint8Array[] = []
      while (page.length < 64 && entryIndex < nextSize) {
        const entry = entries[entryIndex]
        if (!entry || number(entry.entry_index) !== entryIndex) throw new TypeError('Registry entry gap')
        page.push(new Uint8Array(entry.entry_bytes))
        entryIndex++
      }
      await replay.appendRegistryEntries(page, signed)
    }
    if (!Array.isArray(row.consistency_proof)
      || row.consistency_proof.some(item => !validHash(item))) {
      throw new TypeError('Invalid retained registry consistency path')
    }
    await replay.sealRegistryCheckpoint(signed, row.consistency_proof as Hash[])
    if (await registryCheckpointHash(signed.statement) !== row.statement_hash) {
      throw new TypeError('Stored registry checkpoint hash mismatch')
    }
  }
  const snapshot = replay.snapshot()
  if (entryIndex !== entries.length || snapshot.size !== expectedSize
    || snapshot.checkpointHash !== expectedHash) {
    throw new TypeError('Registry head differs from replayed evidence')
  }
  return snapshot
}

export interface RegistryFeed {
  feedId: Hash
  anchorPin: Hash
  signedAnchor: Extract<RegistryEntry, { kind: 'feed_anchor' }>['signedAnchor']
  advertisedHead: ProvisionalFeedHead | null
}

/** Replays the accepted registry before exposing discovered feed targets. */
export async function readRegistryFeeds(store: ObserverStore, publisherKey: CryptoKey): Promise<{
  snapshot: RegistryReplaySnapshot; signedHead: SignedRegistryCheckpoint; feeds: RegistryFeed[]
}> {
  return transaction(store, async client => {
    const cursorResult = await client.query<CursorRow>(
      `SELECT publisher_key_id, genesis_hash, signed_genesis, accepted_hash,
         accepted_size, target_hash, target_size, signed_target, staged_next_index,
         staged_checkpoint_tail_hash, version, lease_epoch, lease_owner,
         lease_until > clock_timestamp() AS lease_valid
       FROM observer_registry_cursor WHERE singleton=1 FOR SHARE`)
    const cursor = cursorResult.rows[0]
    if (!cursor || cursor.publisher_key_id !== await signingKeyId(publisherKey)) {
      throw new TypeError('Registry publisher pin differs from retained cursor')
    }
    const entries = await client.query<EntryRow>(
      'SELECT entry_index, entry_bytes FROM observer_registry_entries ORDER BY entry_index')
    const checkpoints = await client.query<CheckpointRow>(
      `SELECT position, statement_hash, signed_checkpoint, consistency_proof
       FROM observer_registry_checkpoints ORDER BY position`)
    const snapshot = await replayRows(cursor.signed_genesis, cursor.genesis_hash,
      entries.rows, checkpoints.rows, cursor.accepted_hash, number(cursor.accepted_size), publisherKey)
    const signedHead = parseCanonical(checkpoints.rows.at(-1)!.signed_checkpoint) as unknown as SignedRegistryCheckpoint
    const feeds = new Map<Hash, RegistryFeed>()
    for (const row of entries.rows) {
      const entry = parseCanonical(row.entry_bytes) as unknown as RegistryEntry
      if (entry.kind === 'feed_anchor') {
        feeds.set(entry.feedId, { feedId: entry.feedId, anchorPin: entry.anchorPin,
          signedAnchor: entry.signedAnchor, advertisedHead: null })
      } else {
        const feed = feeds.get(entry.feedId)
        if (!feed) throw new TypeError('Registry head has no accepted anchor')
        const signedCheckpoint = entry.signedCheckpoint
        feeds.set(entry.feedId, { ...feed, advertisedHead: { provisional: true,
          checkpointHash: await checkpointHash(signedCheckpoint.statement), signedCheckpoint,
          signedCheckpointBytes: canonicalBytes(signedCheckpoint) } })
      }
    }
    const result = [...feeds.values()].sort((left, right) =>
      left.feedId < right.feedId ? -1 : left.feedId > right.feedId ? 1 : 0)
    if (result.length !== snapshot.feeds.length || result.some((feed, index) => {
      const expected = snapshot.feeds[index]!
      return feed.feedId !== expected.feedId || feed.anchorPin !== expected.anchorPin
        || feed.advertisedHead?.checkpointHash !== (expected.advertisedCheckpointHash ?? undefined)
    })) throw new TypeError('Registry feed catalog differs from replayed head')
    return { snapshot, signedHead, feeds: result }
  })
}

/** Reserves a rotating bounded slice so small cron budgets eventually cover every feed. */
export async function selectRegistryFeedBatch(store: ObserverStore,
  feeds: readonly RegistryFeed[], limit: number): Promise<RegistryFeed[]> {
  if (!Array.isArray(feeds) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError('Invalid registry feed batch request')
  }
  if (feeds.length === 0) return []
  if (feeds.some((feed, index) => !validHash(feed.feedId)
    || index > 0 && feeds[index - 1]!.feedId >= feed.feedId)) {
    throw new TypeError('Registry feeds must be sorted and unique')
  }
  return transaction(store, async client => {
    const cursor = await client.query<{ next_feed_offset: string }>(
      'SELECT next_feed_offset FROM observer_registry_cursor WHERE singleton=1 FOR UPDATE')
    if (cursor.rows.length !== 1) throw new TypeError('Registry cursor is missing')
    const start = number(cursor.rows[0]!.next_feed_offset) % feeds.length
    const length = Math.min(limit, feeds.length)
    const selected = Array.from({ length }, (_, offset) => feeds[(start + offset) % feeds.length]!)
    await client.query('UPDATE observer_registry_cursor SET next_feed_offset=$1 WHERE singleton=1',
      [(start + length) % feeds.length])
    return selected
  })
}

/** Replays retained accepted and staged bytes before moving the accepted cursor. */
export async function acceptRegistryTarget(store: ObserverStore, lease: RegistryLease,
  publisherKey: CryptoKey): Promise<RegistryReplaySnapshot> {
  return transaction(store, async client => {
    const cursor = await locked(client, lease)
    if (!cursor.target_hash || cursor.publisher_key_id !== await signingKeyId(publisherKey)
      || cursor.staged_checkpoint_tail_hash !== cursor.target_hash
      || cursor.target_size === null || number(cursor.staged_next_index) !== number(cursor.target_size)) {
      throw new TypeError('Registry target is incomplete')
    }
    const entries = await client.query<EntryRow>(
      `SELECT entry_index, entry_bytes FROM observer_registry_entries
       UNION ALL SELECT entry_index, entry_bytes FROM observer_registry_staged_entries
         WHERE target_hash=$1 ORDER BY entry_index`, [cursor.target_hash])
    const checkpoints = await client.query<CheckpointRow>(
      `SELECT position, statement_hash, signed_checkpoint, consistency_proof
         FROM observer_registry_checkpoints
       UNION ALL SELECT position, statement_hash, signed_checkpoint, consistency_proof
         FROM observer_registry_staged_checkpoints WHERE target_hash=$1 ORDER BY position`,
      [cursor.target_hash])
    const snapshot = await replayRows(cursor.signed_genesis, cursor.genesis_hash,
      entries.rows, checkpoints.rows, cursor.target_hash, number(cursor.target_size), publisherKey)
    await client.query(
      `INSERT INTO observer_registry_entries(entry_index, leaf_hash, entry_bytes)
       SELECT entry_index, leaf_hash, entry_bytes FROM observer_registry_staged_entries
        WHERE target_hash=$1`, [cursor.target_hash])
    await client.query(
      `INSERT INTO observer_registry_checkpoints(position, statement_hash, checkpoint_size,
         previous_hash, signed_checkpoint, consistency_proof)
       SELECT position, statement_hash, checkpoint_size, previous_hash,
              signed_checkpoint, consistency_proof FROM observer_registry_staged_checkpoints
       WHERE target_hash=$1`, [cursor.target_hash])
    await client.query(
      `UPDATE observer_registry_findings SET resolved_at=clock_timestamp()
       WHERE finding_type='source_nonconformance' AND resolved_at IS NULL
         AND target_hash IN (SELECT statement_hash FROM observer_registry_checkpoints)`)
    await client.query('DELETE FROM observer_registry_staged_entries WHERE target_hash=$1', [cursor.target_hash])
    await client.query('DELETE FROM observer_registry_staged_checkpoints WHERE target_hash=$1', [cursor.target_hash])
    await client.query(
      `UPDATE observer_registry_cursor SET accepted_hash=target_hash, accepted_size=target_size,
         target_hash=NULL, target_size=NULL, signed_target=NULL,
         staged_checkpoint_tail_hash=NULL, version=version+1 WHERE singleton=1`)
    return snapshot
  })
}
