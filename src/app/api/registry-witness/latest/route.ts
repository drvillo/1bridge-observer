import { importSigningPublicKey } from '@drvillo/1bridge-authority'
import { loadSharedReportReadConfig, verifyRegistryPin } from '../../../../lib/config'
import { readLatestRegistryWitness } from '../../../../lib/registry-witness-store'
import { getRuntimeObserverStore } from '../../../../lib/store'

export const runtime = 'nodejs'

export async function GET(): Promise<Response> {
  try {
    const config = loadSharedReportReadConfig(process.env)
    const observerKey = await importSigningPublicKey(process.env.OBSERVER_SIGNING_PUBLIC_KEY ?? '')
    const pin = await verifyRegistryPin(config)
    const store = getRuntimeObserverStore(config.databaseUrl)
    const latest = await readLatestRegistryWitness(store, pin, observerKey)
    return Response.json(latest ?? { status: 'not_yet_witnessed' }, {
      status: latest ? 200 : 404,
      headers: { 'cache-control': 'no-store', 'access-control-allow-origin': '*' },
    })
  } catch (error) {
    console.error('Registry witness read failed:', error instanceof Error ? error.name : 'UnknownError')
    return Response.json({ status: 'witness_unavailable' }, { status: 503,
      headers: { 'cache-control': 'no-store' } })
  }
}
