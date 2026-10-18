import { describe, expect, it } from 'vitest'
import { buttonTarget, inboxCovered, inboxKeyAction, typingTarget } from './inboxKeys.js'

/** A key as a real keyboard sends it: `code` names the key cap, `key` what it types (a Korean layout types ㅛ on Y) */
const key = (
  k: string,
  mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; code: string; repeat: boolean; isComposing: boolean; keyCode: number }> = {},
) => ({ key: k, code: /^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods })

const FREE = { typing: false, covered: false }

describe('inboxKeyAction (#683 review: the list hears the window, so it keeps the approval card’s guards)', () => {
  it('maps the list keys', () => {
    expect(inboxKeyAction(key('j'), FREE)).toBe('down')
    expect(inboxKeyAction(key('ArrowUp'), FREE)).toBe('up')
    expect(inboxKeyAction(key('Enter'), FREE)).toBe('open')
    expect(inboxKeyAction(key('d'), FREE)).toBe('done')
    expect(inboxKeyAction(key('y'), FREE)).toBe('allow')
    expect(inboxKeyAction(key('n'), FREE)).toBe('deny')
    expect(inboxKeyAction(key('Escape'), FREE)).toBe('close')
    // Read by meaning: ㅛ on the Y key of a Korean layout, outside a composition, is y
    expect(inboxKeyAction(key('ㅛ', { code: 'KeyY' }), FREE)).toBe('allow')
  })

  it('answers nothing while another layer covers the list: typing yarn in the palette over it allowed the row', () => {
    for (const k of ['y', 'a', 'r', 'n', 'Enter', 'd', 'j', 'Escape']) expect(inboxKeyAction(key(k), { typing: false, covered: true })).toBeNull()
  })

  it('answers nothing while a field has the keyboard', () => {
    for (const k of ['y', 'n', 'Enter', 'd', 'Escape']) expect(inboxKeyAction(key(k), { typing: true, covered: false })).toBeNull()
  })

  it('answers nothing on a key an input method is composing with', () => {
    expect(inboxKeyAction(key('ㅛ', { code: 'KeyY', isComposing: true }), FREE)).toBeNull()
    // WKWebView's composing keys carry keyCode 229
    expect(inboxKeyAction(key('Process', { code: 'KeyY', keyCode: 229 }), FREE)).toBeNull()
    expect(inboxKeyAction(key('Enter', { isComposing: true }), FREE)).toBeNull()
  })

  it('y and n take no modifier and no held key', () => {
    for (const m of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }, { shiftKey: true }, { repeat: true }]) {
      expect(inboxKeyAction(key('y', m), FREE), JSON.stringify(m)).toBeNull()
      expect(inboxKeyAction(key('n', m), FREE), JSON.stringify(m)).toBeNull()
    }
  })
})

describe('inboxCovered', () => {
  // The list itself is open: it does not cover itself
  const base = { openLayers: 0, paletteOpen: false, settingsOpen: false, usageOpen: false, inboxOpen: true, overlay: null }
  it('is any layer over the list', () => {
    expect(inboxCovered(base)).toBe(false)
    expect(inboxCovered({ ...base, paletteOpen: true })).toBe(true)
    expect(inboxCovered({ ...base, openLayers: 1 })).toBe(true)
    expect(inboxCovered({ ...base, settingsOpen: true })).toBe(true)
    expect(inboxCovered({ ...base, usageOpen: true })).toBe(true)
    expect(inboxCovered({ ...base, overlay: { kind: 'x' } })).toBe(true)
  })
})

describe('typingTarget', () => {
  it('is a field that takes text', () => {
    expect(typingTarget({ tagName: 'INPUT' } as never)).toBe(true)
    expect(typingTarget({ tagName: 'TEXTAREA' } as never)).toBe(true)
    expect(typingTarget({ tagName: 'DIV', isContentEditable: true } as never)).toBe(true)
    expect(typingTarget({ tagName: 'DIV', isContentEditable: false } as never)).toBe(false)
    expect(typingTarget(null)).toBe(false)
  })
})

describe('Enter on a focused control (#842 item 2)', () => {
  it('leaves Enter to a focused button or link, and still opens the row from the list itself', () => {
    expect(inboxKeyAction(key('Enter'), { ...FREE, onButton: true })).toBeNull()
    expect(inboxKeyAction(key('Enter'), { ...FREE, onButton: false })).toBe('open')
    // The other keys still act on the row under the cursor
    expect(inboxKeyAction(key('d'), { ...FREE, onButton: true })).toBe('done')
    expect(inboxKeyAction(key('Escape'), { ...FREE, onButton: true })).toBe('close')
  })

  it('reads a button, a link and what is inside a button as a control', () => {
    const el = (closest: string | null) => ({ closest: (sel: string) => (closest && sel.includes(closest) ? {} : null) }) as unknown as EventTarget
    expect(buttonTarget(el('button'))).toBe(true)
    expect(buttonTarget(el('a[href]'))).toBe(true)
    expect(buttonTarget(el(null))).toBe(false)
    expect(buttonTarget(null)).toBe(false)
  })
})
