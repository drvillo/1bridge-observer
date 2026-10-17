import { describe, expect, it, vi } from 'vitest'
import { migrateObserverSchema } from '../scripts/migrate'
import type { ObserverStore } from '../src/lib/store'

describe('observer deployment migration', () => {
  it('installs pending migrations in the configured schema and closes the store', async () => {
    const close = vi.fn(async () => undefined)
    const store: ObserverStore = { close }
    const openStore = vi.fn(() => store)
    const installSchema = vi.fn(async () => undefined)

    await migrateObserverSchema(
      { DATABASE_URL: 'postgresql://observer:secret@database.example/observer', OBSERVER_SCHEMA: 'staging_observer' },
      { openStore, installSchema },
    )

    expect(openStore).toHaveBeenCalledWith(
      'postgresql://observer:secret@database.example/observer',
      'staging_observer',
    )
    expect(installSchema).toHaveBeenCalledWith(store)
    expect(close).toHaveBeenCalledOnce()
  })

  it('closes the store when a migration fails', async () => {
    const close = vi.fn(async () => undefined)
    const store: ObserverStore = { close }
    const migrationError = new Error('migration failed')

    await expect(migrateObserverSchema(
      { DATABASE_URL: 'postgresql://observer:secret@database.example/observer' },
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
