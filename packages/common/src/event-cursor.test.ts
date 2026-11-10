import { describe, expect, it } from 'vitest'
import { EventCursor } from './event-cursor.js'

describe('the event cursor both ends of a host connection keep (#82, #173, #2163)', () => {
  it('a first contact starts at the host\'s number: its replay is old news, not new events', () => {
    const c = new EventCursor()
    expect(c.resumeFrom()).toBeNull()
    expect(c.greet({ currentSeq: 10, streamEpoch: 'e1' })).toEqual({ firstContact: true, newLifetime: true, resync: true })
    expect(c.take(10)).toBe(false)
    expect(c.take(11)).toBe(true)
    expect(c.take(11)).toBe(false)
    expect(c.resumeFrom()).toEqual({ afterSeq: 11, streamEpoch: 'e1' })
  })

  it('a reconnect to the same lifetime replays the gap; another lifetime, a host behind the cursor or a refused replay resyncs', () => {
    const c = new EventCursor()
    c.greet({ currentSeq: 5, streamEpoch: 'e1' })
    c.take(7)
    expect(c.greet({ currentSeq: 9, streamEpoch: 'e1' })).toEqual({ firstContact: false, newLifetime: false, resync: false })
    expect(c.take(8)).toBe(true)
    expect(c.greet({ currentSeq: 3, streamEpoch: 'e2' })).toMatchObject({ newLifetime: true, resync: true })
    expect(c.take(3)).toBe(false)
    expect(c.take(4)).toBe(true)
    expect(c.greet({ currentSeq: 2, streamEpoch: 'e2' })).toMatchObject({ newLifetime: true, resync: true })
    expect(c.greet({ currentSeq: 9, streamEpoch: 'e2', resyncRequired: true })).toMatchObject({ newLifetime: false, resync: true })
  })

  it('names an event the same in every window of one host lifetime, and not at all for a host that names no lifetime', () => {
    const a = new EventCursor()
    const b = new EventCursor()
    a.greet({ currentSeq: 3, streamEpoch: 'e1' })
    b.greet({ currentSeq: 7, streamEpoch: 'e1' })
    expect(a.eventId(8)).toBe(b.eventId(8))
    b.greet({ currentSeq: 1, streamEpoch: 'e2' })
    expect(b.eventId(8)).not.toBe(a.eventId(8))
    const old = new EventCursor()
    old.greet({ currentSeq: 3 })
    expect(old.eventId(8)).toBeUndefined()
  })

  it('forgetting it (a new endpoint) makes the next greeting a first contact', () => {
    const c = new EventCursor()
    c.greet({ currentSeq: 5 })
    c.forget()
    expect(c.resumeFrom()).toBeNull()
    expect(c.greet({ currentSeq: 1 }).firstContact).toBe(true)
  })
})
