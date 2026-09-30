import { describe, expect, it } from 'vitest'
import { isComposerSendKey, isPlainEnter, type ComposerKey } from './composerKeys.js'

/**
 * With the setting off, behavior **must not differ from before by even a single character**,
 * and with it on, Enter must never be read as send. Both are pinned down here as values — how
 * it actually behaves in a real composer lives in e2e (control-loop).
 */
const key = (over: Partial<ComposerKey> = {}): ComposerKey => ({
  key: 'Enter',
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  composing: false,
  ...over,
})

describe('isComposerSendKey — with the setting off (default)', () => {
  it('plain Enter sends', () => {
    expect(isComposerSendKey(key(), false)).toBe(true)
  })

  it('Shift+Enter breaks the line', () => {
    expect(isComposerSendKey(key({ shiftKey: true }), false)).toBe(false)
  })

  it('pressing a modifier key too still sends — some people already sent with Cmd+Enter before turning the setting on', () => {
    expect(isComposerSendKey(key({ metaKey: true }), false)).toBe(true)
    expect(isComposerSendKey(key({ ctrlKey: true }), false)).toBe(true)
  })
})

describe('isComposerSendKey — with the setting on', () => {
  it('plain Enter does not send (the composer breaks the line as usual)', () => {
    expect(isComposerSendKey(key(), true)).toBe(false)
  })

  it('Shift+Enter still breaks the line', () => {
    expect(isComposerSendKey(key({ shiftKey: true }), true)).toBe(false)
  })

  it('Cmd+Enter and Ctrl+Enter both send — accepted regardless of keyboard', () => {
    expect(isComposerSendKey(key({ metaKey: true }), true)).toBe(true)
    expect(isComposerSendKey(key({ ctrlKey: true }), true)).toBe(true)
  })

  it('sends even with Shift mixed in, as long as a modifier key is held — someone pressing Shift+Cmd+Enter still means to send', () => {
    expect(isComposerSendKey(key({ metaKey: true, shiftKey: true }), true)).toBe(true)
  })
})

/**
 * The rule left behind by #12 and #38. While composing, nothing sends **regardless of the
 * setting** — including Cmd+Enter for someone who turned it on. A setting turned on to stop a
 * half-formed character from going out must not itself cause exactly that.
 */
describe('isComposerSendKey — while the IME is composing a character', () => {
  it('plain Enter does not send even with the setting off', () => {
    expect(isComposerSendKey(key({ composing: true }), false)).toBe(false)
  })

  it('Cmd+Enter does not send even with the setting on', () => {
    expect(isComposerSendKey(key({ composing: true, metaKey: true }), true)).toBe(false)
  })
})

describe('isComposerSendKey — a key that is not Enter', () => {
  it('is never involved, under either setting', () => {
    expect(isComposerSendKey(key({ key: 'a' }), false)).toBe(false)
    expect(isComposerSendKey(key({ key: 'a', metaKey: true }), true)).toBe(false)
  })
})

/**
 * #181: the command palette's Enter handling did not check composition state — the last
 * syllable of a Korean-language alias was dropped
 */
describe('isPlainEnter — the save key for a single-line field (#181)', () => {
  it('only a non-composing Enter saves', () => {
    expect(isPlainEnter({ key: 'Enter', isComposing: false })).toBe(true)
    expect(isPlainEnter({ key: 'Enter', isComposing: true })).toBe(false)
    expect(isPlainEnter({ key: 'Process', isComposing: false })).toBe(false)
    expect(isPlainEnter({ key: 'a', isComposing: false })).toBe(false)
  })
})
