import { canonicalBytes, encodeBase64Url, type Hash } from '@drvillo/1bridge-authority'
import type { ObserverConfig, SharedObserverConfig } from './config'
import { pollObserverOnce, type PollBudget, type PollResult } from './poll'
import { pollRegistryOnce, type RegistryPollBudget, type RegistryPollResult } from './registry-poll'
import { readRegistryFeeds, selectRegistryFeedBatch } from './registry-store'
import { verifyRegistryPin } from './config'
import type { ObserverStore } from './store'

export interface SharedPollBudget {
  registry: RegistryPollBudget
  feed: PollBudget
  maxFeeds: number
  maxMs: number
}

export interface SharedPollResult {
  registry: RegistryPollResult
  registryHash: Hash
  feeds: { feedId: Hash; status: PollResult['status'] | 'pending' | 'error' }[]
}

/** Uses only signed registry discovery; a failed feed never stops its peers. */
export async function pollSharedObserverOnce(store: ObserverStore, config: SharedObserverConfig,
  workerId: string, budget: SharedPollBudget): Promise<SharedPollResult> {
  if (typeof workerId !== 'string' || workerId.length < 1 || workerId.length > 180
    || !budget || !Number.isSafeInteger(budget.maxFeeds) || budget.maxFeeds < 1
    || budget.maxFeeds > 100 || !Number.isSafeInteger(budget.maxMs)
    || budget.maxMs < 1 || budget.maxMs > 60_000) {
    throw new TypeError('Invalid shared observer poll budget')
  }
  const deadline = Date.now() + budget.maxMs
  const registry = await pollRegistryOnce(store, config, workerId,
    { ...budget.registry, maxMs: Math.min(budget.registry.maxMs, budget.maxMs) })
  const pin = await verifyRegistryPin(config)
  const accepted = await readRegistryFeeds(store, pin.publisherKey)
  const selected = await selectRegistryFeedBatch(store, accepted.feeds, budget.maxFeeds)
  const feeds: SharedPollResult['feeds'] = []
  for (const feed of selected) {
    if (!feed.advertisedHead || Date.now() >= deadline) {
      feeds.push({ feedId: feed.feedId, status: 'pending' })
      continue
    }
    const feedConfig: ObserverConfig = { sourceBaseUrl: config.sourceBaseUrl,
      feedId: feed.feedId, anchorPin: feed.anchorPin,
      signedAnchor: encodeBase64Url(canonicalBytes(feed.signedAnchor)),
      databaseUrl: config.databaseUrl, databaseSchema: config.databaseSchema,
      cronSecret: config.cronSecret }
    try {
      const result = await pollObserverOnce(store, feedConfig, `${workerId}:${feed.feedId}`,
        { ...budget.feed, maxMs: Math.min(budget.feed.maxMs, Math.max(1, deadline - Date.now())) },
        feed.advertisedHead)
      feeds.push({ feedId: feed.feedId, status: result.status })
    } catch (error) {
      console.error('Shared observer feed failed:', feed.feedId,
        error instanceof Error ? error.name : 'UnknownError')
      feeds.push({ feedId: feed.feedId, status: 'error' })
    }
  }
  return { registry, registryHash: accepted.snapshot.checkpointHash, feeds }
}
