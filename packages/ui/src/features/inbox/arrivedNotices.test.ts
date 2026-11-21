import { describe, expect, it } from 'vitest'
import type { Notice } from '../../store/state/notifications.js'
import { arrivedNotices } from './InboxPill.jsx'

/**
 * What the inbox capsule takes for news (InboxPill's peek): a notice that arrived since the last look. It keeps the
 * keys of the notices there now only, not every key ever for the window's life.
 */

const notice = (sessionId: string, at: number, kind: Notice['kind'] = 'done'): Notice => ({ sessionId, kind, name: sessionId, at })

describe('arrivedNotices', () => {
  it('takes nothing there when the screen opens for news', () => {
    expect(arrivedNotices(null, [notice('a', 1)]).fresh).toEqual([])
  })

  it('takes a notice that arrived, and not one still there', () => {
    const { seen } = arrivedNotices(null, [notice('a', 1)])
    expect(arrivedNotices(seen, [notice('a', 1), notice('b', 2)]).fresh).toEqual([notice('b', 2)])
  })

  it('keeps only the notices there now: one that left is let go and does not come back as news', () => {
    let { seen } = arrivedNotices(null, [notice('a', 1), notice('b', 2)])
    ;({ seen } = arrivedNotices(seen, [notice('b', 2)]))
    expect([...seen]).toEqual(['b:done:2'])
    // Another change to the list does not bring the one that left back
    const next = arrivedNotices(seen, [notice('b', 2), notice('c', 3)])
    expect(next.fresh).toEqual([notice('c', 3)])
    expect(next.seen.size).toBe(2)
  })

  it('takes a session’s next notice for news, made at a later instant under a new key', () => {
    const { seen } = arrivedNotices(null, [notice('a', 1)])
    const left = arrivedNotices(seen, []).seen
    expect(arrivedNotices(left, [notice('a', 5)]).fresh).toEqual([notice('a', 5)])
  })
})
