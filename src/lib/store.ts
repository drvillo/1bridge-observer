import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import pg, { type PoolClient } from 'pg'
import { canonicalBytes, checkpointHash, decodeBase64Url, hashLeaf, parseCanonical,
  replayGovernanceHistory, type GovernanceReplaySnapshot, type SignedAuthorityAnchor,
  type SignedCheckpoint } from '@drvillo/1bridge-authority'
import { verifyObserverAnchor, type ObserverConfig } from './config'
import type { CheckpointPageItem, ProvisionalFeedHead } from './source'

const HASH = /^[0-9a-f]{64}$/
const SCHEMA = /^[a-z_][a-z0-9_]{0,62}$/
const MAX_LEASE_MS = 300_000
const MAX_LEAF_BATCH_BYTES = 256 * 1024
const MAX_CHECKPOINT_BATCH_BYTES = 64 * 1024

export interface ObserverStore { close(): Promise<void> }
export interface ObserverLease {
  feedId: string
  workerId: string
  epoch: number
  version: number
  expiresAt: Date
}
export interface ObserverTargetLease extends ObserverLease {
  attemptId: number
  targetHash: string
  targetSize: number
}
export interface ObserverBatch {
  start: number
  leaves: readonly Uint8Array[]
  checkpoints: readonly CheckpointPageItem[]
}
export interface StagedBatchResult { alreadyApplied: boolean; claim: ObserverTargetLease }

interface StoreConnection { pool: pg.Pool; schema: string }
const connections = new WeakMap<ObserverStore, StoreConnection>()

function connectionFor(store: ObserverStore): StoreConnection {
  const connection = connections.get(store)
  if (!connection) throw new TypeError('Expected open observer store')
  return connection
}

async function transaction<T>(store: ObserverStore, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const { pool, schema } = connectionFor(store)
  const client = await pool.connect()
  let destroy = false
  try {
    await client.query('BEGIN')
    const namespace = await client.query<{ exists: boolean }>(
      'SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname = $1) AS exists', [schema])
    if (!namespace.rows[0]?.exists) throw new Error('Observer database schema does not exist')
    await client.query("SELECT set_config('search_path', $1, true)", [schema])
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { destroy = true }
    throw error
  } finally {
    client.release(destroy)
  }
}

function safeCount(value: unknown): number {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new TypeError('Invalid database counter')
  const number = Number(value)
  if (!Number.isSafeInteger(number)) throw new RangeError('Database counter exceeds safe integer range')
  return number
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right))
}

async function snapshotTarget(head: ProvisionalFeedHead, feedId: string) {
  if (!head || head.provisional !== true || !(head.signedCheckpointBytes instanceof Uint8Array)
    || head.signedCheckpointBytes.length > 1024 || !HASH.test(head.checkpointHash)) {
    throw new TypeError('Invalid provisional target')
  }
  const bytes = new Uint8Array(head.signedCheckpointBytes)
  const signed = parseCanonical(bytes) as unknown as SignedCheckpoint
  if (!equalBytes(canonicalBytes(head.signedCheckpoint), bytes)) throw new TypeError('Provisional checkpoint bytes disagree')
  const hash = await checkpointHash(signed.statement)
  if (hash !== head.checkpointHash || signed.statement.feedId !== feedId) throw new TypeError('Provisional target identity mismatch')
  return { hash, size: signed.statement.size, bytes: Buffer.from(bytes) }
}

interface LockedClaim {
  version: string
  lease_epoch: string
  lease_owner: string | null
  lease_until: Date | null
  lease_valid: boolean
  active_attempt_id: string | null
  staged_next_index: string
  accepted_size: string
  accepted_checkpoint_hash: string | null
  staged_checkpoint_tail_hash: string | null
  staged_checkpoint_tail_position: string | null
}

async function lockClaim(client: PoolClient, claim: ObserverLease): Promise<LockedClaim> {
  if (!claim || typeof claim.feedId !== 'string' || !HASH.test(claim.feedId)
    || typeof claim.workerId !== 'string' || !Number.isSafeInteger(claim.epoch)
    || !Number.isSafeInteger(claim.version)) throw new TypeError('Invalid observer claim')
  const result = await client.query<LockedClaim>(
    `SELECT version, lease_epoch, lease_owner, lease_until,
            lease_until > clock_timestamp() AS lease_valid, active_attempt_id,
            staged_next_index, accepted_size, accepted_checkpoint_hash,
            staged_checkpoint_tail_hash, staged_checkpoint_tail_position
       FROM observer_cursors WHERE feed_id=$1 FOR UPDATE`, [claim.feedId])
  const row = result.rows[0]
  if (!row || row.lease_owner !== claim.workerId || !row.lease_valid
    || safeCount(row.lease_epoch) !== claim.epoch || safeCount(row.version) !== claim.version) {
    throw new TypeError('Stale observer claim')
  }
  return row
}

function denseItems<T>(value: readonly T[], max: number): T[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) {
    throw new TypeError('Expected bounded dense observer batch')
  }
  const result: T[] = []
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError('Expected batch data item')
    result.push(descriptor.value)
  }
  return result
}

async function snapshotBatch(batch: ObserverBatch, feedId: string) {
  if (!batch || !Number.isSafeInteger(batch.start) || batch.start < 0) throw new TypeError('Invalid batch start')
  const leaves = denseItems(batch.leaves, 64)
  const checkpoints = denseItems(batch.checkpoints, 16)
  if (leaves.length + checkpoints.length === 0) throw new TypeError('Empty observer batch')
  if (!Number.isSafeInteger(batch.start + leaves.length)) throw new RangeError('Observer batch index exceeds safe range')
  let leafBytes = 0
  const leafSnapshots = [] as { index: number; hash: string; bytes: Buffer }[]
  for (let offset = 0; offset < leaves.length; offset++) {
    const value = leaves[offset]
    if (!(value instanceof Uint8Array) || value.length === 0) throw new TypeError('Invalid observer leaf')
    leafBytes += value.length
    if (leafBytes > MAX_LEAF_BATCH_BYTES) throw new RangeError('Observer leaf batch exceeds byte limit')
    const bytes = Buffer.from(value)
    parseCanonical(bytes)
    leafSnapshots.push({ index: batch.start + offset, hash: await hashLeaf(bytes), bytes })
  }
  let checkpointBytes = 0
  const checkpointSnapshots = [] as { hash: string; size: number; previous: string | null; bytes: Buffer }[]
  for (const value of checkpoints) {
    if (!value || !(value.bytes instanceof Uint8Array) || !HASH.test(value.hash)) {
      throw new TypeError('Invalid observer checkpoint item')
    }
    checkpointBytes += value.bytes.length
    if (checkpointBytes > MAX_CHECKPOINT_BATCH_BYTES) throw new RangeError('Observer checkpoint batch exceeds byte limit')
    const bytes = Buffer.from(value.bytes)
    const signed = parseCanonical(bytes) as unknown as SignedCheckpoint
    if (!equalBytes(canonicalBytes(value.signed), bytes)
      || typeof signed.signature !== 'string' || decodeBase64Url(signed.signature, 64).length !== 64
      || signed.statement.feedId !== feedId || await checkpointHash(signed.statement) !== value.hash) {
      throw new TypeError('Observer checkpoint item identity mismatch')
    }
    checkpointSnapshots.push({ hash: value.hash, size: signed.statement.size,
      previous: signed.statement.previous, bytes })
  }
  return { start: batch.start, end: batch.start + leaves.length, leaves: leafSnapshots,
    checkpoints: checkpointSnapshots }
}

/** Opens one small, customer-owned Postgres pool under a pre-created schema. */
export function openObserverStore(connectionString: string, schema = 'public'): ObserverStore {
  if (typeof connectionString !== 'string' || !connectionString) throw new TypeError('Expected observer database URL')
  if (typeof schema !== 'string' || !SCHEMA.test(schema)) throw new TypeError('Expected simple observer schema name')
  const pool = new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 5_000 })
  pool.on('error', error => { console.error('Observer idle database connection failed:', error.message) })
  const store: ObserverStore = Object.freeze({ close: async () => { connections.delete(store); await pool.end() } })
  connections.set(store, { pool, schema })
  return store
}

/** Applies the reviewed SQL file atomically on one connection. */
export async function installObserverSchema(store: ObserverStore): Promise<void> {
  const sql = readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8')
  const digest = createHash('sha256').update(sql).digest('hex')
  await transaction(store, async client => {
    await client.query("SELECT set_config('observer.schema_digest', $1, true)", [digest])
    await client.query(sql)
  })
}

/** Registers exact independently pinned feed bytes without replacing an existing identity. */
export async function registerObserverFeed(store: ObserverStore, config: ObserverConfig): Promise<void> {
  const anchor = await verifyObserverAnchor(config)
  if (anchor.feedId !== config.feedId) throw new TypeError('Feed identity mismatch')
  const signedBytes = Buffer.from(decodeBase64Url(config.signedAnchor, 16_384))
  await transaction(store, async client => {
    const inserted = await client.query(
      'INSERT INTO observer_feeds(feed_id, anchor_pin, signed_anchor, source_base_url) VALUES($1,$2,$3,$4) ON CONFLICT (feed_id) DO NOTHING',
      [config.feedId, config.anchorPin, signedBytes, config.sourceBaseUrl])
    if (inserted.rowCount === 1) {
      await client.query('INSERT INTO observer_cursors(feed_id) VALUES($1)', [config.feedId])
      return
    }
    const existing = await client.query<{ anchor_pin: string; signed_anchor: Buffer; source_base_url: string }>(
      'SELECT anchor_pin, signed_anchor, source_base_url FROM observer_feeds WHERE feed_id=$1', [config.feedId])
    if (existing.rows.length !== 1 || existing.rows[0]?.anchor_pin !== config.anchorPin
      || existing.rows[0]?.source_base_url !== config.sourceBaseUrl
      || !existing.rows[0].signed_anchor.equals(signedBytes)) throw new TypeError('Observer feed registration conflicts with retained identity')
    const cursor = await client.query('SELECT 1 FROM observer_cursors WHERE feed_id=$1', [config.feedId])
    if (cursor.rows.length !== 1) throw new TypeError('Observer feed cursor is missing')
  })
}

/** Claims a bounded DB-time lease; every successful claim advances the fencing epoch. */
export async function claimObserverLease(store: ObserverStore, feedId: string, workerId: string,
  durationMs: number): Promise<ObserverLease | null> {
  if (typeof feedId !== 'string' || !HASH.test(feedId)) throw new TypeError('Invalid observer feed ID')
  if (typeof workerId !== 'string' || workerId.length < 1 || workerId.length > 256) throw new TypeError('Invalid observer worker ID')
  if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > MAX_LEASE_MS) throw new TypeError('Invalid observer lease duration')
  const result = await transaction(store, client => client.query<{ version: string; lease_epoch: string; lease_until: Date }>(
    `UPDATE observer_cursors
       SET lease_owner=$2, lease_until=clock_timestamp() + ($3::integer * interval '1 millisecond'),
           lease_epoch=lease_epoch+1
     WHERE feed_id=$1 AND (lease_until IS NULL OR lease_until <= clock_timestamp() OR lease_owner=$2)
       AND lease_epoch < 9007199254740991
     RETURNING version, lease_epoch, lease_until`, [feedId, workerId, durationMs]))
  if (result.rows.length === 0) return null
  const row = result.rows[0]!
  if (!(row.lease_until instanceof Date) || !Number.isFinite(row.lease_until.getTime())) throw new TypeError('Invalid database lease time')
  return { feedId, workerId, epoch: safeCount(row.lease_epoch), version: safeCount(row.version),
    expiresAt: new Date(row.lease_until) }
}

/** Fixes one exact but still unauthenticated signed target under a fenced lease. */
export async function beginObserverTarget(store: ObserverStore, claim: ObserverLease,
  head: ProvisionalFeedHead): Promise<ObserverTargetLease> {
  const target = await snapshotTarget(head, claim.feedId)
  return transaction(store, async client => {
    const cursor = await lockClaim(client, claim)
    if (!(cursor.lease_until instanceof Date)) throw new TypeError('Invalid observer lease time')
    let attemptId: number
    let version = safeCount(cursor.version)
    if (cursor.active_attempt_id !== null) {
      attemptId = safeCount(cursor.active_attempt_id)
      const existing = await client.query<{ target_hash: string; target_size: string;
        signed_checkpoint: Buffer; status: string }>(
        'SELECT target_hash, target_size, signed_checkpoint, status FROM observer_targets WHERE feed_id=$1 AND attempt_id=$2',
        [claim.feedId, attemptId])
      const row = existing.rows[0]
      if (!row || row.status !== 'active' || row.target_hash !== target.hash
        || safeCount(row.target_size) !== target.size || !row.signed_checkpoint.equals(target.bytes)) {
        throw new TypeError('Different provisional target already active')
      }
    } else {
      if (version === Number.MAX_SAFE_INTEGER) throw new RangeError('Observer cursor version exhausted')
      const inserted = await client.query<{ attempt_id: string }>(
        `INSERT INTO observer_targets(feed_id, target_hash, target_size, signed_checkpoint)
         VALUES($1,$2,$3,$4) RETURNING attempt_id`,
        [claim.feedId, target.hash, target.size, target.bytes])
      attemptId = safeCount(inserted.rows[0]?.attempt_id)
      await client.query('UPDATE observer_cursors SET active_attempt_id=$2, version=version+1 WHERE feed_id=$1',
        [claim.feedId, attemptId])
      version++
    }
    return { feedId: claim.feedId, workerId: claim.workerId, epoch: claim.epoch,
      version, expiresAt: new Date(cursor.lease_until), attemptId,
      targetHash: target.hash, targetSize: target.size }
  })
}

/** Retains exact source bytes under the fixed target; staged bytes are not verified coverage. */
export async function stageObserverBatch(store: ObserverStore, claim: ObserverTargetLease,
  batch: ObserverBatch): Promise<StagedBatchResult> {
  const snapshot = await snapshotBatch(batch, claim.feedId)
  return transaction(store, async client => {
    const cursor = await lockClaim(client, claim)
    if (!Number.isSafeInteger(claim.attemptId) || claim.attemptId < 1
      || !HASH.test(claim.targetHash) || !Number.isSafeInteger(claim.targetSize)
      || cursor.active_attempt_id === null || safeCount(cursor.active_attempt_id) !== claim.attemptId
      || !(cursor.lease_until instanceof Date)) throw new TypeError('Stale observer target claim')
    const targetResult = await client.query<{ target_hash: string; target_size: string; signed_checkpoint: Buffer; status: string }>(
      'SELECT target_hash, target_size, signed_checkpoint, status FROM observer_targets WHERE feed_id=$1 AND attempt_id=$2',
      [claim.feedId, claim.attemptId])
    const target = targetResult.rows[0]
    if (!target || target.status !== 'active' || target.target_hash !== claim.targetHash
      || safeCount(target.target_size) !== claim.targetSize) throw new TypeError('Stale observer target claim')

    const stagedNext = safeCount(cursor.staged_next_index)
    const first = snapshot.checkpoints[0]
    const repeatedCheckpoint = snapshot.leaves.length === 0 && first
      ? await client.query<{ position: string }>(
        'SELECT position FROM observer_staged_checkpoints WHERE feed_id=$1 AND attempt_id=$2 AND statement_hash=$3',
        [claim.feedId, claim.attemptId, first.hash])
      : null
    if ((snapshot.start < stagedNext && snapshot.end <= stagedNext)
      || (snapshot.start === stagedNext && repeatedCheckpoint?.rows.length === 1)) {
      for (const leaf of snapshot.leaves) {
        const stored = await client.query<{ leaf_hash: string; leaf_bytes: Buffer }>(
          'SELECT leaf_hash, leaf_bytes FROM observer_staged_leaves WHERE feed_id=$1 AND attempt_id=$2 AND leaf_index=$3',
          [claim.feedId, claim.attemptId, leaf.index])
        if (stored.rows[0]?.leaf_hash !== leaf.hash || !stored.rows[0]?.leaf_bytes.equals(leaf.bytes)) {
          throw new TypeError('Previously staged leaf changed')
        }
      }
      if (first) {
        const row = await client.query<{ position: string }>(
          'SELECT position FROM observer_staged_checkpoints WHERE feed_id=$1 AND attempt_id=$2 AND statement_hash=$3',
          [claim.feedId, claim.attemptId, first.hash])
        if (row.rows.length !== 1) throw new TypeError('Previously staged checkpoint changed')
        const position = safeCount(row.rows[0]?.position)
        const stored = await client.query<{ position: string; statement_hash: string; checkpoint_size: string;
          previous_hash: string | null; signed_checkpoint: Buffer }>(
          `SELECT position, statement_hash, checkpoint_size, previous_hash, signed_checkpoint
             FROM observer_staged_checkpoints WHERE feed_id=$1 AND attempt_id=$2 AND position >= $3 AND position < $4
             ORDER BY position`, [claim.feedId, claim.attemptId, position, position + snapshot.checkpoints.length])
        if (stored.rows.length !== snapshot.checkpoints.length || stored.rows.some((row, offset) => {
          const item = snapshot.checkpoints[offset]!
          return safeCount(row.position) !== position + offset || row.statement_hash !== item.hash
            || safeCount(row.checkpoint_size) !== item.size || row.previous_hash !== item.previous
            || !row.signed_checkpoint.equals(item.bytes)
        })) throw new TypeError('Previously staged checkpoint changed')
      }
      return { alreadyApplied: true, claim: { ...claim, expiresAt: new Date(cursor.lease_until) } }
    }
    if (snapshot.start !== stagedNext) throw new TypeError('Observer batch start differs from staging cursor')
    if (snapshot.end > claim.targetSize) throw new RangeError('Observer batch exceeds fixed target')
    if (safeCount(cursor.version) === Number.MAX_SAFE_INTEGER) throw new RangeError('Observer cursor version exhausted')
    let predecessor = cursor.staged_checkpoint_tail_hash ?? cursor.accepted_checkpoint_hash
    let position = cursor.staged_checkpoint_tail_position === null ? -1 : safeCount(cursor.staged_checkpoint_tail_position)
    let previousSize = -1
    if (predecessor !== null && position === -1) {
      const accepted = await client.query<{ position: string; checkpoint_size: string }>(
        'SELECT position, checkpoint_size FROM observer_checkpoints WHERE feed_id=$1 AND statement_hash=$2',
        [claim.feedId, predecessor])
      if (accepted.rows.length !== 1) throw new TypeError('Accepted observer checkpoint is missing')
      position = safeCount(accepted.rows[0]?.position)
      previousSize = safeCount(accepted.rows[0]?.checkpoint_size)
    } else if (predecessor !== null) {
      const staged = await client.query<{ checkpoint_size: string }>(
        'SELECT checkpoint_size FROM observer_staged_checkpoints WHERE feed_id=$1 AND attempt_id=$2 AND statement_hash=$3',
        [claim.feedId, claim.attemptId, predecessor])
      if (staged.rows.length !== 1) throw new TypeError('Staged observer checkpoint tail is missing')
      previousSize = safeCount(staged.rows[0]?.checkpoint_size)
    }
    const stagedCheckpoints = [] as { position: number; hash: string; size: number;
      previous: string | null; bytes: Buffer }[]
    for (const item of snapshot.checkpoints) {
      if (item.previous !== predecessor || item.size > snapshot.end
        || item.size > claim.targetSize || item.size <= previousSize
        || (position === -1 && item.size !== 0)
        || (item.hash === claim.targetHash && !item.bytes.equals(target.signed_checkpoint))) {
        throw new TypeError('Observer checkpoint does not extend staged target')
      }
      if (predecessor === claim.targetHash) throw new TypeError('Observer checkpoint extends fixed target')
      position++
      if (!Number.isSafeInteger(position)) throw new RangeError('Observer checkpoint position exceeds safe range')
      stagedCheckpoints.push({ ...item, position })
      predecessor = item.hash
      previousSize = item.size
    }
    for (const leaf of snapshot.leaves) {
      await client.query(
        'INSERT INTO observer_staged_leaves(feed_id, attempt_id, leaf_index, leaf_hash, leaf_bytes) VALUES($1,$2,$3,$4,$5)',
        [claim.feedId, claim.attemptId, leaf.index, leaf.hash, leaf.bytes])
    }
    for (const item of stagedCheckpoints) {
      await client.query(
        `INSERT INTO observer_staged_checkpoints(feed_id, attempt_id, position, statement_hash,
           checkpoint_size, previous_hash, signed_checkpoint) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [claim.feedId, claim.attemptId, item.position, item.hash, item.size, item.previous, item.bytes])
    }
    await client.query(
      `UPDATE observer_cursors SET staged_next_index=$2, staged_checkpoint_tail_hash=$3,
         staged_checkpoint_tail_position=$4, version=version+1 WHERE feed_id=$1`,
      [claim.feedId, snapshot.end, stagedCheckpoints.length ? predecessor : cursor.staged_checkpoint_tail_hash,
        stagedCheckpoints.length ? position : cursor.staged_checkpoint_tail_position])
    return { alreadyApplied: false, claim: { ...claim, version: claim.version + 1,
      expiresAt: new Date(cursor.lease_until) } }
  })
}

interface RetainedReplayInput {
  anchor: SignedAuthorityAnchor
  pin: string
  leaves: Uint8Array[]
  checkpoints: SignedCheckpoint[]
}

async function retainedReplayInput(store: ObserverStore, claim: ObserverTargetLease): Promise<RetainedReplayInput> {
  return transaction(store, async client => {
    const cursor = await lockClaim(client, claim)
    if (!Number.isSafeInteger(claim.attemptId) || claim.attemptId < 1
      || cursor.active_attempt_id === null || safeCount(cursor.active_attempt_id) !== claim.attemptId
      || safeCount(cursor.staged_next_index) !== claim.targetSize
      || cursor.staged_checkpoint_tail_hash !== claim.targetHash) throw new TypeError('Observer target incomplete')
    if (claim.targetSize > 10_000) throw new RangeError('Observer replay budget exceeded')
    const targetResult = await client.query<{ target_hash: string; target_size: string;
      signed_checkpoint: Buffer; status: string }>(
      'SELECT target_hash, target_size, signed_checkpoint, status FROM observer_targets WHERE feed_id=$1 AND attempt_id=$2',
      [claim.feedId, claim.attemptId])
    const target = targetResult.rows[0]
    if (!target || target.status !== 'active' || target.target_hash !== claim.targetHash
      || safeCount(target.target_size) !== claim.targetSize) throw new TypeError('Observer target incomplete')
    const feedResult = await client.query<{ anchor_pin: string; signed_anchor: Buffer }>(
      'SELECT anchor_pin, signed_anchor FROM observer_feeds WHERE feed_id=$1', [claim.feedId])
    const feed = feedResult.rows[0]
    if (!feed) throw new TypeError('Observer feed is missing')
    const acceptedSize = safeCount(cursor.accepted_size)
    const acceptedLeaves = await client.query<{ leaf_index: string; leaf_bytes: Buffer }>(
      'SELECT leaf_index, leaf_bytes FROM observer_leaves WHERE feed_id=$1 AND leaf_index < $2 ORDER BY leaf_index',
      [claim.feedId, acceptedSize])
    const stagedLeaves = await client.query<{ leaf_index: string; leaf_bytes: Buffer }>(
      `SELECT leaf_index, leaf_bytes FROM observer_staged_leaves
       WHERE feed_id=$1 AND attempt_id=$2 AND leaf_index >= $3 ORDER BY leaf_index`,
      [claim.feedId, claim.attemptId, acceptedSize])
    const leafRows = [...acceptedLeaves.rows, ...stagedLeaves.rows]
    if (leafRows.length !== claim.targetSize || leafRows.some((row, index) => safeCount(row.leaf_index) !== index)) {
      throw new TypeError('Observer target has an incomplete leaf prefix')
    }
    const acceptedCheckpoints = await client.query<{ position: string; statement_hash: string; signed_checkpoint: Buffer }>(
      'SELECT position, statement_hash, signed_checkpoint FROM observer_checkpoints WHERE feed_id=$1 ORDER BY position',
      [claim.feedId])
    const stagedCheckpoints = await client.query<{ position: string; statement_hash: string; signed_checkpoint: Buffer }>(
      `SELECT position, statement_hash, signed_checkpoint FROM observer_staged_checkpoints
       WHERE feed_id=$1 AND attempt_id=$2 ORDER BY position`, [claim.feedId, claim.attemptId])
    const checkpointRows = [...acceptedCheckpoints.rows, ...stagedCheckpoints.rows]
    if (checkpointRows.length === 0 || checkpointRows.length > 10_001
      || checkpointRows.some((row, index) => safeCount(row.position) !== index)
      || checkpointRows.at(-1)?.statement_hash !== claim.targetHash
      || !checkpointRows.at(-1)?.signed_checkpoint.equals(target.signed_checkpoint)) {
      throw new TypeError('Observer target has an incomplete checkpoint chain')
    }
    let bytes = feed.signed_anchor.length
    for (const row of leafRows) bytes += row.leaf_bytes.length
    for (const row of checkpointRows) bytes += row.signed_checkpoint.length
    if (bytes > 32 * 1024 * 1024) throw new RangeError('Observer replay budget exceeded')
    return { anchor: parseCanonical(feed.signed_anchor) as unknown as SignedAuthorityAnchor,
      pin: feed.anchor_pin, leaves: leafRows.map(row => new Uint8Array(row.leaf_bytes)),
      checkpoints: checkpointRows.map(row => parseCanonical(row.signed_checkpoint) as unknown as SignedCheckpoint) }
  })
}

/** Replays retained bytes under the independent pin, then atomically accepts the still-current target. */
export async function acceptObserverTarget(store: ObserverStore, claim: ObserverTargetLease): Promise<GovernanceReplaySnapshot> {
  const input = await retainedReplayInput(store, claim)
  const verified = await replayGovernanceHistory(input.anchor, input.pin, input.leaves, input.checkpoints)
  if (verified.feedId !== claim.feedId || verified.size !== claim.targetSize
    || verified.checkpointHash !== claim.targetHash) throw new TypeError('Observer replay disagrees with target')
  await transaction(store, async client => {
    const cursor = await lockClaim(client, claim)
    if (cursor.active_attempt_id === null || safeCount(cursor.active_attempt_id) !== claim.attemptId
      || safeCount(cursor.staged_next_index) !== claim.targetSize
      || cursor.staged_checkpoint_tail_hash !== claim.targetHash) throw new TypeError('Stale observer target claim')
    if (safeCount(cursor.version) === Number.MAX_SAFE_INTEGER) throw new RangeError('Observer cursor version exhausted')
    const target = await client.query<{ status: string }>(
      'SELECT status FROM observer_targets WHERE feed_id=$1 AND attempt_id=$2', [claim.feedId, claim.attemptId])
    if (target.rows[0]?.status !== 'active') throw new TypeError('Stale observer target claim')
    const acceptedSize = safeCount(cursor.accepted_size)
    await client.query(
      `INSERT INTO observer_leaves(feed_id, leaf_index, leaf_hash, leaf_bytes)
       SELECT feed_id, leaf_index, leaf_hash, leaf_bytes FROM observer_staged_leaves
       WHERE feed_id=$1 AND attempt_id=$2 AND leaf_index >= $3 ORDER BY leaf_index`,
      [claim.feedId, claim.attemptId, acceptedSize])
    await client.query(
      `INSERT INTO observer_checkpoints(feed_id, statement_hash, position, checkpoint_size, previous_hash, signed_checkpoint)
       SELECT feed_id, statement_hash, position, checkpoint_size, previous_hash, signed_checkpoint
       FROM observer_staged_checkpoints WHERE feed_id=$1 AND attempt_id=$2 ORDER BY position`,
      [claim.feedId, claim.attemptId])
    await client.query(
      `UPDATE observer_targets SET status='accepted', finished_at=clock_timestamp()
       WHERE feed_id=$1 AND attempt_id=$2`, [claim.feedId, claim.attemptId])
    await client.query(
      `UPDATE observer_cursors SET accepted_size=$2, accepted_checkpoint_hash=$3,
         staged_next_index=$2, active_attempt_id=NULL, staged_checkpoint_tail_hash=NULL,
         staged_checkpoint_tail_position=NULL, version=version+1 WHERE feed_id=$1`,
      [claim.feedId, claim.targetSize, claim.targetHash])
  })
  return verified
}

/** Retains a complete replay-rejected attempt and releases its staging cursor for a new attempt. */
export async function quarantineObserverTarget(store: ObserverStore, claim: ObserverTargetLease): Promise<number> {
  const input = await retainedReplayInput(store, claim)
  let rejected = false
  try { await replayGovernanceHistory(input.anchor, input.pin, input.leaves, input.checkpoints) }
  catch (error) {
    if (!(error instanceof TypeError)) throw error
    rejected = true
  }
  if (!rejected) throw new TypeError('Verified observer target cannot be quarantined')
  const evidence = Buffer.from(canonicalBytes({ version: 1, kind: 'observer.replay_rejected',
    feedId: claim.feedId, attemptId: claim.attemptId, targetHash: claim.targetHash,
    targetSize: claim.targetSize }))
  return transaction(store, async client => {
    const cursor = await lockClaim(client, claim)
    if (cursor.active_attempt_id === null || safeCount(cursor.active_attempt_id) !== claim.attemptId
      || safeCount(cursor.staged_next_index) !== claim.targetSize
      || cursor.staged_checkpoint_tail_hash !== claim.targetHash) throw new TypeError('Stale observer target claim')
    if (safeCount(cursor.version) === Number.MAX_SAFE_INTEGER) throw new RangeError('Observer cursor version exhausted')
    const target = await client.query<{ status: string }>(
      'SELECT status FROM observer_targets WHERE feed_id=$1 AND attempt_id=$2', [claim.feedId, claim.attemptId])
    if (target.rows[0]?.status !== 'active') throw new TypeError('Stale observer target claim')
    const finding = await client.query<{ finding_id: string }>(
      `INSERT INTO observer_findings(feed_id, attempt_id, finding_type, evidence_bytes)
       VALUES($1,$2,'invalid_replay',$3) RETURNING finding_id`,
      [claim.feedId, claim.attemptId, evidence])
    await client.query(
      `UPDATE observer_targets SET status='quarantined', finished_at=clock_timestamp()
       WHERE feed_id=$1 AND attempt_id=$2`, [claim.feedId, claim.attemptId])
    await client.query(
      `UPDATE observer_cursors SET staged_next_index=accepted_size, active_attempt_id=NULL,
         staged_checkpoint_tail_hash=NULL, staged_checkpoint_tail_position=NULL,
         version=version+1 WHERE feed_id=$1`, [claim.feedId])
    return safeCount(finding.rows[0]?.finding_id)
  })
}
