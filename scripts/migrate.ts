import { pathToFileURL } from 'node:url'
import { installObserverSchema, OBSERVER_SCHEMA, openObserverStore, type ObserverStore } from '../src/lib/store.ts'

interface MigrationEnvironment {
  [key: string]: string | undefined
  DATABASE_URL?: string
  OBSERVER_SCHEMA?: string
}

interface MigrationDependencies {
  openStore(connectionString: string): ObserverStore
  installSchema(store: ObserverStore): Promise<void>
}

const defaultDependencies: MigrationDependencies = {
  openStore: openObserverStore,
  installSchema: installObserverSchema,
}

export async function migrateObserverSchema(
  env: MigrationEnvironment,
  dependencies: MigrationDependencies = defaultDependencies,
): Promise<void> {
  const databaseUrl = env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required to migrate the observer schema')
  if (env.OBSERVER_SCHEMA !== undefined && env.OBSERVER_SCHEMA !== OBSERVER_SCHEMA) {
    throw new Error('Invalid OBSERVER_SCHEMA')
  }

  const store = dependencies.openStore(databaseUrl)
  try {
    await dependencies.installSchema(store)
  } finally {
    await store.close()
  }
}

const entrypoint = process.argv[1]
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  await migrateObserverSchema(process.env)
  console.log(`Observer schema is up to date: ${OBSERVER_SCHEMA}`)
}
