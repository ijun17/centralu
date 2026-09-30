import { describe, expect, it } from 'vitest'
import type { ShortcutKeys } from '@cc/platform/ports'
import { shortcut } from './shortcut.js'

/** Mac keyboard — joined directly since these are symbols */
const MAC: ShortcutKeys = { mod: '⌘', alt: '⌥', join: '' }
/** Everything else — joined with a separator since these are names */
const PC: ShortcutKeys = { mod: 'Ctrl', alt: 'Alt', join: '+' }

describe('shortcut notation (#32)', () => {
  it('on a Mac this is exactly what was already on screen', () => {
    // If these strings change, e2e and the settings table break together — the sweep moved
    // where this is decided, not the notation itself
    expect(shortcut(MAC, 'mod', 'I')).toBe('⌘I')
    expect(shortcut(MAC, 'mod', '⇧A')).toBe('⌘⇧A')
    expect(shortcut(MAC, 'mod', '⇧1~4')).toBe('⌘⇧1~4')
    expect(shortcut(MAC, 'alt', 'a')).toBe('⌥a')
  })

  it('on a keyboard with no command key, it says Ctrl', () => {
    expect(shortcut(PC, 'mod', 'I')).toBe('Ctrl+I')
    expect(shortcut(PC, 'mod', 'K')).toBe('Ctrl+K')
    expect(shortcut(PC, 'alt', 'a')).toBe('Alt+a')
  })

  /*
   * Why the separator comes attached to the keyboard.
   *
   * A Mac joins directly, like `⌘⇧A`, and that reads fine because the pieces are symbols.
   * Applying the same rule to names produces `CtrlShiftA` — that reads as one word, not a
   * combination.
   */
  it('names do not run together', () => {
    expect(shortcut(PC, 'mod', '⇧A')).toBe('Ctrl+⇧A')
    expect(shortcut(PC, 'mod', '⇧A')).not.toContain('Ctrl⇧')
  })

  it('a piece that is not a token passes through unchanged regardless of keyboard', () => {
    // Only 'mod' and 'alt' are translated. Everything else is the key name itself
    expect(shortcut(MAC, 'esc')).toBe('esc')
    expect(shortcut(PC, 'mod', '1~9')).toBe('Ctrl+1~9')
  })

  it('a single piece needs nothing to join', () => {
    // Some places, like ApprovalCard's "Hold ⌥ and click…", call for just one modifier key
    expect(shortcut(MAC, 'alt')).toBe('⌥')
    expect(shortcut(PC, 'alt')).toBe('Alt')
  })
})
