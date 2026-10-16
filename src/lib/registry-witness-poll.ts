import { canonicalBytes, registryCheckpointHash, signRegistryWitness, verifyRegistryCheckpoint,
  type SignedRegistryWitness } from '@drvillo/1bridge-authority'
import { createHash } from 'node:crypto'
import { verifyRegistryPin, type SharedObserverConfig } from './config'
import { discoverRegistryHead, fetchRegistryConsistency } from './registry-source'
import { SourceHttpError, SourceTransportError } from './source'
import { acceptRegistryWitness, readWitnessCursor, readWitnessFindings,
  recordWitnessFinding } from './registry-witness-store'
import type { ObserverStore } from './store'

export interface RegistryWitnessPollResult {
  status: 'accepted' | 'up_to_date' | 'busy' | 'unavailable' | 'source_nonconforming'
  report?: SignedRegistryWitness
}

async function refreshReport(store: ObserverStore, pin: Awaited<ReturnType<typeof verifyRegistryPin>>,
  signer: CryptoKeyPair): Promise<SignedRegistryWitness | undefined> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const cursor = await readWitnessCursor(store, pin)
    const report = await signRegistryWitness(cursor.accepted, cursor.accepted, [],
      await readWitnessFindings(store), new Date().toISOString(), signer, pin.publisherKey)
    const reportHash = createHash('sha256').update(canonicalBytes(report)).digest('hex')
    if (await acceptRegistryWitness(store, cursor, cursor.accepted, cursor.acceptedHash,
      report, reportHash)) return report
  }
  return undefined
}

/** Observe a signed global Merkle root without downloading customer feeds. */
export async function pollRegistryWitnessOnce(store: ObserverStore, config: SharedObserverConfig,
  signer: CryptoKeyPair): Promise<RegistryWitnessPollResult> {
  const pin = await verifyRegistryPin(config)
  const cursor = await readWitnessCursor(store, pin)
  let head: Awaited<ReturnType<typeof discoverRegistryHead>>
  try { head = await discoverRegistryHead(config) }
  catch (error) {
    if (error instanceof SourceHttpError || error instanceof SourceTransportError) {
      return { status: 'unavailable' }
    }
    await recordWitnessFinding(store, { version: 2, kind: 'registry_source_protocol',
      acceptedHash: cursor.acceptedHash,
      error: error instanceof Error ? error.name : 'UnknownError' })
    return { status: 'source_nonconforming',
      report: await refreshReport(store, pin, signer) }
  }
  if (!await verifyRegistryCheckpoint(head.signedCheckpoint, pin.publisherKey)) {
    await recordWitnessFinding(store, { version: 2, kind: 'registry_invalid_signature',
      acceptedHash: cursor.acceptedHash, offered: head.signedCheckpoint }, head.checkpointHash)
    return { status: 'source_nonconforming',
      report: await refreshReport(store, pin, signer) }
  }
  if (head.checkpointHash === cursor.acceptedHash) {
    const report = await refreshReport(store, pin, signer)
    return report ? { status: 'up_to_date', report } : { status: 'busy' }
  }
  if (head.signedCheckpoint.statement.size <= cursor.acceptedSize) {
    await recordWitnessFinding(store, { version: 2, kind: 'registry_regression',
      acceptedHash: cursor.acceptedHash, offered: head.signedCheckpoint }, head.checkpointHash)
    return { status: 'source_nonconforming',
      report: await refreshReport(store, pin, signer) }
  }
  let proof: Awaited<ReturnType<typeof fetchRegistryConsistency>>
  try {
    proof = await fetchRegistryConsistency(config, cursor.acceptedHash, head.checkpointHash)
  } catch (error) {
    if (error instanceof SourceHttpError || error instanceof SourceTransportError) {
      return { status: 'unavailable' }
    }
    await recordWitnessFinding(store, { version: 2, kind: 'registry_consistency_protocol',
      acceptedHash: cursor.acceptedHash, offered: head.signedCheckpoint,
      error: error instanceof Error ? error.name : 'UnknownError' }, head.checkpointHash)
    return { status: 'source_nonconforming',
      report: await refreshReport(store, pin, signer) }
  }
  let report: SignedRegistryWitness
  try {
    report = await signRegistryWitness(cursor.accepted, head.signedCheckpoint, proof,
      await readWitnessFindings(store, head.checkpointHash),
      new Date().toISOString(), signer, pin.publisherKey)
  } catch (error) {
    if (!(error instanceof TypeError)) throw error
    await recordWitnessFinding(store, { version: 2, kind: 'registry_invalid_extension',
      acceptedHash: cursor.acceptedHash, offered: head.signedCheckpoint, proof }, head.checkpointHash)
    return { status: 'source_nonconforming',
      report: await refreshReport(store, pin, signer) }
  }
  const targetHash = await registryCheckpointHash(head.signedCheckpoint.statement)
  const reportHash = createHash('sha256').update(canonicalBytes(report)).digest('hex')
  const accepted = await acceptRegistryWitness(store, cursor, head.signedCheckpoint, targetHash,
    report, reportHash)
  return accepted ? { status: 'accepted', report } : { status: 'busy' }
}
