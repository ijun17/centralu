import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { externalAppKey, gridAppViewKey } from '../../store/store.js'
import { placeSlots, registerSlot, registerSlottedView } from './slots.js'

/**
 * Which views step aside while something is dragged over a screen that lays app views over its panels — the project
 * screen (#203) and the grid (#288). In WebKit a drag goes into a frame whatever its pointer-events say, so a view
 * left showing swallows the dragover and the drop of anything carried across it (slots.ts has the measurements).
 *
 * Node has no DOM, and slots.ts needs only a little of one: a rect for the slot and the view's containing block, a
 * style to write into, a resize observer that is never called, and the root's text zoom. Where the view lands is
 * e2e's (fixtures/project-screen.ts, fixtures/grid-apps.ts); this is only what a drag does to the views.
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
  placeSlots(false)
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

describe('placeSlots while something is dragged over the views', () => {
  it('a dragged panel — an app’s or a session’s — hides every view and takes the pointer from every frame', () => {
    const counter = slotted(externalAppKey('p1', 'counter'))
    const notes = slotted(externalAppKey('p1', 'notes'))

    placeSlots(true)
    expect([counter.visibility, notes.visibility]).toEqual(['hidden', 'hidden'])
    expect([counter.pointerEvents, notes.pointerEvents]).toEqual(['none', 'none'])

    placeSlots(false)
    expect([counter.visibility, counter.pointerEvents, notes.visibility, notes.pointerEvents]).toEqual([
      '',
      '',
      '',
      '',
    ])
  })

  it('a sidebar row dragged in hides them the same way, and the grid’s own views of an app follow the same rule', () => {
    const pinned = slotted(externalAppKey('p1', 'slider'))
    const onGrid = slotted(gridAppViewKey('p1', 'slider'))

    placeSlots(false, true)
    expect([pinned.visibility, onGrid.visibility]).toEqual(['hidden', 'hidden'])

    placeSlots(false)
    expect([pinned.visibility, onGrid.visibility]).toEqual(['', ''])
  })

  it('places a view over its slot, converting from the slot’s rect to the containing block', () => {
    const view = slotted(gridAppViewKey(null, 'notes'))
    expect([view.left, view.top, view.width, view.height]).toEqual(['10px', '20px', '300px', '200px'])
  })
})
