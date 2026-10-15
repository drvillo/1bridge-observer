import { importSigningPublicKey } from '@drvillo/1bridge-authority'
import { readLatestAggregateCoverage } from '../../../../lib/aggregate-store'
import { loadSharedReportReadConfig } from '../../../../lib/config'
import { openObserverStore } from '../../../../lib/store'
import { PUBLIC_REPORT_HEADERS } from '../../../../lib/public-report-headers'

export const runtime = 'nodejs'

export async function GET(): Promise<Response> {
  let config: ReturnType<typeof loadSharedReportReadConfig>
  let trustedKey: CryptoKey
  try {
    config = loadSharedReportReadConfig(process.env)
    trustedKey = await importSigningPublicKey(process.env.OBSERVER_SIGNING_PUBLIC_KEY ?? '')
  } catch {
    return Response.json({ status: 'configuration_error' }, { status: 503,
      headers: PUBLIC_REPORT_HEADERS })
  }
  const store = openObserverStore(config.databaseUrl, config.databaseSchema)
  try {
    const report = await readLatestAggregateCoverage(store, config, trustedKey)
    if (!report) return Response.json({ status: 'not_found' }, { status: 404,
      headers: PUBLIC_REPORT_HEADERS })
    return Response.json({ version: 1, ...report }, { headers: PUBLIC_REPORT_HEADERS })
  } catch (error) {
    console.error('Shared report read failed:', error instanceof Error ? error.name : 'UnknownError')
    return Response.json({ status: 'report_error' }, { status: 500,
      headers: PUBLIC_REPORT_HEADERS })
  } finally { await store.close() }
}
