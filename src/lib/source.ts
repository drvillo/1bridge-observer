import {
  authorityStateSnapshot,
  checkpointHash,
  decodeBase64Url,
  parseCanonical,
  verifyAuthorityAnchor,
  type SignedCheckpoint,
} from '@drvillo/1bridge-authority'
import { verifyObserverAnchor, type ObserverConfig } from './config'

const HASH = /^[0-9a-f]{64}$/
const HEAD_LIMIT = 64 * 1024
const CHECKPOINT_LIMIT = 64 * 1024
const LEAF_LIMIT = 256 * 1024
const DEFAULT_TIMEOUT_MS = 10_000

export interface SourceRequestOptions { timeoutMs?: number }
export interface ProvisionalFeedHead {
  provisional: true
  checkpointHash: string
  signedCheckpoint: SignedCheckpoint
  signedCheckpointBytes: Uint8Array
}
export interface CheckpointPageItem {
  bytes: Uint8Array
  signed: SignedCheckpoint
  hash: string
}

export class SourceHttpError extends Error {
  constructor(readonly status: number) { super(`Source HTTP ${status}`) }
}

export class SourceProtocolError extends Error {}
export class SourceTransportError extends Error {}

function record(value: unknown, fields: string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid source envelope')
  const keys = Object.keys(value)
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) throw new TypeError('Invalid source envelope fields')
  return value as Record<string, unknown>
}

function hash(value: unknown): value is string { return typeof value === 'string' && HASH.test(value) }
function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

function requestUrl(config: ObserverConfig, route: string, params?: Record<string, string>): string {
  const origin = new URL(config.sourceBaseUrl)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
  if (origin.origin !== config.sourceBaseUrl || origin.username || origin.password || origin.hash || origin.search) {
    throw new TypeError('Invalid source origin')
  }
  if (origin.protocol !== 'https:' && !(process.env.NODE_ENV === 'test' && loopback && origin.protocol === 'http:')) {
    throw new TypeError('Invalid source origin protocol')
  }
  if (!hash(config.feedId)) throw new TypeError('Invalid feed ID')
  const url = new URL(`/api/governance/v1/feeds/${config.feedId}/${route}`, origin)
  for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value)
  return url.href
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) throw new SourceProtocolError('Empty source response')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      let next: ReadableStreamReadResult<Uint8Array>
      try { next = await reader.read() } catch { throw new SourceTransportError('Source response interrupted') }
      if (next.done) break
      size += next.value.byteLength
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new SourceProtocolError('Decoded source response exceeds byte limit')
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}

async function getEnvelope(config: ObserverConfig, route: string, maxBytes: number,
  params?: Record<string, string>, options: SourceRequestOptions = {}): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new TypeError('Invalid source timeout')
  const url = requestUrl(config, route, params)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    let response: Response
    try {
      response = await fetch(url, {
        method: 'GET', redirect: 'error', cache: 'no-store', signal: controller.signal,
        headers: { accept: 'application/json' },
      })
    } catch {
      throw new SourceTransportError(controller.signal.aborted ? 'Source request timed out' : 'Source transport unavailable')
    }
    if (!response.ok) throw new SourceHttpError(response.status)
    let bytes: Uint8Array
    try { bytes = await readBoundedResponse(response, maxBytes) } catch (error) {
      if (controller.signal.aborted) throw new SourceTransportError('Source request timed out')
      throw error
    }
    try { return parseCanonical(bytes) } catch { throw new SourceProtocolError('Invalid canonical source response') }
  } finally {
    clearTimeout(timer)
  }
}

async function parseSourceData<T>(parser: () => Promise<T>): Promise<T> {
  try { return await parser() } catch { throw new SourceProtocolError('Source response violates protocol') }
}

function decoded(value: unknown, limit: number): Uint8Array {
  if (typeof value !== 'string') throw new TypeError('Invalid source encoded item')
  const bytes = decodeBase64Url(value, limit)
  parseCanonical(bytes)
  return bytes
}

async function checkpointItem(value: unknown): Promise<CheckpointPageItem> {
  const bytes = decoded(value, CHECKPOINT_LIMIT)
  const signed = record(parseCanonical(bytes), ['statement', 'signature']) as unknown as SignedCheckpoint
  if (typeof signed.signature !== 'string' || decodeBase64Url(signed.signature, 64).length !== 64) {
    throw new TypeError('Invalid source checkpoint signature')
  }
  const statementHash = await checkpointHash(signed.statement)
  return { bytes, signed, hash: statementHash }
}

function items(value: unknown, maxItems: number): unknown[] {
  if (!Array.isArray(value) || value.length > maxItems || Object.keys(value).length !== value.length) {
    throw new TypeError('Invalid source page items')
  }
  return value
}

export async function discoverFeedHead(config: ObserverConfig, options?: SourceRequestOptions): Promise<ProvisionalFeedHead> {
  await verifyObserverAnchor(config)
  const data = await getEnvelope(config, 'head', HEAD_LIMIT, undefined, options)
  return parseSourceData(async () => {
    const envelope = record(data,
      ['version', 'signedAnchor', 'signedCheckpoint', 'checkpointHash'])
    if (envelope.version !== 1 || !hash(envelope.checkpointHash)) throw new TypeError('Invalid source head')
    const signedAnchor = parseCanonical(decoded(envelope.signedAnchor, 16_384))
    const anchorState = await verifyAuthorityAnchor(signedAnchor as unknown as Parameters<typeof verifyAuthorityAnchor>[0], config.anchorPin)
    if (authorityStateSnapshot(anchorState).feedId !== config.feedId) throw new TypeError('Source anchor feed mismatch')
    const item = await checkpointItem(envelope.signedCheckpoint)
    if (item.signed.statement.feedId !== config.feedId || item.hash !== envelope.checkpointHash) {
      throw new TypeError('Source head hash or feed mismatch')
    }
    return { provisional: true, checkpointHash: item.hash, signedCheckpoint: item.signed, signedCheckpointBytes: item.bytes }
  })
}

export async function fetchCheckpointPage(config: ObserverConfig, target: string, after: string,
  limit: number, options?: SourceRequestOptions): Promise<{ items: CheckpointPageItem[] }> {
  if (!hash(target) || (after !== 'start' && !hash(after)) || !count(limit) || limit < 1 || limit > 16) {
    throw new TypeError('Invalid checkpoint page request')
  }
  const data = await getEnvelope(config, 'checkpoints', CHECKPOINT_LIMIT,
    { after, target, limit: String(limit) }, options)
  return parseSourceData(async () => {
    const envelope = record(data, ['version', 'target', 'after', 'items'])
    if (envelope.version !== 1 || envelope.target !== target || envelope.after !== after) {
      throw new TypeError('Source checkpoint page echo mismatch')
    }
    const encoded = items(envelope.items, limit)
    if (encoded.length === 0 && after !== target) throw new TypeError('Empty nonterminal checkpoint page')
    if (encoded.length > 0 && after === target) throw new TypeError('Checkpoint page beyond target')
    const result: CheckpointPageItem[] = []
    let predecessor: string | null = after === 'start' ? null : after
    let decodedBytes = 0
    for (const value of encoded) {
      const item = await checkpointItem(value)
      decodedBytes += item.bytes.byteLength
      if (decodedBytes > CHECKPOINT_LIMIT) throw new RangeError('Decoded checkpoint items exceed byte limit')
      if (item.signed.statement.feedId !== config.feedId || item.signed.statement.previous !== predecessor) {
        throw new TypeError('Checkpoint page skips predecessor or feed')
      }
      if (predecessor === null && item.signed.statement.size !== 0) throw new TypeError('Checkpoint page lacks genesis')
      if (item.hash === target && result.length !== encoded.length - 1) throw new TypeError('Checkpoint page extends target')
      predecessor = item.hash
      result.push(item)
    }
    return { items: result }
  })
}

export async function fetchLeafPage(config: ObserverConfig, target: string, start: number,
  targetSize: number, limit: number, options?: SourceRequestOptions): Promise<{ items: Uint8Array[] }> {
  if (!hash(target) || !count(start) || !count(targetSize) || start > targetSize ||
    !count(limit) || limit < 1 || limit > 64) throw new TypeError('Invalid leaf page request')
  const data = await getEnvelope(config, 'leaves', LEAF_LIMIT,
    { start: String(start), target, limit: String(limit) }, options)
  return parseSourceData(async () => {
    const envelope = record(data, ['version', 'target', 'start', 'items'])
    if (envelope.version !== 1 || envelope.target !== target || envelope.start !== start) {
      throw new TypeError('Source leaf page echo mismatch')
    }
    const encoded = items(envelope.items, limit)
    if (encoded.length === 0 && start !== targetSize) throw new TypeError('Empty nonterminal leaf page')
    if (encoded.length > targetSize - start) throw new TypeError('Leaf page extends target')
    const result: Uint8Array[] = []
    let decodedBytes = 0
    for (const value of encoded) {
      const bytes = decoded(value, LEAF_LIMIT)
      decodedBytes += bytes.byteLength
      if (decodedBytes > LEAF_LIMIT) throw new RangeError('Decoded leaf items exceed byte limit')
      result.push(bytes)
    }
    return { items: result }
  })
}
