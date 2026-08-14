import { describe, expect, it } from 'vitest'
import { FOCUS_READ_MS, isUnread, shouldMarkRead, unreadCount } from './unread.js'

describe('안읽음 판정 (FR-16)', () => {
  it('lastSeq > lastReadSeq면 안읽음', () => {
    expect(isUnread({ lastSeq: 5, lastReadSeq: 3 })).toBe(true)
    expect(isUnread({ lastSeq: 3, lastReadSeq: 3 })).toBe(false)
  })

  it('안읽은 개수', () => {
    expect(unreadCount({ lastSeq: 10, lastReadSeq: 4 })).toBe(6)
    expect(unreadCount({ lastSeq: 2, lastReadSeq: 9 })).toBe(0) // 음수 방지
  })
})

describe('읽음 처리 조건 (짧은 응답 함정 방지)', () => {
  it('포커스 안 됐으면 읽음 처리 안 함', () => {
    expect(shouldMarkRead({ focused: false, atBottom: true, focusedForMs: 99_999 })).toBe(false)
  })

  it('스크롤이 최신에 닿으면 즉시 읽음', () => {
    expect(shouldMarkRead({ focused: true, atBottom: true, focusedForMs: 0 })).toBe(true)
  })

  it('스크롤이 없어도 포커스 3초면 읽음 (짧은 응답 케이스)', () => {
    expect(shouldMarkRead({ focused: true, atBottom: false, focusedForMs: FOCUS_READ_MS })).toBe(true)
    expect(shouldMarkRead({ focused: true, atBottom: false, focusedForMs: FOCUS_READ_MS - 1 })).toBe(false)
  })
})
