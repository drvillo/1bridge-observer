import { randomUUID, timingSafeEqual } from 'node:crypto'
import { importSigningPrivateKey, importSigningPublicKey, signRecord,
  verifyRecord } from '@drvillo/1bridge-authority'
import { loadObserverConfig } from '../../../lib/config'
import { pollObserverOnce } from '../../../lib/poll'
import { installObserverSchema, openObserverStore, publishObserverCoverage } from '../../../lib/store'

export const runtime = 'nodejs'
export const maxDuration = 60

function authorized(request: Request, secret: string | undefined): boolean {
  if (!secret || Buffer.byteLength(secret, 'utf8') < 32) return false
  const presented = request.headers.get('authorization')
  if (!presented?.startsWith('Bearer ')) return false
  const received = Buffer.from(presented.slice(7), 'utf8')
  const expected = Buffer.from(secret, 'utf8')
  return received.length === expected.length && timingSafeEqual(received, expected)
}

export async function GET(request: Request): Promise<Response> {
  if (!authorized(request, process.env.CRON_SECRET)) return new Response('Unauthorized', { status: 401 })
  let config: ReturnType<typeof loadObserverConfig>
  let signer: CryptoKeyPair
  try {
    config = loadObserverConfig(process.env)
    signer = {
      privateKey: await importSigningPrivateKey(process.env.OBSERVER_SIGNING_PRIVATE_KEY ?? ''),
      publicKey: await importSigningPublicKey(process.env.OBSERVER_SIGNING_PUBLIC_KEY ?? '')
    }
    const challenge = { feedId: config.feedId }
    const signature = await signRecord('observer.key-check', challenge, signer.privateKey)
    if (!await verifyRecord('observer.key-check', challenge, signature, signer.publicKey)) {
      throw new TypeError('Observer signing keys do not match')
    }
  }
  catch { return Response.json({ status: 'configuration_error' }, { status: 503,
    headers: { 'cache-control': 'no-store' } }) }
  const store = openObserverStore(config.databaseUrl, config.databaseSchema)
  try {
    await installObserverSchema(store)
    const result = await pollObserverOnce(store, config, randomUUID(),
      { maxLeafPages: 16, maxCheckpoints: 16, maxMs: 20_000 })
    await publishObserverCoverage(store, config.feedId, signer)
    return Response.json(result, { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    console.error('Observer poll invocation failed:', error instanceof Error ? error.name : 'UnknownError')
    return Response.json({ status: 'poll_error' }, { status: 500,
      headers: { 'cache-control': 'no-store' } })
  } finally { await store.close() }
}
