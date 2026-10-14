import { createServer, type Server } from 'node:http'
import {
  anchorHash,
  authorityStateSnapshot,
  canonicalBytes,
  canonicalJson,
  checkpointHash,
  createAuthorityAnchor,
  encodeBase64Url,
  generateSigningKey,
  merkleRoot,
  signAuthorityAnchor,
  signCheckpoint,
  signingKeyId,
  verifyAuthorityAnchor,
  type SignedCheckpoint,
} from '@drvillo/1bridge-authority'

const FEED = 'a'.repeat(64)
const WORKSPACE = 'b'.repeat(64)

export interface FixtureReply {
  status?: number
  bytes?: Uint8Array
  headers?: Record<string, string>
  delayMs?: number
}

export interface SourceFixture {
  baseUrl: string
  feedId: string
  anchorPin: string
  signedAnchor: string
  signedCheckpoints: SignedCheckpoint[]
  leaves: Uint8Array[]
  calls: URL[]
  override: ((url: URL) => FixtureReply | undefined) | undefined
  close(): Promise<void>
}

export async function startSourceFixture(): Promise<SourceFixture> {
  const [root, recovery, provider] = await Promise.all([
    generateSigningKey(), generateSigningKey(), generateSigningKey(),
  ])
  const anchor = await createAuthorityAnchor({
    feedId: FEED,
    workspaceId: WORKSPACE,
    rootPublicKey: root.publicKey,
    recoveryPublicKey: recovery.publicKey,
    checkpointPublicKey: provider.publicKey,
  })
  const signed = await signAuthorityAnchor(anchor, root, recovery)
  const anchorPin = await anchorHash(anchor)
  const authorityRoot = authorityStateSnapshot(await verifyAuthorityAnchor(signed, anchorPin)).authorityRoot
  const signedAnchor = encodeBase64Url(canonicalBytes(signed))
  const leaves = [canonicalBytes({ kind: 'fixture.one' }), canonicalBytes({ kind: 'fixture.two' })]
  const signerKeyId = await signingKeyId(provider.publicKey)
  const initial = await signCheckpoint({ version: 1, feedId: FEED, size: 0,
    historyRoot: await merkleRoot([]), authorityRoot, policyEpoch: 0,
    signerKeyId, previous: null }, provider)
  const first = await signCheckpoint({ version: 1, feedId: FEED, size: 1,
    historyRoot: await merkleRoot(leaves.slice(0, 1)), authorityRoot, policyEpoch: 0,
    signerKeyId, previous: await checkpointHash(initial.statement) }, provider)
  const second = await signCheckpoint({ version: 1, feedId: FEED, size: 2,
    historyRoot: await merkleRoot(leaves), authorityRoot, policyEpoch: 0,
    signerKeyId, previous: await checkpointHash(first.statement) }, provider)
  const signedCheckpoints = [initial, first, second]
  const target = await checkpointHash(second.statement)
  const calls: URL[] = []
  const fixture: SourceFixture = {
    baseUrl: '', feedId: FEED, anchorPin, signedAnchor, signedCheckpoints, leaves, calls,
    override: undefined,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  }

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    calls.push(url)
    const altered = fixture.override?.(url)
    if (altered?.delayMs) await new Promise(resolve => setTimeout(resolve, altered.delayMs))
    if (altered) {
      res.writeHead(altered.status ?? 200, altered.headers)
      res.end(altered.bytes)
      return
    }
    const prefix = `/api/governance/v1/feeds/${FEED}`
    let body: unknown
    if (url.pathname === `${prefix}/head`) {
      body = { version: 1, signedAnchor, signedCheckpoint: encodeBase64Url(canonicalBytes(second)), checkpointHash: target }
    } else if (url.pathname === `${prefix}/checkpoints`) {
      const after = url.searchParams.get('after')
      const limit = Number(url.searchParams.get('limit'))
      if (url.searchParams.get('target') !== target || !Number.isInteger(limit) || limit < 1 || limit > 16) {
        res.writeHead(400); res.end(); return
      }
      const hashes = await Promise.all(signedCheckpoints.map(item => checkpointHash(item.statement)))
      const start = after === 'start' ? 0 : hashes.indexOf(after ?? '') + 1
      if (start < 0 || (after !== 'start' && !hashes.includes(after ?? ''))) {
        res.writeHead(409); res.end(); return
      }
      body = { version: 1, target, after, items: signedCheckpoints.slice(start, start + limit).map(item => encodeBase64Url(canonicalBytes(item))) }
    } else if (url.pathname === `${prefix}/leaves`) {
      const start = Number(url.searchParams.get('start'))
      const limit = Number(url.searchParams.get('limit'))
      if (url.searchParams.get('target') !== target || !Number.isInteger(start) || start < 0 || !Number.isInteger(limit) || limit < 1 || limit > 64) {
        res.writeHead(400); res.end(); return
      }
      body = { version: 1, target, start, items: leaves.slice(start, start + limit).map(encodeBase64Url) }
    } else {
      res.writeHead(404); res.end(); return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(canonicalJson(body))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind TCP port')
  fixture.baseUrl = `http://127.0.0.1:${address.port}`
  return fixture
}
