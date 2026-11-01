import { afterEach, describe, expect, it, vi } from 'vitest'
import { readStored, writeStored } from './stored.js'

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), map }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('readStored / writeStored', () => {
  it('round-trips a JSON value', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    writeStored('k', { a: [1, 2] })
    expect(readStored('k')).toEqual({ a: [1, 2] })
  })

  it('reads nothing for a missing key or text that is not JSON', () => {
    vi.stubGlobal('localStorage', fakeStorage({ bad: '{nope' }))
    expect(readStored('missing')).toBeUndefined()
    expect(readStored('bad')).toBeUndefined()
  })

  it('reads and writes nothing, without throwing, when storage is absent or denied', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(() => writeStored('k', 1)).not.toThrow()
    expect(readStored('k')).toBeUndefined()
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    })
    expect(() => writeStored('k', 1)).not.toThrow()
    expect(readStored('k')).toBeUndefined()
  })
})
