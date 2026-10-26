import {
  decodeBase64Url,
  importSigningPublicKey,
  parseCanonical,
  registryCheckpointHash,
  verifyRegistryCheckpoint,
  type SignedRegistryCheckpoint,
} from '@drvillo/1bridge-authority'

export interface SharedReportReadConfig {
  databaseUrl: string
  publisherPublicKeySpki: string
  signedGenesisEncoded: string
}

export interface SharedObserverConfig extends SharedReportReadConfig {
  sourceBaseUrl: string
  registrySourceApiKey: string
  cronSecret: string
}

type Environment = Record<string, string | undefined>

function loadDatabaseConfig(env: Environment): Pick<SharedReportReadConfig, 'databaseUrl'> {
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

  return { databaseUrl }
}

/** Shared deployments pin one publisher and signed empty checkpoint, not customer feeds. */
export function loadSharedObserverConfig(env: Environment): SharedObserverConfig {
  const sourceBaseUrl = parseSourceUrl(env.SOURCE_BASE_URL, env.NODE_ENV)
  const report = loadSharedReportReadConfig(env)
  const cronSecret = env.CRON_SECRET
  if (!cronSecret || Buffer.byteLength(cronSecret, 'utf8') < 32) throw new Error('Invalid CRON_SECRET')
  const registrySourceApiKey = env.REGISTRY_SOURCE_API_KEY
  if (!registrySourceApiKey || Buffer.byteLength(registrySourceApiKey, 'utf8') < 32) {
    throw new Error('Invalid REGISTRY_SOURCE_API_KEY')
  }
  return { sourceBaseUrl, ...report, cronSecret, registrySourceApiKey }
}

export function loadSharedReportReadConfig(env: Environment): SharedReportReadConfig {
  const database = loadDatabaseConfig(env)
  const publisherPublicKeySpki = env.REGISTRY_PUBLISHER_PUBLIC_KEY
  const signedGenesisEncoded = env.REGISTRY_SIGNED_GENESIS
  if (!publisherPublicKeySpki || !signedGenesisEncoded) throw new Error('Missing registry trust pin')
  try { decodeBase64Url(signedGenesisEncoded, 16_384) }
  catch { throw new Error('Invalid REGISTRY_SIGNED_GENESIS') }
  return { ...database, publisherPublicKeySpki,
    signedGenesisEncoded }
}

export async function verifyRegistryPin(config: SharedReportReadConfig): Promise<{
  publisherKey: CryptoKey; signedGenesis: SignedRegistryCheckpoint; genesisHash: string
}> {
  const publisherKey = await importSigningPublicKey(config.publisherPublicKeySpki)
  const signedGenesis = parseCanonical(decodeBase64Url(config.signedGenesisEncoded, 16_384)) as unknown as SignedRegistryCheckpoint
  if (signedGenesis.statement.size !== 0 || signedGenesis.statement.previous !== null
    || !await verifyRegistryCheckpoint(signedGenesis, publisherKey)) {
    throw new TypeError('Invalid independently pinned registry genesis')
  }
  return { publisherKey, signedGenesis,
    genesisHash: await registryCheckpointHash(signedGenesis.statement) }
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
    ((nodeEnv === 'test' || nodeEnv === 'development') && loopback && url.protocol === 'http:')
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
