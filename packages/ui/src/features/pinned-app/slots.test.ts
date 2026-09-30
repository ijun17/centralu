import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { externalAppKey } from '../../store/store.js'
import { placeSlots, registerSlot, registerSlottedView } from './slots.js'

/**
 * `placeSlots` is handed the project screen's panel ids (`app:<appId>`, `session:<id>`), while slots and views are
 * keyed by the pinned view's key (`<project>/<appId>`). The two used to be compared as they came, so an app panel's
 * view was never dimmed while the panel was dragged.
 *
 * Node has no DOM, and slots.ts needs only a little of one: a rect for the slot and the view's containing block, a
 * style to write into, a resize observer that is never called, and the root's text zoom. Where the view lands is
 * e2e's (fixtures/project-screen.ts); this is only which view the drag dims and which frames give up the pointer.
 */
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  vi.stubGlobal('document', { documentElement: {} })
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
})

const cleanups: (() => void)[] = []
afterEach(() => {
  placeSlots('p1', null)
  for (const off of cleanups.splice(0)) off()
  vi.unstubAllGlobals()
})

/** One app's view laid over its panel's slot, as ProjectView and PinnedApps register them */
function slotted(projectId: string, appId: string): CSSStyleDeclaration {
  const key = externalAppKey(projectId, appId)
  const box = { left: 10, top: 20, width: 300, height: 200 }
  const slot = { isConnected: true, getBoundingClientRect: () => box } as unknown as HTMLElement
  const block = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 800 }), clientLeft: 0, clientTop: 0 }
  const view = { offsetParent: block, style: {} } as unknown as HTMLElement
  cleanups.push(registerSlot(key, slot), registerSlottedView(key, view))
  return view.style
}

describe('placeSlots while a panel is dragged on the project screen', () => {
  it('the view of the dragged app panel dims with it, and no other view does', () => {
    const counter = slotted('p1', 'counter')
    const notes = slotted('p1', 'notes')

    placeSlots('p1', 'app:counter')
    expect(counter.opacity).toBe('0.4')
    expect(notes.opacity).toBe('')

    placeSlots('p1', null)
    expect(counter.opacity).toBe('')
  })

  it('a dragged session panel dims no view, even one whose app has the same id, and every frame gives up the pointer', () => {
    const counter = slotted('p1', 'counter')
    const notes = slotted('p1', 'notes')

    placeSlots('p1', 'session:counter')
    expect([counter.opacity, notes.opacity]).toEqual(['', ''])
    // A frame swallows dragover, so the panel under the hand would never hear the drag (slots.ts)
    expect([counter.pointerEvents, notes.pointerEvents]).toEqual(['none', 'none'])

    placeSlots('p1', null)
    expect([counter.pointerEvents, notes.pointerEvents]).toEqual(['', ''])
  })

  it("another project's app with the same id is not the one dragged", () => {
    const mine = slotted('p1', 'counter')
    const theirs = slotted('p2', 'counter')

    placeSlots('p1', 'app:counter')
    expect(mine.opacity).toBe('0.4')
    expect(theirs.opacity).toBe('')
  })
})
