import { randomUUID } from 'node:crypto'
import { authorizedBearer } from '../../../lib/bearer'
import { nextSharedContinuation } from '../../../lib/shared-continuation'
import { loadSharedPollContext, runSharedPollCycle,
  sharedPollBudget } from '../../../lib/shared-poll-run'
import { sendSharedContinuation } from '../../../lib/shared-queue'

export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: Request): Promise<Response> {
  if (!authorizedBearer(request, process.env.CRON_SECRET)) {
    return new Response('Unauthorized', { status: 401 })
  }
  let context: Awaited<ReturnType<typeof loadSharedPollContext>>
  try { context = await loadSharedPollContext(process.env) }
  catch {
    return Response.json({ status: 'configuration_error' }, { status: 503,
      headers: { 'cache-control': 'no-store' } })
  }
  try {
    const result = await runSharedPollCycle(context, randomUUID(), 'always')
    const next = nextSharedContinuation(null, { feedCount: result.feedCount,
      selectedCount: result.selectedCount, madeProgress: result.madeProgress,
      maxFeeds: sharedPollBudget.maxFeeds })
    let continuationStatus: 'not_needed' | 'local_only' | 'queued' | 'send_failed'
    try { continuationStatus = await sendSharedContinuation(next) }
    catch (error) {
      console.error('Shared observer continuation send failed:',
        error instanceof Error ? error.name : 'UnknownError')
      continuationStatus = 'send_failed'
    }
    return Response.json({ ...result, report: result.report!.signedReport,
      reportHash: result.report!.reportHash, continuationStatus },
      { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    console.error('Shared observer poll failed:', error instanceof Error ? error.name : 'UnknownError')
    return Response.json({ status: 'poll_error' }, { status: 500,
      headers: { 'cache-control': 'no-store' } })
  }
}
