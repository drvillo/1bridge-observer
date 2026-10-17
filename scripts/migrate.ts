import { pathToFileURL } from 'node:url'
import { installObserverSchema, openObserverStore, type ObserverStore } from '../src/lib/store.ts'

interface MigrationEnvironment {
  [key: string]: string | undefined
  DATABASE_URL?: string
  OBSERVER_SCHEMA?: string
}

interface MigrationDependencies {
  openStore(connectionString: string, schema?: string): ObserverStore
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

  const store = dependencies.openStore(databaseUrl, env.OBSERVER_SCHEMA)
  try {
    await dependencies.installSchema(store)
  } finally {
    await store.close()
  }
}

const entrypoint = process.argv[1]
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  await migrateObserverSchema(process.env)
  console.log(`Observer schema is up to date: ${process.env.OBSERVER_SCHEMA ?? 'public'}`)
}
