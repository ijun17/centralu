import { describe, expect, it } from 'vitest'
import { composingKey, confirmKeyAction, isPlainEnter, isPlainEscape, isTextEntry, letterOf, navButtonOf, navKeyOf } from './keys.js'

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

describe('navKeyOf / navButtonOf — back and forward between screens (#374)', () => {
  const body = { tagName: 'BODY', isContentEditable: false } as unknown as EventTarget
  const press = (key: string, code: string, over: Partial<KeyboardEvent> = {}) => ({
    key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, target: body, ...over,
  })

  it('⌘[ / ⌘] and Alt+← / Alt+→ go back and forward', () => {
    expect(navKeyOf(press('[', 'BracketLeft', { metaKey: true }))).toBe(-1)
    expect(navKeyOf(press(']', 'BracketRight', { metaKey: true }))).toBe(1)
    expect(navKeyOf(press('ArrowLeft', 'ArrowLeft', { altKey: true }))).toBe(-1)
    expect(navKeyOf(press('ArrowRight', 'ArrowRight', { altKey: true }))).toBe(1)
  })

  it('nothing else: other modifiers, a bare arrow, an IME composition', () => {
    expect(navKeyOf(press('[', 'BracketLeft', { metaKey: true, shiftKey: true }))).toBeNull()
    expect(navKeyOf(press('[', 'BracketLeft', { ctrlKey: true }))).toBeNull()
    expect(navKeyOf(press('ArrowLeft', 'ArrowLeft', { altKey: true, ctrlKey: true }))).toBeNull()
    expect(navKeyOf(press('ArrowLeft', 'ArrowLeft', { metaKey: true }))).toBeNull()
    expect(navKeyOf(press('ArrowLeft', 'ArrowLeft'))).toBeNull()
    expect(navKeyOf(press('[', 'BracketLeft', { metaKey: true, isComposing: true }))).toBeNull()
  })

  it('never while typing: Alt+← moves by a word there, ⌘[ outdents', () => {
    const textarea = { tagName: 'TEXTAREA', isContentEditable: false } as unknown as EventTarget
    const editor = { tagName: 'DIV', isContentEditable: true } as unknown as EventTarget
    expect(navKeyOf(press('ArrowLeft', 'ArrowLeft', { altKey: true, target: textarea }))).toBeNull()
    expect(navKeyOf(press('[', 'BracketLeft', { metaKey: true, target: editor }))).toBeNull()
  })

  it('mouse buttons 3 and 4 are back and forward; the others are not', () => {
    expect(navButtonOf(3)).toBe(-1)
    expect(navButtonOf(4)).toBe(1)
    expect([0, 1, 2].map(navButtonOf)).toEqual([null, null, null])
  })
})

describe('confirmKeyAction — Enter and Esc on the quit confirmation dialog (#181)', () => {
  const k = (key: string, over: Partial<{ isComposing: boolean; keyCode: number; onButton: boolean }> = {}) => ({
    key, isComposing: false, keyCode: 0, onButton: false, ...over,
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
    // WebKit's shape: the Enter that ended the composition, dispatched after compositionend
    expect(confirmKeyAction(k('Enter', { keyCode: 229 }))).toBeNull()
  })
})

/**
 * #181: the run dialog's Enter handling did not check composition state — the last syllable of a
 * Korean-language alias was dropped
 */
describe('isPlainEnter — the save key for a single-line field (#181)', () => {
  it('only a non-composing Enter saves', () => {
    expect(isPlainEnter({ key: 'Enter', isComposing: false, keyCode: 13 })).toBe(true)
    expect(isPlainEnter({ key: 'Enter', isComposing: true, keyCode: 229 })).toBe(false)
    expect(isPlainEnter({ key: 'Process', isComposing: false, keyCode: 229 })).toBe(false)
    expect(isPlainEnter({ key: 'a', isComposing: false, keyCode: 65 })).toBe(false)
  })
})

/**
 * Each of the three signals on its own has to count, because each engine sends only some of
 * them. The WebKit one is the desktop app's engine: the Enter that ends a composition can arrive
 * after `compositionend`, with `isComposing` false and `key` 'Enter', and only `keyCode` 229 gives
 * it away.
 */
describe('composingKey — the shapes an IME key arrives in', () => {
  it('Chromium: isComposing set', () => {
    expect(composingKey({ key: 'Enter', isComposing: true, keyCode: 229 })).toBe(true)
    expect(composingKey({ key: 'Enter', isComposing: true, keyCode: 13 })).toBe(true)
  })

  it('Chromium on Windows: the key is named Process', () => {
    expect(composingKey({ key: 'Process', isComposing: false, keyCode: 0 })).toBe(true)
  })

  it('WebKit (WKWebView): the Enter after compositionend, isComposing already false, keyCode 229', () => {
    expect(composingKey({ key: 'Enter', isComposing: false, keyCode: 229 })).toBe(true)
    expect(isPlainEnter({ key: 'Enter', isComposing: false, keyCode: 229 })).toBe(false)
    expect(isPlainEscape({ key: 'Escape', isComposing: false, keyCode: 229 })).toBe(false)
  })

  it('a key the person pressed outside any composition is theirs', () => {
    expect(composingKey({ key: 'Enter', isComposing: false, keyCode: 13 })).toBe(false)
    expect(composingKey({ key: 'Escape', isComposing: false, keyCode: 27 })).toBe(false)
    expect(composingKey({ key: 'ArrowDown', isComposing: false, keyCode: 40 })).toBe(false)
  })
})

describe('isPlainEscape — the Esc that closes or cancels, not the one that cancels a composition', () => {
  it('only a non-composing Escape counts', () => {
    expect(isPlainEscape({ key: 'Escape', isComposing: false, keyCode: 27 })).toBe(true)
    expect(isPlainEscape({ key: 'Escape', isComposing: true, keyCode: 229 })).toBe(false)
    expect(isPlainEscape({ key: 'Enter', isComposing: false, keyCode: 13 })).toBe(false)
  })
})
