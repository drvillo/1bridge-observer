import { importSigningPublicKey } from '@drvillo/1bridge-authority'
import { readAggregateFeedStatusProof } from '../../../../lib/aggregate-store'
import { loadSharedReportReadConfig } from '../../../../lib/config'
import { openObserverStore } from '../../../../lib/store'

export const runtime = 'nodejs'
const HASH = /^[0-9a-f]{64}$/

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams
  const reportHash = params.get('reportHash')
  const feedId = params.get('feedId')
  if (!reportHash || !feedId || !HASH.test(reportHash) || !HASH.test(feedId)) {
    return Response.json({ status: 'bad_request' }, { status: 400,
      headers: { 'cache-control': 'no-store' } })
  }
  let config: ReturnType<typeof loadSharedReportReadConfig>
  let trustedKey: CryptoKey
  try {
    config = loadSharedReportReadConfig(process.env)
    trustedKey = await importSigningPublicKey(process.env.OBSERVER_SIGNING_PUBLIC_KEY ?? '')
  } catch {
    return Response.json({ status: 'configuration_error' }, { status: 503,
      headers: { 'cache-control': 'no-store' } })
  }
  const store = openObserverStore(config.databaseUrl, config.databaseSchema)
  try {
    const proof = await readAggregateFeedStatusProof(store, config, trustedKey, reportHash, feedId)
    if (!proof) return Response.json({ status: 'not_found' }, { status: 404,
      headers: { 'cache-control': 'no-store' } })
    return Response.json({ version: 1, reportHash, proof },
      { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    console.error('Shared status read failed:', error instanceof Error ? error.name : 'UnknownError')
    return Response.json({ status: 'report_error' }, { status: 500,
      headers: { 'cache-control': 'no-store' } })
  } finally { await store.close() }
}
