import { describe, expect, it } from 'vitest'
import { composerFocusAnswer } from './composerFocus.js'
import { mayTakeFocus } from '../../components/offerFocus.js'

const composer = { tagName: 'TEXTAREA' }
const body = { tagName: 'BODY' }
const button = { tagName: 'BUTTON' }
const field = { tagName: 'INPUT', type: 'text' }
const checkbox = { tagName: 'INPUT', type: 'checkbox' }
const editor = { tagName: 'DIV', isContentEditable: true }

const ask = (over: Partial<Parameters<typeof composerFocusAnswer>[0]> = {}) =>
  composerFocusAnswer({ asked: true, covered: false, approval: false, holder: body, input: composer, ...over } as Parameters<typeof composerFocusAnswer>[0])

describe('composerFocusAnswer (#528)', () => {
  it('takes the keyboard from the page, a button, or itself', () => {
    expect(ask()).toBe('take')
    expect(ask({ holder: null })).toBe('take')
    expect(ask({ holder: button as unknown as EventTarget })).toBe('take')
    expect(ask({ holder: composer as unknown as EventTarget })).toBe('take')
  })

  it('waits while not asked, or while a layer or another panel covers the session', () => {
    expect(ask({ asked: false })).toBe('wait')
    expect(ask({ covered: true })).toBe('wait')
    // Covered outranks the rest: the request is kept for when the layer closes
    expect(ask({ covered: true, approval: true })).toBe('wait')
  })

  it('leaves the keys to an approval card waiting in the session', () => {
    expect(ask({ approval: true })).toBe('decline')
  })

  it('never takes the keyboard from another field the person types in', () => {
    expect(ask({ holder: field as unknown as EventTarget })).toBe('decline')
    expect(ask({ holder: editor as unknown as EventTarget })).toBe('decline')
    expect(ask({ holder: { tagName: 'TEXTAREA' } as unknown as EventTarget })).toBe('decline')
  })
})

describe('mayTakeFocus (#528)', () => {
  it('is refused only by a field that takes text and is not the element itself', () => {
    expect(mayTakeFocus(null, composer as unknown as EventTarget)).toBe(true)
    expect(mayTakeFocus(body as unknown as EventTarget, composer as unknown as EventTarget)).toBe(true)
    expect(mayTakeFocus(checkbox as unknown as EventTarget, composer as unknown as EventTarget)).toBe(true)
    expect(mayTakeFocus(field as unknown as EventTarget, field as unknown as EventTarget)).toBe(true)
    expect(mayTakeFocus(field as unknown as EventTarget, composer as unknown as EventTarget)).toBe(false)
  })
})
