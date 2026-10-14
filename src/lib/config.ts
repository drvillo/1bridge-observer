import {
  authorityStateSnapshot,
  decodeBase64Url,
  parseCanonical,
  verifyAuthorityAnchor,
  type AuthoritySnapshot,
  type SignedAuthorityAnchor,
} from '@drvillo/1bridge-authority'

export interface ObserverConfig {
  sourceBaseUrl: string
  feedId: string
  anchorPin: string
  signedAnchor: string
  databaseUrl: string
  cronSecret: string
}

type Environment = Record<string, string | undefined>

export function loadObserverConfig(env: Environment): ObserverConfig {
  const sourceBaseUrl = parseSourceUrl(env.SOURCE_BASE_URL, env.NODE_ENV)
  const feedId = env.FEED_ID
  if (!feedId || !/^[0-9a-f]{64}$/.test(feedId)) {
    throw new Error('Invalid FEED_ID')
  }

  const anchorPin = env.ANCHOR_PIN
  if (!anchorPin || !/^[0-9a-f]{64}$/.test(anchorPin)) {
    throw new Error('Invalid ANCHOR_PIN')
  }

  const signedAnchor = env.SIGNED_ANCHOR
  try {
    if (!signedAnchor || decodeBase64Url(signedAnchor, 16384).length === 0) {
      throw new TypeError('Missing signed anchor')
    }
  } catch {
    throw new Error('Invalid SIGNED_ANCHOR')
  }

  const databaseUrl = env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error('Invalid DATABASE_URL')
  }
  let database: URL
  try {
    database = new URL(databaseUrl)
  } catch {
    throw new Error('Invalid DATABASE_URL')
  }
  if (
    !['postgres:', 'postgresql:'].includes(database.protocol) ||
    !database.hostname ||
    database.pathname === '/' ||
    !database.pathname ||
    database.hash
  ) {
    throw new Error('Invalid DATABASE_URL')
  }

  const cronSecret = env.CRON_SECRET
  if (!cronSecret || Buffer.byteLength(cronSecret, 'utf8') < 32) {
    throw new Error('Invalid CRON_SECRET')
  }

  return { sourceBaseUrl, feedId, anchorPin, signedAnchor, databaseUrl, cronSecret }
}

export async function verifyObserverAnchor(config: ObserverConfig): Promise<AuthoritySnapshot> {
  const serialized = decodeBase64Url(config.signedAnchor, 16384)
  const signed = parseCanonical(serialized) as unknown as SignedAuthorityAnchor
  const state = await verifyAuthorityAnchor(signed, config.anchorPin)
  const snapshot = authorityStateSnapshot(state)
  if (snapshot.feedId !== config.feedId) {
    throw new Error('Configured FEED_ID does not match the verified authority anchor')
  }
  return snapshot
}

function parseSourceUrl(value: string | undefined, nodeEnv: string | undefined): string {
  let url: URL
  try {
    url = new URL(value ?? '')
  } catch {
    throw new Error('Invalid SOURCE_BASE_URL')
  }

  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  const allowedProtocol = url.protocol === 'https:' ||
    (nodeEnv === 'test' && loopback && url.protocol === 'http:')
  if (
    !allowedProtocol ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    !/^https?:\/\/[^/?#\\]+\/?$/i.test(value ?? '')
  ) {
    throw new Error('Invalid SOURCE_BASE_URL')
  }
  return url.origin
}
