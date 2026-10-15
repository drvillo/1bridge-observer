import { importSigningPrivateKey, importSigningPublicKey, signRecord,
  verifyRecord } from '@drvillo/1bridge-authority'
import { loadSharedObserverConfig } from './config'
import { pollSharedObserverOnce } from './shared-poll'
import { publishAggregateCoverage } from './aggregate-store'
import { installObserverSchema, openObserverStore } from './store'

export const sharedPollBudget = {
  registry: { maxEntryPages: 12, maxCheckpoints: 12, maxMs: 20_000 },
  feed: { maxLeafPages: 12, maxCheckpoints: 12, maxMs: 10_000 },
  maxFeeds: 12, maxMs: 45_000,
}

export async function loadSharedPollContext(env: NodeJS.ProcessEnv) {
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

/** A cron seed refreshes time; queue calls report only accepted coverage or findings. */
export async function runSharedPollCycle(context: Awaited<ReturnType<typeof loadSharedPollContext>>,
  workerId: string, reportPolicy: 'always' | 'when_changed') {
  const store = openObserverStore(context.config.databaseUrl, context.config.databaseSchema)
  try {
    await installObserverSchema(store)
    const result = await pollSharedObserverOnce(store, context.config, workerId, sharedPollBudget)
    const changed = ['accepted', 'quarantined', 'source_nonconforming'].includes(result.registry.status)
      || result.feeds.some(feed => ['accepted', 'quarantined', 'source_nonconforming'].includes(feed.status))
    const report = reportPolicy === 'always' || changed
      ? await publishAggregateCoverage(store, context.config, context.signer) : null
    return { version: 1, ...result, report }
  } finally { await store.close() }
}
