import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
import { EventLog } from './event-log.js'

const ev = (text: string): NormalizedEvent => ({ type: 'message_delta', sessionId: 's1', role: 'assistant', text })

describe('EventLog: reconnect restoration (T3-1 done criteria)', () => {
  it('assigns seq as a monotonic increase starting from 1', () => {
    const log = new EventLog()
    expect(log.append(ev('a')).seq).toBe(1)
    expect(log.append(ev('b')).seq).toBe(2)
    expect(log.currentSeq).toBe(2)
  })

  it('connect → N events → disconnect → reconnect at afterSeq → receives only what was missed', () => {
    const log = new EventLog()
    log.append(ev('1'))
    log.append(ev('2')) // assume the UI received up to here
    log.append(ev('3')) // happened while the UI was disconnected
    log.append(ev('4'))

    const { events, resyncRequired } = log.since(2)
    expect(resyncRequired).toBe(false)
    expect(events.map((e) => e.seq)).toEqual([3, 4])
    expect((events[0]!.event as { text: string }).text).toBe('3')
  })

  it('an empty array when already caught up to the latest', () => {
    const log = new EventLog()
    log.append(ev('1'))
    expect(log.since(1)).toEqual({ events: [], resyncRequired: false })
  })

  it('afterSeq 0 gives the whole buffer (first connection)', () => {
    const log = new EventLog()
    log.append(ev('1'))
    log.append(ev('2'))
    expect(log.since(0).events.map((e) => e.seq)).toEqual([1, 2])
  })

  it('a request past the edge of the buffer gets resyncRequired', () => {
    const log = new EventLog(3)
    for (let i = 0; i < 10; i++) log.append(ev(String(i)))
    expect(log.oldestSeq).toBe(8) // only 8, 9, 10 remain
    const r = log.since(2)
    expect(r.resyncRequired).toBe(true)
    expect(r.events).toEqual([])
  })

  it('signals loss even when it reconnects like a first connection after a long disconnect', () => {
    const log = new EventLog(2)
    for (let i = 0; i < 5; i++) log.append(ev(String(i)))
    expect(log.since(0).resyncRequired).toBe(true)
  })

  /*
   * #173: when the host comes back up at the same address, numbering starts over from scratch. If
   * an old client shows up with an old number, previously it was given only an empty list without
   * being told to resync, and nothing was replayed until the new host's numbering passed the old
   * value.
   */
  it('requires a resync when a number it never assigned shows up (the host came back up)', () => {
    const log = new EventLog()
    for (let i = 0; i < 3; i++) log.append(ev(String(i)))
    expect(log.since(5000)).toEqual({ events: [], resyncRequired: true })
    expect(log.since(3)).toEqual({ events: [], resyncRequired: false })
  })

  it('discards the oldest first once capacity is exceeded', () => {
    const log = new EventLog(3)
    for (let i = 0; i < 5; i++) log.append(ev(String(i)))
    expect(log.since(4).events.map((e) => e.seq)).toEqual([5])
  })
})
