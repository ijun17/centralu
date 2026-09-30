import { describe, expect, it } from 'vitest'
import { confirmKeyAction, isTextEntry, letterOf } from './keys.js'

/** Only the two fields this function looks at, from a real KeyboardEvent */
const ev = (key: string, code: string) => ({ key, code }) as Pick<KeyboardEvent, 'key' | 'code'>

/**
 * The fix for reading letter shortcuts only from the character the keyboard produced (the
 * settings screen's `⌥a` did nothing on a Mac).
 *
 * The values below are not invented — they were asked directly of the installed keyboard layout
 * (Carbon UCKeyTranslate, 2026-08-24):
 *
 *   ABC / U.S.     A = a    ⌥A = å
 *   2-Set Korean   A = ㅁ   ⌥A = a
 */
describe('letterOf', () => {
  it('trusts a Latin letter as-is when it arrives', () => {
    expect(letterOf(ev('a', 'KeyA'))).toBe('a')
    expect(letterOf(ev('Y', 'KeyY'))).toBe('y')
  })

  it('⌥A arrives as å — the key the settings advertised was dead here', () => {
    expect(letterOf(ev('å', 'KeyA'))).toBe('a')
  })

  it('on a Korean keyboard layout, other characters arrive even with no modifier key', () => {
    expect(letterOf(ev('ㅁ', 'KeyA'))).toBe('a')
    expect(letterOf(ev('ㅓ', 'KeyJ'))).toBe('j')
    expect(letterOf(ev('ㅇ', 'KeyD'))).toBe('d')
  })

  /** The browser gives this name while an IME is swallowing the key — the position stays intact */
  it('reads Process by position too', () => {
    expect(letterOf(ev('Process', 'KeyN'))).toBe('n')
  })

  /**
   * Why this does not standardize on position. On Dvorak, y sits at QWERTY's KeyF position.
   * Reading position alone would read y when the person pressed f, and y is approval in this app
   * — the thing that must never be misread cannot be misread because of a keyboard layout. A
   * character that arrives as Latin is the character the person actually produced.
   */
  it('Dvorak: when the character is Latin, position is not consulted — f is f', () => {
    expect(letterOf(ev('f', 'KeyY'))).toBe('f')
    expect(letterOf(ev('y', 'KeyF'))).toBe('y')
  })

  it('does not treat a non-letter as if it were a letter', () => {
    expect(letterOf(ev('Enter', 'Enter'))).toBeNull()
    expect(letterOf(ev('ArrowDown', 'ArrowDown'))).toBeNull()
    expect(letterOf(ev('1', 'Digit1'))).toBeNull()
    expect(letterOf(ev('!', 'Digit1'))).toBeNull()
    expect(letterOf(ev('Escape', 'Escape'))).toBeNull()
  })
})

/** #181: a key goes only to what the person is looking at */
describe('isTextEntry — arrow keys and Enter inside a text field belong to that field (#181)', () => {
  const el = (tagName: string, extra: Record<string, unknown> = {}) => ({ tagName, isContentEditable: false, ...extra }) as unknown as EventTarget

  it('a text input, textarea, select and contenteditable all accept text', () => {
    expect(isTextEntry(el('INPUT', { type: 'text' }))).toBe(true)
    expect(isTextEntry(el('INPUT', { type: 'search' }))).toBe(true)
    expect(isTextEntry(el('TEXTAREA'))).toBe(true)
    expect(isTextEntry(el('SELECT'))).toBe(true)
    expect(isTextEntry(el('DIV', { isContentEditable: true }))).toBe(true)
  })

  it('a button, checkbox, or empty space does not accept text — list selection keeps working as-is', () => {
    expect(isTextEntry(el('BUTTON'))).toBe(false)
    expect(isTextEntry(el('INPUT', { type: 'checkbox' }))).toBe(false)
    expect(isTextEntry(el('FORM'))).toBe(false)
    expect(isTextEntry(null)).toBe(false)
  })
})

describe('confirmKeyAction — Enter and Esc on the quit confirmation dialog (#181)', () => {
  const k = (key: string, over: Partial<{ isComposing: boolean; onButton: boolean }> = {}) => ({
    key, isComposing: false, onButton: false, ...over,
  })

  it('Enter on the dialog confirms, Esc cancels', () => {
    expect(confirmKeyAction(k('Enter'))).toBe('confirm')
    expect(confirmKeyAction(k('Escape'))).toBe('cancel')
    expect(confirmKeyAction(k('a'))).toBeNull()
  })

  it('Enter on a button belongs to that button — Enter pressed on Cancel must not quit the app', () => {
    expect(confirmKeyAction(k('Enter', { onButton: true }))).toBeNull()
  })

  it('a key that is part of an IME composition means nothing — Enter to finish it, Esc to cancel it', () => {
    expect(confirmKeyAction(k('Enter', { isComposing: true }))).toBeNull()
    expect(confirmKeyAction(k('Escape', { isComposing: true }))).toBeNull()
    expect(confirmKeyAction(k('Process'))).toBeNull()
  })
})
