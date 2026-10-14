export interface ObserverConfig {
  sourceBaseUrl: string
  feedId: string
  checkpointPublicKey: string
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

  const checkpointPublicKey = env.CHECKPOINT_PUBLIC_KEY
  if (
    !checkpointPublicKey ||
    checkpointPublicKey.length < 40 ||
    checkpointPublicKey.length > 512 ||
    !/^[A-Za-z0-9_-]+$/.test(checkpointPublicKey) ||
    Buffer.from(checkpointPublicKey, 'base64url').toString('base64url') !== checkpointPublicKey
  ) {
    throw new Error('Invalid CHECKPOINT_PUBLIC_KEY')
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

  return { sourceBaseUrl, feedId, checkpointPublicKey, databaseUrl, cronSecret }
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
