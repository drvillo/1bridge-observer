import { canonicalBytes } from '@drvillo/1bridge-authority'
import { createHash } from 'node:crypto'
import { authorizedBearer } from '../../../../lib/bearer'
import { loadRegistryWitnessContext } from '../../../../lib/registry-witness-context'
import { pollRegistryWitnessOnce } from '../../../../lib/registry-witness-poll'
import { getRuntimeObserverStore } from '../../../../lib/store'

export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: Request): Promise<Response> {
  if (!authorizedBearer(request, process.env.CRON_SECRET)) {
    return new Response('Unauthorized', { status: 401 })
  }
  try {
    const context = await loadRegistryWitnessContext(process.env)
    const store = getRuntimeObserverStore(context.config.databaseUrl)
    const result = await pollRegistryWitnessOnce(store, context.config, context.signer)
    const reportHash = result.report
      ? createHash('sha256').update(canonicalBytes(result.report)).digest('hex') : null
    return Response.json({ version: 2, ...result, reportHash }, {
      headers: { 'cache-control': 'no-store' },
    })
  } catch (error) {
    console.error('Registry witness poll failed:', error instanceof Error ? error.name : 'UnknownError')
    return Response.json({ status: 'poll_error' }, { status: 500,
      headers: { 'cache-control': 'no-store' } })
  }
}
