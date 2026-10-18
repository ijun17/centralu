import { describe, expect, it } from 'vitest'
import { coveringLayerOpened, dialogOpen, isCovered } from './layers.js'

describe('isCovered (#850 item 11)', () => {
  const none = { openLayers: 0, paletteOpen: false, settingsOpen: false, usageOpen: false, inboxOpen: false, overlay: null }
  const each = [
    { openLayers: 1 },
    { openLayers: 2 },
    { paletteOpen: true },
    { settingsOpen: true },
    { usageOpen: true },
    { inboxOpen: true },
    { overlay: { kind: 'viewer' } },
  ]

  it('is false with nothing open, true with any one layer open', () => {
    expect(isCovered(none)).toBe(false)
    for (const layer of each) expect(isCovered({ ...none, ...layer }), JSON.stringify(layer)).toBe(true)
  })

  it('does not count the layer that asks', () => {
    expect(isCovered({ ...none, inboxOpen: true }, 'inbox')).toBe(false)
    expect(isCovered({ ...none, overlay: { kind: 'viewer' } }, 'overlay')).toBe(false)
    // Every other layer still covers it
    for (const layer of each.filter((l) => !('inboxOpen' in l))) expect(isCovered({ ...none, inboxOpen: true, ...layer }, 'inbox')).toBe(true)
    for (const layer of each.filter((l) => !('overlay' in l))) expect(isCovered({ ...none, overlay: {}, ...layer }, 'overlay')).toBe(true)
  })
})

describe('dialogOpen (#842 item 1)', () => {
  const none = { openLayers: 0, settingsOpen: false, usageOpen: false }

  it('is true for a modal, settings or usage, and false with none of them', () => {
    expect(dialogOpen(none)).toBe(false)
    expect(dialogOpen({ ...none, openLayers: 1 })).toBe(true)
    expect(dialogOpen({ ...none, settingsOpen: true })).toBe(true)
    expect(dialogOpen({ ...none, usageOpen: true })).toBe(true)
  })
})

describe('coveringLayerOpened (a popover under a window that opens goes)', () => {
  const none = { paletteOpen: false, settingsOpen: false, usageOpen: false, inboxOpen: false }

  it('is true when the palette, the inbox, settings or usage opens', () => {
    for (const layer of ['paletteOpen', 'inboxOpen', 'settingsOpen', 'usageOpen'] as const) {
      expect(coveringLayerOpened(none, { ...none, [layer]: true }), layer).toBe(true)
    }
  })

  it('is false while one stays open or closes, and when another layer was open already', () => {
    expect(coveringLayerOpened({ ...none, paletteOpen: true }, { ...none, paletteOpen: true })).toBe(false)
    expect(coveringLayerOpened({ ...none, paletteOpen: true }, none)).toBe(false)
    expect(coveringLayerOpened(none, none)).toBe(false)
  })
})
