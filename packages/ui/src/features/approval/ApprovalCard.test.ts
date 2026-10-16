import { describe, expect, it } from 'vitest'
import { NO_PATH } from '@cc/protocol'
import { approvalCardCovered, approvalKeyAction, offersAlways } from './ApprovalCard.jsx'

/**
 * `code` having a default value matters.
 *
 * This helper used to construct only `key`, so it checked ⌥a with `{ key: 'a', altKey: true }` —
 * **an event a Mac keyboard never actually produces.** On an ABC layout, ⌥A comes through as
 * `å`, so underneath a passing test, the real shortcut was dead. When testing with a constructed
 * event, the first thing to check is whether that shape is what a real keyboard actually sends.
 */
const key = (
  k: string,
  mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; code: string }> = {},
) => ({
  key: k,
  code: `Key${k.toUpperCase()}`,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
})

const FREE = { typing: false, covered: false }

describe('approvalKeyAction — when the global y/n/a keys become an approval (U6)', () => {
  it('plain y/n/a are allow, deny, and always allow respectively', () => {
    expect(approvalKeyAction(key('y'), FREE)).toEqual({ decision: 'allow' })
    expect(approvalKeyAction(key('n'), FREE)).toEqual({ decision: 'deny' })
    expect(approvalKeyAction(key('a'), FREE)).toEqual({ decision: 'always', scope: 'session' })
  })

  /**
   * Exactly what the keyboard reports (UCKeyTranslate): on ABC/U.S., ⌥A comes as `å`; on a
   * Korean 2-beolsik layout, A comes as `ㅁ`. On Linux and Windows, Alt does not change the
   * character, so it comes as `a` — all three mean the same thing.
   */
  it('⌥a is project scope — whatever character the keyboard layout sends', () => {
    const project = { decision: 'always', scope: 'project' }
    expect(approvalKeyAction(key('å', { altKey: true, code: 'KeyA' }), FREE)).toEqual(project) // Mac ABC
    expect(approvalKeyAction(key('a', { altKey: true }), FREE)).toEqual(project) // Linux and Windows
  })

  it('y/n/a work even while typing in Korean — this app was built by someone who writes in Korean', () => {
    expect(approvalKeyAction(key('ㅛ', { code: 'KeyY' }), FREE)).toEqual({ decision: 'allow' })
    expect(approvalKeyAction(key('ㅜ', { code: 'KeyN' }), FREE)).toEqual({ decision: 'deny' })
    expect(approvalKeyAction(key('ㅁ', { code: 'KeyA' }), FREE)).toEqual({ decision: 'always', scope: 'session' })
  })

  /** Pressing f on Dvorak must not trigger an approval — the reason a letter is trusted before a position */
  it('a Latin letter does not care about position (Dvorak-safe)', () => {
    expect(approvalKeyAction(key('f', { code: 'KeyY' }), FREE)).toBeNull()
  })

  it('a ⌘, ⌃ or ⇧ combination is a different shortcut — ⌘A (select all) and ⌘⇧A (next waiting) must not leak into an approval', () => {
    expect(approvalKeyAction(key('a', { metaKey: true }), FREE)).toBeNull()
    expect(approvalKeyAction(key('a', { metaKey: true, shiftKey: true }), FREE)).toBeNull()
    expect(approvalKeyAction(key('a', { ctrlKey: true }), FREE)).toBeNull()
    expect(approvalKeyAction(key('y', { shiftKey: true }), FREE)).toBeNull()
    expect(approvalKeyAction(key('n', { metaKey: true }), FREE)).toBeNull()
  })

  it('is not accepted while typing into a text field (contenteditable included)', () => {
    expect(approvalKeyAction(key('y'), { typing: true, covered: false })).toBeNull()
  })

  it('is not accepted while the card is hidden behind a modal or overlay — this would approve a command nobody can see', () => {
    expect(approvalKeyAction(key('y'), { typing: false, covered: true })).toBeNull()
    expect(approvalKeyAction(key('a', { altKey: true }), { typing: false, covered: true })).toBeNull()
  })

  /** #158: holding y down let the next card, which appeared right after the first response, get approved before anyone read it */
  it('a key held down and repeating is not an approval', () => {
    expect(approvalKeyAction({ ...key('y'), repeat: true }, FREE)).toBeNull()
    expect(approvalKeyAction({ ...key('a', { altKey: true, code: 'KeyA' }), repeat: true }, FREE)).toBeNull()
    expect(approvalKeyAction({ ...key('y'), repeat: false }, FREE)).toEqual({ decision: 'allow' })
  })

  it('a key unrelated to approval passes straight through', () => {
    expect(approvalKeyAction(key('x'), FREE)).toBeNull()
    expect(approvalKeyAction(key('Escape'), FREE)).toBeNull()
  })
})

/*
 * With the keyboard in the composer, y/n/a are letters of the message. The card is answered there with mod+⇧Y/D/L,
 * mod being ⌘ on a Mac and Ctrl elsewhere (the event carries one or the other; the check accepts both).
 */
describe('approvalKeyAction — answering from the composer with mod+⇧Y / mod+⇧D / mod+⇧L', () => {
  const COMPOSER = { typing: true, covered: false, inComposer: true }
  const mac = { metaKey: true, shiftKey: true }
  const pc = { ctrlKey: true, shiftKey: true }

  it('allows, denies and always allows (session scope) from the composer, on either keyboard', () => {
    for (const mods of [mac, pc]) {
      // With ⇧ held the key arrives upper-case
      expect(approvalKeyAction(key('Y', mods), COMPOSER)).toEqual({ decision: 'allow' })
      expect(approvalKeyAction(key('D', mods), COMPOSER)).toEqual({ decision: 'deny' })
      expect(approvalKeyAction(key('L', mods), COMPOSER)).toEqual({ decision: 'always', scope: 'session' })
    }
  })

  it('bare y/n/a stay letters in the composer', () => {
    expect(approvalKeyAction(key('y'), COMPOSER)).toBeNull()
    expect(approvalKeyAction(key('n'), COMPOSER)).toBeNull()
    expect(approvalKeyAction(key('a'), COMPOSER)).toBeNull()
  })

  it('reads the combo by position on a Korean layout, where ⇧Y types ㅛ', () => {
    expect(approvalKeyAction(key('ㅛ', { ...mac, code: 'KeyY' }), COMPOSER)).toEqual({ decision: 'allow' })
    expect(approvalKeyAction(key('ㅇ', { ...pc, code: 'KeyD' }), COMPOSER)).toEqual({ decision: 'deny' })
  })

  it('does nothing while an input method is composing, whatever modifiers the key carries', () => {
    expect(approvalKeyAction({ ...key('Y', mac), isComposing: true }, COMPOSER)).toBeNull()
    // WebKit's key that ended a composition
    expect(approvalKeyAction({ ...key('Y', mac), keyCode: 229 }, COMPOSER)).toBeNull()
    expect(approvalKeyAction(key('Process', { ...pc, code: 'KeyY' }), COMPOSER)).toBeNull()
  })

  it('takes exactly mod+⇧: the composer send key, text editing, redo and the other app keys are left alone', () => {
    // mod+Enter sends when "send with ⌘Enter" is on; mod+Backspace deletes a word or back to the line's start
    expect(approvalKeyAction(key('Enter', { metaKey: true, code: 'Enter' }), COMPOSER)).toBeNull()
    expect(approvalKeyAction(key('Backspace', { ctrlKey: true, code: 'Backspace' }), COMPOSER)).toBeNull()
    // Ctrl+Y redo, mod+D, mod+L without ⇧
    expect(approvalKeyAction(key('y', { ctrlKey: true }), COMPOSER)).toBeNull()
    expect(approvalKeyAction(key('d', { metaKey: true }), COMPOSER)).toBeNull()
    expect(approvalKeyAction(key('l', { ctrlKey: true }), COMPOSER)).toBeNull()
    // mod+⇧A is next waiting, mod+⇧Z redo, mod+⇧N new session
    expect(approvalKeyAction(key('A', mac), COMPOSER)).toBeNull()
    expect(approvalKeyAction(key('Z', pc), COMPOSER)).toBeNull()
    expect(approvalKeyAction(key('N', mac), COMPOSER)).toBeNull()
    // With Alt too: Ctrl+Alt is AltGr on many Windows layouts, which types letters
    expect(approvalKeyAction(key('Y', { ...pc, altKey: true }), COMPOSER)).toBeNull()
  })

  it('works outside text fields too, but not in another text field (a rename field, a terminal)', () => {
    expect(approvalKeyAction(key('Y', mac), FREE)).toEqual({ decision: 'allow' })
    expect(approvalKeyAction(key('Y', mac), { typing: true, covered: false, inComposer: false })).toBeNull()
  })

  it('keeps the rules of the bare keys: not when covered, not on a repeat', () => {
    expect(approvalKeyAction(key('Y', mac), { ...COMPOSER, covered: true })).toBeNull()
    expect(approvalKeyAction({ ...key('Y', mac), repeat: true }, COMPOSER)).toBeNull()
  })
})

/*
 * In the grid, each pane's card attaches its own window listener — without a focus check, with
 * two approvals up at once, a single y approves both of them at once.
 * Keyboard approval always goes to exactly one thing: "the session that is focused."
 */
describe('approvalCardCovered — which card accepts a key press', () => {
  const open = {
    inboxOpen: false, usageOpen: false, settingsOpen: false, paletteOpen: false,
    overlay: null as unknown, focusedSessionId: 's1', openLayers: 0,
  }

  it('only the focused session\'s card accepts a key press', () => {
    expect(approvalCardCovered(open, 's1')).toBe(false)
    expect(approvalCardCovered(open, 's2')).toBe(true) // another pane in the grid
  })

  it('with no focus (nothing selected in the grid), no card accepts one', () => {
    expect(approvalCardCovered({ ...open, focusedSessionId: null }, 's1')).toBe(true)
  })

  it('a modal or overlay covering the screen blocks even the focused card', () => {
    expect(approvalCardCovered({ ...open, inboxOpen: true }, 's1')).toBe(true)
    expect(approvalCardCovered({ ...open, usageOpen: true }, 's1')).toBe(true)
    expect(approvalCardCovered({ ...open, settingsOpen: true }, 's1')).toBe(true)
    expect(approvalCardCovered({ ...open, paletteOpen: true }, 's1')).toBe(true)
    expect(approvalCardCovered({ ...open, overlay: { kind: 'viewer' } }, 's1')).toBe(true)
  })

  /*
   * #158: "Delete this session?", a new session, image zoom, and the command palette all open
   * via local state and do not show up in the store's five values. Pressing y to confirm in one
   * of those windows approved a command hidden behind it. These windows are counted through
   * `openLayers` by `Modal` (the command palette counts itself directly).
   */
  it('even a single window opened via local state blocks the focused card', () => {
    expect(approvalCardCovered({ ...open, openLayers: 1 }, 's1')).toBe(true)
    expect(approvalCardCovered({ ...open, openLayers: 2 }, 's1')).toBe(true)
  })
})

// An edit whose file is unknown has nothing to remember (#428): no "always allow" button, and `a` does nothing
describe('offersAlways', () => {
  it('is off only for a file edit with no path', () => {
    expect(offersAlways({ kind: 'file_edit', path: NO_PATH, diffPreview: '', multi: false })).toBe(false)
    expect(offersAlways({ kind: 'file_edit', path: '/x/a.ts', diffPreview: '', multi: false })).toBe(true)
    expect(offersAlways({ kind: 'command', command: 'npm test', cwd: '/x' })).toBe(true)
    expect(offersAlways({ kind: 'other', raw: '{}' })).toBe(true)
  })
})
