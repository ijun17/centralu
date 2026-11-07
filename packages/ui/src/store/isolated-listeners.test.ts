import { afterEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import { isolatedListeners } from './isolated-listeners.js'

afterEach(() => vi.restoreAllMocks())

describe('a store listener that throws (#2070)', () => {
  it('does not stop the listeners after it, or the code that set the state', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = create<{ n: number }>()(isolatedListeners(() => ({ n: 0 })))
    const seen: number[] = []
    store.subscribe(() => {
      throw new Error('a view failed')
    })
    store.subscribe((s) => seen.push(s.n))
    let after = false
    store.setState({ n: 1 })
    after = true
    expect(seen).toEqual([1])
    expect(after).toBe(true)
    expect(store.getState().n).toBe(1)
    expect(logged).toHaveBeenCalledWith('A store listener threw', expect.any(Error))
  })

  it('still lets a listener unsubscribe', () => {
    const store = create<{ n: number }>()(isolatedListeners(() => ({ n: 0 })))
    const seen: number[] = []
    const stop = store.subscribe((s) => seen.push(s.n))
    store.setState({ n: 1 })
    stop()
    store.setState({ n: 2 })
    expect(seen).toEqual([1])
  })
})
