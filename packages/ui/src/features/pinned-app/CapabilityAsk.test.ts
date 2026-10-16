import { describe, expect, it } from 'vitest'
import { capabilityAskCovered } from './CapabilityAsk.jsx'

/*
 * The capability question over an app view (M4 D-4) answers y and n from the window. A modal standing over the view
 * (a delete confirmation, the new-session dialog: `Modal` counts itself in `openLayers`) must take those keys, not
 * the question hidden under it (#850 item 11).
 */
describe('capabilityAskCovered', () => {
  const free = { openLayers: 0, inboxOpen: false, usageOpen: false, settingsOpen: false, paletteOpen: false, overlay: null, view: 'app' }

  it('takes the keys on its own app screen with nothing over it', () => {
    expect(capabilityAskCovered(free)).toBe(false)
  })

  it('leaves them to a modal over the view', () => {
    expect(capabilityAskCovered({ ...free, openLayers: 1 })).toBe(true)
  })

  it('leaves them to every other layer, and to another screen', () => {
    expect(capabilityAskCovered({ ...free, inboxOpen: true })).toBe(true)
    expect(capabilityAskCovered({ ...free, usageOpen: true })).toBe(true)
    expect(capabilityAskCovered({ ...free, settingsOpen: true })).toBe(true)
    expect(capabilityAskCovered({ ...free, paletteOpen: true })).toBe(true)
    expect(capabilityAskCovered({ ...free, overlay: { kind: 'viewer' } })).toBe(true)
    expect(capabilityAskCovered({ ...free, view: 'focus' })).toBe(true)
  })
})
