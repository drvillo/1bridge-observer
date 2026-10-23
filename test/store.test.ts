import { afterEach, describe, expect, it } from 'vitest'
import { closeRuntimeObserverStore, getRuntimeObserverStore } from '../src/lib/store'

describe('runtime observer store', () => {
  afterEach(async () => closeRuntimeObserverStore())

  it('reuses one store for matching runtime configuration', () => {
    const first = getRuntimeObserverStore('postgresql://observer:secret@database.example/observer')
    const second = getRuntimeObserverStore('postgresql://observer:secret@database.example/observer')

    expect(second).toBe(first)
  })

  it('rejects configuration changes within one process', () => {
    getRuntimeObserverStore('postgresql://observer:secret@database.example/observer')

    expect(() => getRuntimeObserverStore(
      'postgresql://observer:secret@other-database.example/observer',
    )).toThrow('Observer runtime store configuration changed')
  })

  it('can be reinitialized after closing', async () => {
    const first = getRuntimeObserverStore('postgresql://observer:secret@database.example/observer')
    await closeRuntimeObserverStore()
    const second = getRuntimeObserverStore('postgresql://observer:secret@database.example/observer')

    expect(second).not.toBe(first)
  })

  it('can be closed repeatedly', async () => {
    getRuntimeObserverStore('postgresql://observer:secret@database.example/observer')

    await closeRuntimeObserverStore()
    await expect(closeRuntimeObserverStore()).resolves.toBeUndefined()
  })
})
