import { randomUUID } from 'node:crypto'
import { importSigningPrivateKey, importSigningPublicKey, signRecord,
  verifyRecord } from '@drvillo/1bridge-authority'
import { authorizedBearer } from '../../../lib/bearer'
import { loadSharedObserverConfig } from '../../../lib/config'
import { pollSharedObserverOnce } from '../../../lib/shared-poll'
import { publishAggregateCoverage } from '../../../lib/aggregate-store'
import { installObserverSchema, openObserverStore } from '../../../lib/store'

export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: Request): Promise<Response> {
  if (!authorizedBearer(request, process.env.CRON_SECRET)) {
    return new Response('Unauthorized', { status: 401 })
  }
  let config: ReturnType<typeof loadSharedObserverConfig>
  let signer: CryptoKeyPair
  try {
    config = loadSharedObserverConfig(process.env)
    signer = {
      privateKey: await importSigningPrivateKey(process.env.OBSERVER_SIGNING_PRIVATE_KEY ?? ''),
      publicKey: await importSigningPublicKey(process.env.OBSERVER_SIGNING_PUBLIC_KEY ?? '')
    }
    const challenge = { registry: config.signedGenesisEncoded }
    const signature = await signRecord('observer.key-check', challenge, signer.privateKey)
    if (!await verifyRecord('observer.key-check', challenge, signature, signer.publicKey)) {
      throw new TypeError('Observer signing keys do not match')
    }
  } catch {
    return Response.json({ status: 'configuration_error' }, { status: 503,
      headers: { 'cache-control': 'no-store' } })
  }
  const store = openObserverStore(config.databaseUrl, config.databaseSchema)
  try {
    await installObserverSchema(store)
    const result = await pollSharedObserverOnce(store, config, randomUUID(), {
      registry: { maxEntryPages: 12, maxCheckpoints: 12, maxMs: 20_000 },
      feed: { maxLeafPages: 12, maxCheckpoints: 12, maxMs: 10_000 },
      maxFeeds: 12, maxMs: 45_000
    })
    const report = await publishAggregateCoverage(store, config, signer)
    return Response.json({ version: 1, ...result, report: report.signedReport,
      reportHash: report.reportHash }, { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    console.error('Shared observer poll failed:', error instanceof Error ? error.name : 'UnknownError')
    return Response.json({ status: 'poll_error' }, { status: 500,
      headers: { 'cache-control': 'no-store' } })
  } finally { await store.close() }
}
