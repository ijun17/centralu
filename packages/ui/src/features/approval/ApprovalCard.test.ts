import { describe, expect, it } from 'vitest'
import { approvalCardCovered, approvalKeyAction } from './ApprovalCard.jsx'

/**
 * `code`가 기본값을 갖는 것이 중요하다.
 *
 * 예전 이 헬퍼는 `key`만 만들었고, 그래서 `{ key: 'a', altKey: true }`로 ⌥a를 검사했다 —
 * **맥 자판이 절대 만들지 않는 이벤트다.** ABC 배열에서 ⌥A는 `å`로 오므로, 통과하던 이
 * 테스트 아래에서 실제 단축키는 죽어 있었다. 만들어낸 이벤트로 검사할 때는 그것이 진짜
 * 자판이 내는 모양인지부터 확인해야 한다.
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

describe('approvalKeyAction — 전역 y/n/a가 승인이 되는 조건 (U6)', () => {
  it('맨 y/n/a는 각각 허용·거부·항상 허용이다', () => {
    expect(approvalKeyAction(key('y'), FREE)).toEqual({ decision: 'allow' })
    expect(approvalKeyAction(key('n'), FREE)).toEqual({ decision: 'deny' })
    expect(approvalKeyAction(key('a'), FREE)).toEqual({ decision: 'always', scope: 'session' })
  })

  /**
   * 자판에 물어본 값 그대로다 (UCKeyTranslate): ABC·U.S.에서 ⌥A는 `å`, 한글 2벌식에서
   * A는 `ㅁ`. 리눅스·윈도우에서는 Alt가 문자를 바꾸지 않아 `a`로 온다 — 셋 다 같은 뜻이다.
   */
  it('⌥a는 프로젝트 범위 — 자판이 무슨 글자를 보내든', () => {
    const project = { decision: 'always', scope: 'project' }
    expect(approvalKeyAction(key('å', { altKey: true, code: 'KeyA' }), FREE)).toEqual(project) // 맥 ABC
    expect(approvalKeyAction(key('a', { altKey: true }), FREE)).toEqual(project) // 리눅스·윈도우
  })

  it('한글 입력 중에도 y/n/a가 통한다 — 한글로 쓰는 사람이 이 앱을 만들었다', () => {
    expect(approvalKeyAction(key('ㅛ', { code: 'KeyY' }), FREE)).toEqual({ decision: 'allow' })
    expect(approvalKeyAction(key('ㅜ', { code: 'KeyN' }), FREE)).toEqual({ decision: 'deny' })
    expect(approvalKeyAction(key('ㅁ', { code: 'KeyA' }), FREE)).toEqual({ decision: 'always', scope: 'session' })
  })

  /** Dvorak에서 f를 눌렀는데 승인이 되면 안 된다 — 자리가 아니라 글자를 먼저 믿는 이유 */
  it('라틴 글자로 온 것은 자리를 묻지 않는다 (Dvorak 안전)', () => {
    expect(approvalKeyAction(key('f', { code: 'KeyY' }), FREE)).toBeNull()
  })

  it('⌘·⌃·⇧ 조합은 다른 단축키다 — ⌘A(전체 선택)·⌘⇧A(다음 대기)가 승인으로 새면 안 된다', () => {
    expect(approvalKeyAction(key('a', { metaKey: true }), FREE)).toBeNull()
    expect(approvalKeyAction(key('a', { metaKey: true, shiftKey: true }), FREE)).toBeNull()
    expect(approvalKeyAction(key('a', { ctrlKey: true }), FREE)).toBeNull()
    expect(approvalKeyAction(key('y', { shiftKey: true }), FREE)).toBeNull()
    expect(approvalKeyAction(key('n', { metaKey: true }), FREE)).toBeNull()
  })

  it('입력창에 타이핑 중이면 받지 않는다 (contenteditable 포함)', () => {
    expect(approvalKeyAction(key('y'), { typing: true, covered: false })).toBeNull()
  })

  it('카드가 모달·오버레이 뒤에 가려져 있으면 받지 않는다 — 안 보이는 명령을 승인하게 된다', () => {
    expect(approvalKeyAction(key('y'), { typing: false, covered: true })).toBeNull()
    expect(approvalKeyAction(key('a', { altKey: true }), { typing: false, covered: true })).toBeNull()
  })

  it('승인과 무관한 키는 그대로 지나간다', () => {
    expect(approvalKeyAction(key('x'), FREE)).toBeNull()
    expect(approvalKeyAction(key('Escape'), FREE)).toBeNull()
  })
})

/*
 * 그리드에서는 pane마다 카드가 각자 window 리스너를 단다 — 포커스 검사가 없으면
 * 승인 2개가 떠 있을 때 y 한 번이 전부를 한꺼번에 승인한다.
 * 키보드 승인은 언제나 "포커스한 그 세션" 하나에만 간다.
 */
describe('approvalCardCovered — 어느 카드가 키를 받는가', () => {
  const open = {
    inboxOpen: false, usageOpen: false, settingsOpen: false, paletteOpen: false,
    overlay: null as unknown, focusedSessionId: 's1',
  }

  it('포커스된 세션의 카드만 키를 받는다', () => {
    expect(approvalCardCovered(open, 's1')).toBe(false)
    expect(approvalCardCovered(open, 's2')).toBe(true) // 그리드의 다른 pane
  })

  it('포커스가 없으면(그리드에서 아무 것도 안 고름) 어떤 카드도 받지 않는다', () => {
    expect(approvalCardCovered({ ...open, focusedSessionId: null }, 's1')).toBe(true)
  })

  it('모달·오버레이가 덮으면 포커스된 카드도 받지 않는다', () => {
    expect(approvalCardCovered({ ...open, inboxOpen: true }, 's1')).toBe(true)
    expect(approvalCardCovered({ ...open, usageOpen: true }, 's1')).toBe(true)
    expect(approvalCardCovered({ ...open, settingsOpen: true }, 's1')).toBe(true)
    expect(approvalCardCovered({ ...open, paletteOpen: true }, 's1')).toBe(true)
    expect(approvalCardCovered({ ...open, overlay: { kind: 'viewer' } }, 's1')).toBe(true)
  })
})
