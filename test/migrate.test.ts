import { describe, expect, it, vi } from 'vitest'
import { migrateObserverSchema } from '../scripts/migrate'
import type { ObserverStore } from '../src/lib/store'

const databaseUrl = 'postgresql://observer:secret@database.example/observer'

describe('observer deployment migration', () => {
  it('installs schema observer and closes the store', async () => {
    const close = vi.fn(async () => undefined)
    const store: ObserverStore = { close }
    const openStore = vi.fn(() => store)
    const installSchema = vi.fn(async () => undefined)

    await migrateObserverSchema(
      { DATABASE_URL: databaseUrl, OBSERVER_SCHEMA: 'observer' },
      { openStore, installSchema },
    )

    expect(openStore).toHaveBeenCalledWith(databaseUrl)
    expect(installSchema).toHaveBeenCalledWith(store)
    expect(close).toHaveBeenCalledOnce()
  })

  it('rejects a schema other than observer before opening a store', async () => {
    const openStore = vi.fn()

    await expect(migrateObserverSchema(
      { DATABASE_URL: databaseUrl, OBSERVER_SCHEMA: 'public' },
      { openStore, installSchema: vi.fn() },
    )).rejects.toThrow('Invalid OBSERVER_SCHEMA')
    expect(openStore).not.toHaveBeenCalled()
  })

  it('closes the store when a migration fails', async () => {
    const close = vi.fn(async () => undefined)
    const store: ObserverStore = { close }
    const migrationError = new Error('migration failed')

    await expect(migrateObserverSchema(
      { DATABASE_URL: databaseUrl },
      { openStore: () => store, installSchema: async () => { throw migrationError } },
    )).rejects.toBe(migrationError)
    expect(close).toHaveBeenCalledOnce()
  })

  it('rejects a deployment without DATABASE_URL before opening a store', async () => {
    const openStore = vi.fn()

    await expect(migrateObserverSchema(
      {},
      { openStore, installSchema: vi.fn() },
    )).rejects.toThrow('DATABASE_URL is required')
    expect(openStore).not.toHaveBeenCalled()
  })
})
