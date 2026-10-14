import { importSigningPublicKey } from '@drvillo/1bridge-authority'
import { authorizedBearer } from '../../../../lib/bearer'
import { loadReportReadConfig } from '../../../../lib/config'
import { openObserverStore, readLatestObserverCoverage } from '../../../../lib/store'

export const runtime = 'nodejs'

/** Returns only a report already signed by the configured, customer-pinned observer key. */
export async function GET(request: Request): Promise<Response> {
  if (!authorizedBearer(request, process.env.REPORT_READ_TOKEN)) {
    return new Response('Unauthorized', { status: 401 })
  }
  let config: ReturnType<typeof loadReportReadConfig>
  let trustedKey: CryptoKey
  try {
    if (process.env.REPORT_READ_TOKEN === process.env.CRON_SECRET) {
      throw new TypeError('Report reader and cron credentials must be distinct')
    }
    config = loadReportReadConfig(process.env)
    trustedKey = await importSigningPublicKey(process.env.OBSERVER_SIGNING_PUBLIC_KEY ?? '')
  } catch {
    return Response.json({ status: 'configuration_error' }, { status: 503,
      headers: { 'cache-control': 'no-store' } })
  }
  const store = openObserverStore(config.databaseUrl, config.databaseSchema)
  try {
    const signedReport = await readLatestObserverCoverage(store, config.feedId,
      config.anchorPin, trustedKey)
    if (!signedReport) return Response.json({ status: 'not_found' }, { status: 404,
      headers: { 'cache-control': 'no-store' } })
    return Response.json({ version: 1, signedReport }, { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    console.error('Observer report read failed:', error instanceof Error ? error.name : 'UnknownError')
    return Response.json({ status: 'report_error' }, { status: 500,
      headers: { 'cache-control': 'no-store' } })
  } finally { await store.close() }
}
