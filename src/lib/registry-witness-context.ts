import { importSigningPrivateKey, importSigningPublicKey, signRecord, verifyRecord } from '@drvillo/1bridge-authority'
import { loadSharedObserverConfig } from './config'

export async function loadRegistryWitnessContext(env: NodeJS.ProcessEnv) {
  const config = loadSharedObserverConfig(env)
  const signer: CryptoKeyPair = {
    privateKey: await importSigningPrivateKey(env.OBSERVER_SIGNING_PRIVATE_KEY ?? ''),
    publicKey: await importSigningPublicKey(env.OBSERVER_SIGNING_PUBLIC_KEY ?? ''),
  }
  const challenge = { registry: config.signedGenesisEncoded }
  const signature = await signRecord('observer.key-check', challenge, signer.privateKey)
  if (!await verifyRecord('observer.key-check', challenge, signature, signer.publicKey)) {
    throw new TypeError('Observer signing keys do not match')
  }
  return { config, signer }
}

