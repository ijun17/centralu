import { describe, expect, it } from 'vitest'
import { isComposerSendKey, type ComposerKey } from './composerKeys.js'

/**
 * 설정이 꺼진 쪽은 **예전과 한 글자도 달라지면 안 되고**, 켠 쪽은 Enter를 절대
 * 보내기로 읽으면 안 된다. 둘 다 여기서 값으로 못박는다 — 실제 입력창에서 도는
 * 모습은 e2e(control-loop)에 있다.
 */
const key = (over: Partial<ComposerKey> = {}): ComposerKey => ({
  key: 'Enter',
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  composing: false,
  ...over,
})

describe('isComposerSendKey — 설정이 꺼져 있을 때 (기본)', () => {
  it('맨 Enter는 보낸다', () => {
    expect(isComposerSendKey(key(), false)).toBe(true)
  })

  it('⇧Enter는 줄바꿈이다', () => {
    expect(isComposerSendKey(key({ shiftKey: true }), false)).toBe(false)
  })

  it('조합키를 같이 눌러도 보낸다 — 켜기 전에도 ⌘Enter로 보내던 손이 있다', () => {
    expect(isComposerSendKey(key({ metaKey: true }), false)).toBe(true)
    expect(isComposerSendKey(key({ ctrlKey: true }), false)).toBe(true)
  })
})

describe('isComposerSendKey — 설정을 켰을 때', () => {
  it('맨 Enter는 보내지 않는다 (입력창이 평소대로 줄을 바꾼다)', () => {
    expect(isComposerSendKey(key(), true)).toBe(false)
  })

  it('⇧Enter도 여전히 줄바꿈이다', () => {
    expect(isComposerSendKey(key({ shiftKey: true }), true)).toBe(false)
  })

  it('⌘Enter와 Ctrl+Enter가 보낸다 — 자판을 묻지 않고 둘 다 받는다', () => {
    expect(isComposerSendKey(key({ metaKey: true }), true)).toBe(true)
    expect(isComposerSendKey(key({ ctrlKey: true }), true)).toBe(true)
  })

  it('⇧이 섞여도 조합키가 있으면 보낸다 — ⇧⌘Enter를 누른 사람도 보내려는 것이다', () => {
    expect(isComposerSendKey(key({ metaKey: true, shiftKey: true }), true)).toBe(true)
  })
})

/**
 * #12·#38이 남긴 규칙. 조합 중에는 **어느 설정에서도** 보내지 않는다 —
 * 켠 사람의 ⌘Enter도 마찬가지다. 반쯤 만들어진 글자가 나가는 것을 막자고 켠 설정이
 * 바로 그 일을 하면 안 된다.
 */
describe('isComposerSendKey — IME가 글자를 만드는 중', () => {
  it('꺼져 있어도 맨 Enter는 안 보낸다', () => {
    expect(isComposerSendKey(key({ composing: true }), false)).toBe(false)
  })

  it('켜져 있어도 ⌘Enter는 안 보낸다', () => {
    expect(isComposerSendKey(key({ composing: true, metaKey: true }), true)).toBe(false)
  })
})

describe('isComposerSendKey — Enter가 아닌 키', () => {
  it('어느 설정에서도 관여하지 않는다', () => {
    expect(isComposerSendKey(key({ key: 'a' }), false)).toBe(false)
    expect(isComposerSendKey(key({ key: 'a', metaKey: true }), true)).toBe(false)
  })
})
