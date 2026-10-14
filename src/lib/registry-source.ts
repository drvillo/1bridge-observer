import { decodeBase64Url, parseCanonical, registryCheckpointHash, registryEntryBytes,
  type Hash, type RegistryEntry, type SignedRegistryCheckpoint } from '@drvillo/1bridge-authority'
import { SourceHttpError, SourceProtocolError, SourceTransportError,
  type SourceRequestOptions } from './source'

const HASH = /^[0-9a-f]{64}$/
const HEAD_LIMIT = 64 * 1024
const CHECKPOINT_LIMIT = 64 * 1024
const ENTRY_LIMIT = 256 * 1024
const CONSISTENCY_LIMIT = 16 * 1024

export interface RegistrySourceConfig { sourceBaseUrl: string }
export interface RegistryHead {
  provisional: true
  checkpointHash: Hash
  signedCheckpoint: SignedRegistryCheckpoint
  signedCheckpointBytes: Uint8Array
}
export interface RegistryCheckpointItem {
  bytes: Uint8Array
  signed: SignedRegistryCheckpoint
  hash: Hash
}

function validHash(value: unknown): value is Hash {
  return typeof value === 'string' && HASH.test(value)
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

function fields(value: unknown, expected: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError('Invalid registry envelope')
  const names = Reflect.ownKeys(value)
  if (names.length !== expected.length || names.some(name =>
    typeof name !== 'string' || !expected.includes(name))) throw new TypeError('Invalid registry envelope fields')
  for (const name of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('Invalid registry envelope field')
    }
  }
  return value as Record<string, unknown>
}

function sourceUrl(config: RegistrySourceConfig, route: string, params?: Record<string, string>): string {
  const origin = new URL(config.sourceBaseUrl)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
  if (origin.origin !== config.sourceBaseUrl || origin.username || origin.password
    || origin.hash || origin.search || origin.pathname !== '/'
    || origin.protocol !== 'https:' && !(process.env.NODE_ENV === 'test' && loopback
      && origin.protocol === 'http:')) throw new TypeError('Invalid registry source origin')
  const url = new URL(`/api/governance/v1/registry/${route}`, origin)
  for (const [name, value] of Object.entries(params ?? {})) url.searchParams.set(name, value)
  return url.href
}

async function responseBytes(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) throw new SourceProtocolError('Empty registry response')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      let next: ReadableStreamReadResult<Uint8Array>
      try { next = await reader.read() }
      catch { throw new SourceTransportError('Registry response interrupted') }
      if (next.done) break
      size += next.value.byteLength
      if (size > limit) {
        await reader.cancel().catch(() => undefined)
        throw new SourceProtocolError('Registry response exceeds byte limit')
      }
      chunks.push(next.value)
    }
  } finally { reader.releaseLock() }
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
  return result
}

async function get(config: RegistrySourceConfig, route: string, limit: number,
  params?: Record<string, string>, options: SourceRequestOptions = {}): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? 10_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError('Invalid registry source timeout')
  }
  const url = sourceUrl(config, route, params)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    let response: Response
    try { response = await fetch(url, { method: 'GET', redirect: 'error', cache: 'no-store',
      signal: controller.signal, headers: { accept: 'application/json' } }) }
    catch { throw new SourceTransportError(controller.signal.aborted
      ? 'Registry request timed out' : 'Registry transport unavailable') }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined)
      throw new SourceHttpError(response.status)
    }
    let bytes: Uint8Array
    try { bytes = await responseBytes(response, limit) }
    catch (error) {
      if (controller.signal.aborted) throw new SourceTransportError('Registry request timed out')
      throw error
    }
    try { return parseCanonical(bytes) }
    catch { throw new SourceProtocolError('Invalid canonical registry response') }
  } finally { clearTimeout(timer) }
}

function decoded(value: unknown, limit: number): Uint8Array {
  if (typeof value !== 'string') throw new TypeError('Invalid encoded registry item')
  const bytes = decodeBase64Url(value, limit)
  parseCanonical(bytes)
  return bytes
}

async function checkpointItem(value: unknown): Promise<RegistryCheckpointItem> {
  const bytes = decoded(value, CHECKPOINT_LIMIT)
  const signed = fields(parseCanonical(bytes), ['statement', 'signature']) as unknown as SignedRegistryCheckpoint
  const hash = await registryCheckpointHash(signed.statement)
  return { bytes, signed, hash }
}

function pageItems(value: unknown, limit: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > limit || Reflect.ownKeys(value).length !== value.length + 1) {
    throw new TypeError('Invalid registry page items')
  }
  return value
}

async function protocol<T>(read: () => Promise<T>): Promise<T> {
  try { return await read() }
  catch { throw new SourceProtocolError('Registry response violates protocol') }
}

export async function discoverRegistryHead(config: RegistrySourceConfig,
  options?: SourceRequestOptions): Promise<RegistryHead> {
  const data = await get(config, 'head', HEAD_LIMIT, undefined, options)
  return protocol(async () => {
    const envelope = fields(data, ['version', 'signedCheckpoint', 'checkpointHash'])
    if (envelope.version !== 1 || !validHash(envelope.checkpointHash)) {
      throw new TypeError('Invalid registry head')
    }
    const item = await checkpointItem(envelope.signedCheckpoint)
    if (item.hash !== envelope.checkpointHash) throw new TypeError('Registry head hash mismatch')
    return { provisional: true, checkpointHash: item.hash,
      signedCheckpoint: item.signed, signedCheckpointBytes: item.bytes }
  })
}

export async function fetchRegistryCheckpointPage(config: RegistrySourceConfig,
  target: Hash, after: Hash | 'start', limit: number,
  options?: SourceRequestOptions): Promise<{ items: RegistryCheckpointItem[] }> {
  if (!validHash(target) || after !== 'start' && !validHash(after)
    || !count(limit) || limit < 1 || limit > 16) throw new TypeError('Invalid registry checkpoint request')
  const data = await get(config, 'checkpoints', CHECKPOINT_LIMIT,
    { target, after, limit: String(limit) }, options)
  return protocol(async () => {
    const envelope = fields(data, ['version', 'target', 'after', 'items'])
    if (envelope.version !== 1 || envelope.target !== target || envelope.after !== after) {
      throw new TypeError('Registry checkpoint echo mismatch')
    }
    const encoded = pageItems(envelope.items, limit)
    if (encoded.length === 0 && after !== target || encoded.length > 0 && after === target) {
      throw new TypeError('Invalid terminal registry checkpoint page')
    }
    const result: RegistryCheckpointItem[] = []
    let predecessor: Hash | null = after === 'start' ? null : after
    let decodedSize = 0
    for (const value of encoded) {
      const item = await checkpointItem(value)
      decodedSize += item.bytes.byteLength
      if (decodedSize > CHECKPOINT_LIMIT || item.signed.statement.previous !== predecessor
        || predecessor === null && item.signed.statement.size !== 0
        || item.hash === target && result.length !== encoded.length - 1) {
        throw new TypeError('Registry checkpoint gap or page overflow')
      }
      predecessor = item.hash
      result.push(item)
    }
    return { items: result }
  })
}

export async function fetchRegistryEntryPage(config: RegistrySourceConfig,
  target: Hash, start: number, targetSize: number, limit: number,
  options?: SourceRequestOptions): Promise<{ items: Uint8Array[] }> {
  if (!validHash(target) || !count(start) || !count(targetSize) || start > targetSize
    || !count(limit) || limit < 1 || limit > 64) throw new TypeError('Invalid registry entry request')
  const data = await get(config, 'entries', ENTRY_LIMIT,
    { target, start: String(start), limit: String(limit) }, options)
  return protocol(async () => {
    const envelope = fields(data, ['version', 'target', 'start', 'items'])
    if (envelope.version !== 1 || envelope.target !== target || envelope.start !== start) {
      throw new TypeError('Registry entry echo mismatch')
    }
    const encoded = pageItems(envelope.items, limit)
    if (encoded.length === 0 && start !== targetSize || encoded.length > targetSize - start) {
      throw new TypeError('Registry entry page skips or extends target')
    }
    let decodedSize = 0
    const result: Uint8Array[] = []
    for (const value of encoded) {
      const bytes = decoded(value, 32 * 1024)
      decodedSize += bytes.byteLength
      if (decodedSize > ENTRY_LIMIT) throw new TypeError('Decoded registry page exceeds byte limit')
      const entry = parseCanonical(bytes) as unknown as RegistryEntry
      const expectedBytes = registryEntryBytes(entry)
      if (entry.index !== start + result.length
        || expectedBytes.length !== bytes.length
        || !bytes.every((byte, index) => byte === expectedBytes[index])) {
        throw new TypeError('Registry entry index or canonical bytes mismatch')
      }
      result.push(bytes)
    }
    return { items: result }
  })
}

export async function fetchRegistryConsistency(config: RegistrySourceConfig,
  old: Hash, target: Hash, options?: SourceRequestOptions): Promise<Hash[]> {
  if (!validHash(old) || !validHash(target)) throw new TypeError('Invalid registry consistency request')
  const data = await get(config, 'consistency', CONSISTENCY_LIMIT, { old, target }, options)
  return protocol(async () => {
    const envelope = fields(data, ['version', 'old', 'target', 'proof'])
    if (envelope.version !== 1 || envelope.old !== old || envelope.target !== target) {
      throw new TypeError('Registry consistency echo mismatch')
    }
    const proof = pageItems(envelope.proof, 64)
    if (proof.some(item => !validHash(item))) throw new TypeError('Invalid registry consistency hash')
    return proof as Hash[]
  })
}
