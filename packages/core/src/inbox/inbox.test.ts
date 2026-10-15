import { describe, expect, it } from 'vitest'
import type { SessionState } from '@cc/protocol'
import { buildInbox, countWaiting, nextWaitingSession, type InboxCandidate } from './inbox.js'

const NOW = 1_000_000

const s = (id: string, state: SessionState, opts: Partial<InboxCandidate> = {}): InboxCandidate => ({
  id, projectId: 'p1', name: id, state,
  // Unread by default, so a `waiting_input` session is listed unless a test reads it (#669)
  waitingSince: NOW - 60_000, lastSeq: 2, lastReadSeq: 1, ...opts,
})

describe('inbox order (FR-15)', () => {
  it('urgency first: approval → error → awaiting response', () => {
    const inbox = buildInbox([s('a', 'waiting_input'), s('b', 'error'), s('c', 'waiting_approval')], NOW)
    expect(inbox.map((i) => i.id)).toEqual(['c', 'b', 'a'])
  })

  it('within the same urgency, unread comes first', () => {
    // Approvals keep a read one listed (#669), so the order is observable here
    const inbox = buildInbox(
      [s('read', 'waiting_approval', { lastSeq: 5, lastReadSeq: 5 }), s('unread', 'waiting_approval', { lastSeq: 5, lastReadSeq: 2 })],
      NOW,
    )
    expect(inbox.map((i) => i.id)).toEqual(['unread', 'read'])
  })

  it('lists a waiting_input session only while unread (#669)', () => {
    const inbox = buildInbox(
      [s('read', 'waiting_input', { lastSeq: 5, lastReadSeq: 5 }), s('unread', 'waiting_input', { lastSeq: 5, lastReadSeq: 2 })],
      NOW,
    )
    expect(inbox.map((i) => i.id)).toEqual(['unread'])
  })

  it('a new answer (a new lastSeq) lists a read waiting_input session again (#669)', () => {
    expect(buildInbox([s('a', 'waiting_input', { lastSeq: 5, lastReadSeq: 5 })], NOW)).toHaveLength(0)
    expect(buildInbox([s('a', 'waiting_input', { lastSeq: 6, lastReadSeq: 5 })], NOW).map((i) => i.id)).toEqual(['a'])
  })

  it('approvals and errors stay listed even when read (#669)', () => {
    const inbox = buildInbox(
      [s('ap', 'waiting_approval', { lastSeq: 5, lastReadSeq: 5 }), s('er', 'error', { lastSeq: 5, lastReadSeq: 5 })],
      NOW,
    )
    expect(inbox.map((i) => i.id)).toEqual(['ap', 'er'])
  })

  it('with the same urgency and the same read state, the longest wait comes first', () => {
    const inbox = buildInbox(
      [s('new', 'waiting_approval', { waitingSince: NOW - 1000 }), s('old', 'waiting_approval', { waitingSince: NOW - 99_000 })],
      NOW,
    )
    expect(inbox.map((i) => i.id)).toEqual(['old', 'new'])
  })

  it('working and idle sessions are not in the inbox', () => {
    const inbox = buildInbox(
      [s('w', 'working'), s('i', 'idle'), s('ok', 'waiting_input')],
      NOW,
    )
    expect(inbox.map((i) => i.id)).toEqual(['ok'])
  })

  it('limited is informational, so it is not put in the inbox (shown in the sidebar only)', () => {
    expect(buildInbox([s('l', 'limited')], NOW)).toHaveLength(0)
  })

  it('computes how long the wait has lasted', () => {
    const [item] = buildInbox([s('a', 'waiting_approval', { waitingSince: NOW - 180_000 })], NOW)
    expect(item!.waitingMs).toBe(180_000)
  })

  it('the order is deterministic (id breaks ties)', () => {
    const items = [s('b', 'waiting_input', { waitingSince: NOW }), s('a', 'waiting_input', { waitingSince: NOW })]
    expect(buildInbox(items, NOW).map((i) => i.id)).toEqual(['a', 'b'])
    expect(buildInbox([...items].reverse(), NOW).map((i) => i.id)).toEqual(['a', 'b'])
  })
})

describe('global counters (FR-12: never summed)', () => {
  it('counts approvals, errors and awaiting response separately', () => {
    const c = countWaiting([
      s('1', 'waiting_approval'), s('2', 'waiting_approval'), s('3', 'waiting_input'),
      s('4', 'waiting_input'), s('5', 'waiting_input'), s('6', 'working'), s('7', 'error'),
    ])
    expect(c).toEqual({ approval: 2, error: 1, input: 3 })
  })

  it('counts a waiting_input session only while unread; approvals and errors always (#669)', () => {
    const c = countWaiting([
      s('1', 'waiting_input', { lastSeq: 4, lastReadSeq: 4 }),
      s('2', 'waiting_input', { lastSeq: 5, lastReadSeq: 4 }),
      s('3', 'waiting_approval', { lastSeq: 4, lastReadSeq: 4 }),
      s('4', 'error', { lastSeq: 4, lastReadSeq: 4 }),
    ])
    expect(c).toEqual({ approval: 1, error: 1, input: 1 })
  })
})

describe('go to the next waiting item (FR-17)', () => {
  const inbox = buildInbox([s('a', 'waiting_approval'), s('b', 'error'), s('c', 'waiting_input')], NOW)

  it('the first item when there is no current one', () => {
    expect(nextWaitingSession(inbox, null)).toBe('a')
  })

  it('cycles', () => {
    expect(nextWaitingSession(inbox, 'a')).toBe('b')
    expect(nextWaitingSession(inbox, 'c')).toBe('a')
  })

  it('the first item when the current one is not in the inbox (it was just handled)', () => {
    expect(nextWaitingSession(inbox, 'zzz')).toBe('a')
  })

  it('null for an empty inbox', () => {
    expect(nextWaitingSession([], 'a')).toBeNull()
  })
})

/** A turn the network, a quit or its tool cut short (#698): listed as an error is, while the person has not read it */
describe('stopped turns in the inbox (#698)', () => {
  const quit = { reason: 'quit' as const, at: NOW - 30_000 }

  it('an idle session a quit stopped is listed while its line is unread, as urgent as an error, and waits since it stopped', () => {
    const inbox = buildInbox([s('done', 'waiting_input'), s('quit', 'idle', { waitingSince: null, interruption: quit })], NOW)
    expect(inbox.map((i) => i.id)).toEqual(['quit', 'done'])
    expect(inbox[0]).toMatchObject({ urgency: 1, waitingSince: quit.at, waitingMs: 30_000 })
    expect(buildInbox([s('quit', 'idle', { waitingSince: null, interruption: quit, lastSeq: 4, lastReadSeq: 4 })], NOW)).toEqual([])
    // An idle session nothing stopped is not waiting on anyone
    expect(buildInbox([s('idle', 'idle', { waitingSince: null })], NOW)).toEqual([])
  })

  it('a tool reconnecting for too long is listed though it works, read or not', () => {
    const r = { reason: 'reconnecting' as const, at: NOW - 6 * 60_000 }
    expect(buildInbox([s('r', 'working', { waitingSince: null, interruption: r, lastSeq: 3, lastReadSeq: 3 })], NOW).map((i) => i.id)).toEqual(['r'])
  })

  it('counts them with the errors, so the counters and the list agree', () => {
    expect(countWaiting([s('quit', 'idle', { waitingSince: null, interruption: quit }), s('net', 'error', { interruption: { reason: 'network', at: NOW } })])).toEqual({
      approval: 0, error: 2, input: 0,
    })
  })
})
