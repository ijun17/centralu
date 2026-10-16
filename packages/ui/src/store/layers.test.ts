import { describe, expect, it } from 'vitest'
import { isCovered } from './layers.js'

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
