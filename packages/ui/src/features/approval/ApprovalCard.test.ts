import { describe, expect, it } from 'vitest'
import { approvalCardCovered, approvalKeyAction } from './ApprovalCard.jsx'

const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({
  key: k,
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

  it('⌥a는 프로젝트 범위 — 이 카드가 광고하는 유일한 조합키다', () => {
    expect(approvalKeyAction(key('a', { altKey: true }), FREE)).toEqual({ decision: 'always', scope: 'project' })
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
