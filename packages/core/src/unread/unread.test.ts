import { describe, expect, it } from 'vitest'
import { FOCUS_READ_MS, isUnread, shouldMarkRead, unreadCount } from './unread.js'

describe('deciding unread (FR-16)', () => {
  it('unread when lastSeq > lastReadSeq', () => {
    expect(isUnread({ lastSeq: 5, lastReadSeq: 3 })).toBe(true)
    expect(isUnread({ lastSeq: 3, lastReadSeq: 3 })).toBe(false)
  })

  it('the unread count', () => {
    expect(unreadCount({ lastSeq: 10, lastReadSeq: 4 })).toBe(6)
    expect(unreadCount({ lastSeq: 2, lastReadSeq: 9 })).toBe(0) // Never negative
  })
})

describe('when to mark read (avoiding the short-response trap)', () => {
  it('not marked read when not focused', () => {
    expect(shouldMarkRead({ focused: false, atBottom: true, focusedForMs: 99_999 })).toBe(false)
  })

  it('read at once when the scroll reaches the latest', () => {
    expect(shouldMarkRead({ focused: true, atBottom: true, focusedForMs: 0 })).toBe(true)
  })

  it('read after 3 seconds of focus even without scrolling (the short-response case)', () => {
    expect(shouldMarkRead({ focused: true, atBottom: false, focusedForMs: FOCUS_READ_MS })).toBe(true)
    expect(shouldMarkRead({ focused: true, atBottom: false, focusedForMs: FOCUS_READ_MS - 1 })).toBe(false)
  })
})
