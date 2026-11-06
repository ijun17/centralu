import { beforeEach, describe, expect, it } from 'vitest'
import { useStore } from './store.js'
import { resetStore } from './store.test-helpers.js'

beforeEach(resetStore)

/*
 * The runs of thinking and tool calls the person opened (#2007) are kept per session in the store, not in the fold
 * line: the virtual list detaches a row and draws it again, and a session is left and come back to.
 */
describe('foldOpen', () => {
  it('opens a run by the keys of its rows and folds it again, per session', () => {
    const { setFoldOpen } = useStore.getState()
    setFoldOpen('s1', ['s4', 's5'], true)
    expect(useStore.getState().foldOpen).toEqual({ s1: { s4: true, s5: true } })
    setFoldOpen('s2', ['s4'], true)
    setFoldOpen('s1', ['s4', 's5'], false)
    expect(useStore.getState().foldOpen).toEqual({ s1: {}, s2: { s4: true } })
  })

  it('leaves the state alone when nothing changes, so no row draws again for it', () => {
    const { setFoldOpen } = useStore.getState()
    setFoldOpen('s1', ['s4'], true)
    const before = useStore.getState().foldOpen
    setFoldOpen('s1', ['s4'], true)
    setFoldOpen('s1', ['s9'], false)
    expect(useStore.getState().foldOpen).toBe(before)
  })
})
