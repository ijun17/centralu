import { describe, expect, it } from 'vitest'
import { approvalCardCovered, approvalKeyAction } from './ApprovalCard.jsx'

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
