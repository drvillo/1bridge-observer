import { createServer } from 'node:http'
import * as authority from '@drvillo/1bridge-authority'

const FEED = 'a'.repeat(64)
const WORKSPACE = 'b'.repeat(64)
const ALICE = 'c'.repeat(64)
const BOB = 'd'.repeat(64)
const WRONG = '0'.repeat(64)

export interface GovernanceSourceHistory {
  signedAnchor: authority.SignedAuthorityAnchor
  anchorPin: string
  leaves: Uint8Array[]
  checkpoints: authority.SignedCheckpoint[]
  wrongRoot: authority.SignedCheckpoint
  wrongPolicy: authority.SignedCheckpoint
  resignedFinal: authority.SignedCheckpoint
  alternateLastLeaf: Uint8Array
  actorKeyIds: string[]
  rotatedPublicKey: CryptoKey
  firstActionHash: string
  firstReceipt: authority.CompletionReceipt
  secondReceipt: authority.CompletionReceipt
  secondActionPredecessor: string | null
  suppressedFirst: {
    leaves: Uint8Array[]
    checkpoints: authority.SignedCheckpoint[]
    laterActionPredecessor: string | null
  }
  suppressedWithoutCitation: {
    leaves: Uint8Array[]
    checkpoints: authority.SignedCheckpoint[]
  }
}

async function revision(state: authority.AuthorityState, operation: authority.AuthorityOperation,
  root: CryptoKeyPair): Promise<authority.SignedAuthorityRevision> {
  const current = authority.authorityStateSnapshot(state)
  const bindings = current.bindings.filter(item => !('binding' in operation) || item.subjectId !== operation.binding.subjectId)
  if ('binding' in operation) bindings.push(operation.binding)
  const entries = await Promise.all(bindings.map(async item => ({
    key: await authority.authorityMapKey(item.subjectId), valueHash: await authority.authorityBindingHash(item),
  })))
  entries.sort((a, b) => a.key.localeCompare(b.key))
  return authority.signAuthorityRevision({ version: 1, feedId: FEED, workspaceId: WORKSPACE,
    number: current.revision + 1, previous: current.revisionHash, previousRoot: current.authorityRoot,
    expectedPolicyEpoch: current.policyEpoch, operation,
    authorityRoot: 'binding' in operation ? await authority.orderedMapRoot(entries) : current.authorityRoot,
    policyEpoch: current.policyEpoch + (operation.kind === 'policy' ? 1 : 0),
    signerKeyId: await authority.signingKeyId(root.publicKey) }, root)
}

async function binding(subjectId: string, pair: CryptoKeyPair): Promise<authority.ActiveBinding> {
  return { subjectId, keySpki: await authority.exportSigningPublicKey(pair.publicKey),
    keyId: await authority.signingKeyId(pair.publicKey), version: 1,
    scope: { kind: 'workspace', workspaceId: WORKSPACE }, actionClasses: ['document.read'],
    recipientKeyCommitment: null, status: 'active' }
}

async function checkpoint(leaves: Uint8Array[], state: authority.AuthorityState,
  previous: authority.SignedCheckpoint | null, signer: CryptoKeyPair): Promise<authority.SignedCheckpoint> {
  const current = authority.authorityStateSnapshot(state)
  return authority.signCheckpoint({ version: 1, feedId: FEED, size: leaves.length,
    historyRoot: await authority.merkleRoot(leaves), authorityRoot: current.authorityRoot,
    policyEpoch: current.policyEpoch, signerKeyId: await authority.signingKeyId(signer.publicKey),
    previous: previous ? await authority.checkpointHash(previous.statement) : null }, signer)
}

async function action(state: authority.AuthorityState, observed: authority.SignedCheckpoint,
  signer: CryptoKeyPair, subjectId: string, operationId: string,
  previousReceipt: authority.CompletionReceipt | null = null): Promise<authority.SignedAction> {
  const current = authority.authorityStateSnapshot(state)
  const actor = current.bindings.find(item => item.subjectId === subjectId)
  if (!actor) throw new TypeError('Missing fixture actor')
  return authority.signGovernanceAction({ version: 1, feedId: FEED, workspaceId: WORKSPACE, operationId,
    actorSubjectId: subjectId, actorKeyId: await authority.signingKeyId(signer.publicKey), actorVersion: actor.version,
    scope: { kind: 'workspace', workspaceId: WORKSPACE }, actionClass: 'document.read',
    authorityRevision: current.revision, authorityRevisionHash: current.revisionHash,
    authorityRoot: current.authorityRoot, policyEpoch: current.policyEpoch, observerPolicyHash: current.observerPolicyHash,
    intentCommitment: 'e'.repeat(64), effectCommitment: 'f'.repeat(64),
    observedCheckpointHash: await authority.checkpointHash(observed.statement),
    previousActionHash: previousReceipt?.actionHash ?? null, previousReceipt }, signer)
}

async function receipt(signed: authority.SignedAction, leaf: Uint8Array, index: number,
  leaves: Uint8Array[], head: authority.SignedCheckpoint): Promise<authority.CompletionReceipt> {
  return { version: 1, status: 'integrated', feedId: FEED, operationId: signed.statement.operationId,
    actionHash: await authority.governanceActionHash(signed.statement),
    effectCommitment: signed.statement.effectCommitment, leafIndex: index,
    leafHash: await authority.hashLeaf(leaf), checkpoint: head,
    inclusionProof: await authority.inclusionProof(leaves, index) }
}

export async function buildGovernanceSource(): Promise<GovernanceSourceHistory> {
  const [root, recovery, provider, rotated, alice, bob] = await Promise.all([
    authority.generateSigningKey(), authority.generateSigningKey(), authority.generateSigningKey(),
    authority.generateSigningKey(), authority.generateSigningKey(), authority.generateSigningKey(),
  ])
  const anchor = await authority.createAuthorityAnchor({ feedId: FEED, workspaceId: WORKSPACE,
    rootPublicKey: root.publicKey, recoveryPublicKey: recovery.publicKey, checkpointPublicKey: provider.publicKey })
  const signedAnchor = await authority.signAuthorityAnchor(anchor, root, recovery)
  const anchorPin = await authority.anchorHash(anchor)
  let state = await authority.verifyAuthorityAnchor(signedAnchor, anchorPin)
  const leaves: Uint8Array[] = []
  const checkpoints = [await checkpoint(leaves, state, null, provider)]
  async function seal(signer: CryptoKeyPair) {
    checkpoints.push(await checkpoint(leaves, state, checkpoints.at(-1)!, signer))
  }
  async function appendRevision(operation: authority.AuthorityOperation, signer: CryptoKeyPair) {
    const signed = await revision(state, operation, root)
    state = await authority.applyAuthorityRevision(state, signed)
    leaves.push(authority.authorityRevisionLeaf(signed))
    await seal(signer)
    return signed
  }
  async function appendAction(signer: CryptoKeyPair, subject: string, operationId: string,
    predecessor: authority.CompletionReceipt | null, providerSigner: CryptoKeyPair) {
    const signed = await action(state, checkpoints.at(-1)!, signer, subject, operationId, predecessor)
    const index = leaves.length
    const leaf = authority.governanceCompletionLeaf(signed)
    leaves.push(leaf)
    await seal(providerSigner)
    return { signed, integrated: await receipt(signed, leaf, index, leaves, checkpoints.at(-1)!) }
  }

  await appendRevision({ kind: 'bind', binding: await binding(ALICE, alice) }, provider)
  const first = await appendAction(alice, ALICE, '1'.repeat(64), null, provider)
  const bobRevision = await appendRevision({ kind: 'bind', binding: await binding(BOB, bob) }, provider)
  const afterBob = state
  await appendAction(bob, BOB, '2'.repeat(64), null, provider)
  const policyBody = { strictAudit: true }
  const policyRevision = await appendRevision({ kind: 'policy', body: policyBody,
    policyHash: await authority.observerPolicyHash(policyBody) }, provider)
  const afterPolicy = state
  const rotationRevision = await appendRevision({ kind: 'rotate-checkpoint',
    checkpointKeySpki: await authority.exportSigningPublicKey(rotated.publicKey),
    checkpointKeyId: await authority.signingKeyId(rotated.publicKey) }, rotated)
  const afterRotation = state
  const second = await appendAction(alice, ALICE, '3'.repeat(64), first.integrated, rotated)

  // The publisher signs an otherwise coherent branch omitting Alice's first action.
  // Alice's later signed action still carries the independently retained receipt for it.
  const suppressedLeaves = [leaves[0]!]
  const suppressedCheckpoints = [checkpoints[0]!, checkpoints[1]!]
  async function sealSuppressed(branchState: authority.AuthorityState, signer: CryptoKeyPair) {
    suppressedCheckpoints.push(await checkpoint(suppressedLeaves, branchState,
      suppressedCheckpoints.at(-1)!, signer))
  }
  suppressedLeaves.push(authority.authorityRevisionLeaf(bobRevision))
  await sealSuppressed(afterBob, provider)
  const suppressedBobAction = await action(afterBob, suppressedCheckpoints.at(-1)!, bob, BOB, '2'.repeat(64))
  suppressedLeaves.push(authority.governanceCompletionLeaf(suppressedBobAction))
  await sealSuppressed(afterBob, provider)
  suppressedLeaves.push(authority.authorityRevisionLeaf(policyRevision))
  await sealSuppressed(afterPolicy, provider)
  suppressedLeaves.push(authority.authorityRevisionLeaf(rotationRevision))
  await sealSuppressed(afterRotation, rotated)
  const suppressedLaterAction = await action(afterRotation, suppressedCheckpoints.at(-1)!,
    alice, ALICE, '3'.repeat(64), first.integrated)
  suppressedLeaves.push(authority.governanceCompletionLeaf(suppressedLaterAction))
  await sealSuppressed(afterRotation, rotated)
  const unlinkedAction = await action(afterRotation, suppressedCheckpoints.at(-2)!,
    alice, ALICE, '3'.repeat(64))
  const unlinkedLeaves = [...suppressedLeaves.slice(0, -1), authority.governanceCompletionLeaf(unlinkedAction)]
  const unlinkedCheckpoints = [...suppressedCheckpoints.slice(0, -1),
    await checkpoint(unlinkedLeaves, afterRotation, suppressedCheckpoints.at(-2)!, rotated)]
  const alternate = await action(state, checkpoints.at(-2)!, alice, ALICE, '4'.repeat(64), first.integrated)
  const alternateLastLeaf = authority.governanceCompletionLeaf(alternate)
  const final = checkpoints.at(-1)!
  const wrongRoot = await authority.signCheckpoint({ ...final.statement, authorityRoot: WRONG }, rotated)
  const wrongPolicy = await authority.signCheckpoint({ ...final.statement, policyEpoch: final.statement.policyEpoch + 1 }, rotated)
  const resignedFinal = await authority.signCheckpoint(final.statement, rotated)
  return { signedAnchor, anchorPin, leaves, checkpoints, wrongRoot, wrongPolicy, resignedFinal, alternateLastLeaf,
    actorKeyIds: [await authority.signingKeyId(alice.publicKey), await authority.signingKeyId(bob.publicKey)],
    rotatedPublicKey: rotated.publicKey, firstReceipt: first.integrated, secondReceipt: second.integrated,
    firstActionHash: first.integrated.actionHash, secondActionPredecessor: second.signed.statement.previousActionHash,
    suppressedFirst: { leaves: suppressedLeaves, checkpoints: suppressedCheckpoints,
      laterActionPredecessor: suppressedLaterAction.statement.previousActionHash },
    suppressedWithoutCitation: { leaves: unlinkedLeaves, checkpoints: unlinkedCheckpoints } }
}

export interface GovernanceSourceServer {
  baseUrl: string
  calls: URL[]
  close(): Promise<void>
}

export interface GovernanceSourceFaults {
  omitGenesis?: boolean
  omitTarget?: boolean
  skipLeaf?: boolean
  changeLastLeaf?: boolean
  unavailableLeaves?: boolean
}

export async function startGovernanceSource(history: Pick<GovernanceSourceHistory,
  'signedAnchor' | 'leaves' | 'checkpoints' | 'alternateLastLeaf'>,
  candidate: authority.SignedCheckpoint = history.checkpoints.at(-1)!,
  pageCandidate: authority.SignedCheckpoint = candidate,
  faults: GovernanceSourceFaults = {}): Promise<GovernanceSourceServer> {
  const checkpoints = [...history.checkpoints.slice(0, -1), pageCandidate]
  const hashes = await Promise.all(checkpoints.map(item => authority.checkpointHash(item.statement)))
  const target = hashes.at(-1)!
  const calls: URL[] = []
  const prefix = `/api/governance/v1/feeds/${FEED}`
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    calls.push(url)
    const requestedTarget = url.searchParams.get('target')
    const limit = Number(url.searchParams.get('limit'))
    let body: unknown
    if (url.pathname === `${prefix}/head`) {
      body = { version: 1, signedAnchor: authority.encodeBase64Url(authority.canonicalBytes(history.signedAnchor)),
        signedCheckpoint: authority.encodeBase64Url(authority.canonicalBytes(candidate)), checkpointHash: target }
    } else if (url.pathname === `${prefix}/checkpoints` && requestedTarget === target
      && Number.isSafeInteger(limit) && limit >= 1 && limit <= 16) {
      const after = url.searchParams.get('after')
      const index = after === 'start' ? (faults.omitGenesis ? 1 : 0) : hashes.indexOf(after ?? '') + 1
      if (index < 0 || (after !== 'start' && !hashes.includes(after ?? ''))) {
        res.writeHead(409); res.end(); return
      }
      body = { version: 1, target, after,
        items: checkpoints.slice(index, Math.min(index + limit, checkpoints.length - (faults.omitTarget ? 1 : 0)))
          .map(item => authority.encodeBase64Url(authority.canonicalBytes(item))) }
    } else if (url.pathname === `${prefix}/leaves` && requestedTarget === target
      && Number.isSafeInteger(limit) && limit >= 1 && limit <= 64) {
      if (faults.unavailableLeaves) { res.writeHead(503); res.end(); return }
      const start = Number(url.searchParams.get('start'))
      if (!Number.isSafeInteger(start) || start < 0 || start > candidate.statement.size) {
        res.writeHead(400); res.end(); return
      }
      const offset = faults.skipLeaf && start === history.leaves.length - 1 ? 1 : 0
      const selected = history.leaves.slice(start + offset,
        Math.min(start + limit + offset, candidate.statement.size))
      body = { version: 1, target, start,
        items: selected.map((leaf, index) => authority.encodeBase64Url(
          faults.changeLastLeaf && start + offset + index === history.leaves.length - 1
            ? history.alternateLastLeaf : leaf)) }
    } else {
      res.writeHead(404); res.end(); return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(authority.canonicalJson(body))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind TCP port')
  return { baseUrl: `http://127.0.0.1:${address.port}`, calls,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}
