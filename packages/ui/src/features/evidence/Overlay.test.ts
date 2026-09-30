import { describe, expect, it } from 'vitest'
import { overlayTakesEscape } from './Overlay.jsx'

/*
 * #181: the overlay receives Esc in the window's capture phase — before every other element. While
 * the target was not checked, Esc meant for the terminal (vim, less) in the evidence panel next to
 * it never reached it, and the hidden overlay closed first instead of a settings dialog or a modal
 * open above it.
 */
describe('overlayTakesEscape — the overlay only claims Esc when it is on top and the key came from its own side (#181)', () => {
  const none = { openLayers: 0, settingsOpen: false, paletteOpen: false, inboxOpen: false, usageOpen: false }
  const at = (inPanel: boolean) => ({ closest: (sel: string) => (inPanel && sel.includes('evidence-panel') ? {} : null) }) as unknown as EventTarget

  it('dismisses when pressed in an input field (a hidden conversation) or empty space — must not get trapped behind the cover', () => {
    expect(overlayTakesEscape(none, at(false))).toBe(true)
    expect(overlayTakesEscape(none, null)).toBe(true)
  })

  it('Esc pressed in the evidence panel next to it (the terminal) belongs to that panel', () => {
    expect(overlayTakesEscape(none, at(true))).toBe(false)
  })

  it('is claimed by another layer when one is open above it', () => {
    expect(overlayTakesEscape({ ...none, openLayers: 1 }, at(false))).toBe(false)
    expect(overlayTakesEscape({ ...none, settingsOpen: true }, at(false))).toBe(false)
    expect(overlayTakesEscape({ ...none, paletteOpen: true }, at(false))).toBe(false)
  })
})
