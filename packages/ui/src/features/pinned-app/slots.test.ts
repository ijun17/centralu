import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { externalAppKey, gridAppViewKey } from '../../store/store.js'
import { placeSlots, registerSlot, registerSlottedView } from './slots.js'

/**
 * Where a view laid over a panel lands — the project screen (#203) and the grid (#288) — and that a drag leaves it
 * there, in sight: a drag over a view is answered by the panel's cover (dragShield.tsx, #296), not by hiding the view.
 *
 * Node has no DOM, and slots.ts needs only a little of one: a rect for the slot and the view's containing block, a
 * style to write into, a resize observer that is never called, and the root's text zoom. Where the view lands on a
 * real page is e2e's (fixtures/project-screen.ts, fixtures/grid-apps.ts).
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
  for (const off of cleanups.splice(0)) off()
  vi.unstubAllGlobals()
})

/** One view laid over its panel's slot, under the key the screen uses for it */
function slotted(key: string): CSSStyleDeclaration {
  const box = { left: 10, top: 20, width: 300, height: 200 }
  const slot = { isConnected: true, getBoundingClientRect: () => box } as unknown as HTMLElement
  const block = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 800 }),
    clientLeft: 0,
    clientTop: 0,
  }
  const view = { offsetParent: block, style: {} } as unknown as HTMLElement
  cleanups.push(registerSlot(key, slot), registerSlottedView(key, view))
  return view.style
}

describe('placeSlots', () => {
  it('places a view over its slot, converting from the slot’s rect to the containing block', () => {
    const view = slotted(gridAppViewKey(null, 'notes'))
    expect([view.left, view.top, view.width, view.height]).toEqual(['10px', '20px', '300px', '200px'])
  })

  it('never hides a view or takes the pointer from its frame — the project screen’s and the grid’s alike', () => {
    const pinned = slotted(externalAppKey('p1', 'slider'))
    const onGrid = slotted(gridAppViewKey('p1', 'slider'))
    placeSlots()
    for (const view of [pinned, onGrid]) {
      expect([view.visibility, view.display, view.pointerEvents]).toEqual([undefined, undefined, undefined])
    }
  })
})
