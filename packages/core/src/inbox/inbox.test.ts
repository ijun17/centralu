import { describe, expect, it } from 'vitest'
import type { SessionState } from '@cc/protocol'
import { appArrivalCandidates, buildInbox, countWaiting, isAppArrivalId, isProposalId, noteAppArrivals, nextWaitingSession, pendingProposals, proposalCandidates, type InboxCandidate } from './inbox.js'

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

  it('counts them with the errors, as the list orders them, a turn its tool interrupted included', () => {
    const interrupted = s('codex', 'waiting_input', { interruption: { reason: 'interrupted', at: NOW } })
    const all = [s('quit', 'idle', { waitingSince: null, interruption: quit }), s('net', 'error', { interruption: { reason: 'network', at: NOW } }), interrupted]
    expect(countWaiting(all)).toEqual({ approval: 0, error: 3, input: 0 })
    expect(buildInbox([interrupted], NOW)[0]).toMatchObject({ urgency: 1 })
  })
})

/** A pending orchestrator proposal waits on the person like an approval (#703) */
describe('pending proposals', () => {
  const proposals = proposalCandidates(pendingProposals({ mcpProposals: [{ name: 'playwright' }], skillProposals: [{ name: 'weekly' }] }))

  it('are listed as approvals, after the approvals that have a start time, and counted with them', () => {
    const inbox = buildInbox([...proposals, s('a', 'waiting_approval'), s('b', 'error')], NOW)
    expect(inbox.map((i) => i.id)).toEqual(['a', 'proposal:mcp:playwright', 'proposal:skill:weekly', 'b'])
    expect(countWaiting([...proposals, s('a', 'waiting_approval')])).toEqual({ approval: 3, error: 0, input: 0 })
  })

  it('carry what they are, and an id no session has', () => {
    expect(proposals.map((p) => p.proposal)).toEqual([{ kind: 'skill', name: 'weekly' }, { kind: 'mcp', name: 'playwright' }])
    expect(proposals.every((p) => isProposalId(p.id))).toBe(true)
    expect(isProposalId('abc')).toBe(false)
  })

  it('"next waiting" walks through them and on', () => {
    const inbox = buildInbox([...proposals, s('a', 'waiting_approval')], NOW)
    expect(nextWaitingSession(inbox, 'a')).toBe('proposal:mcp:playwright')
    expect(nextWaitingSession(inbox, 'proposal:skill:weekly')).toBe('a')
  })
})

describe('apps a trusted project gains (#1141)', () => {
  const app = (projectId: string, appId: string) => ({ key: `${projectId}/${appId}`, projectId, appId, title: appId, asks: [] })
  it('a project seen for the first time gives no notice; an app it gains after does, once', () => {
    const first = noteAppArrivals([app('p1', 'notes')], new Set(['p1']), {})
    expect(first).toEqual({ seen: { p1: ['p1/notes'] }, arrived: [] })
    const later = noteAppArrivals([app('p1', 'notes'), app('p1', 'board')], new Set(['p1']), first.seen)
    expect(later.arrived.map((a) => a.key)).toEqual(['p1/board'])
    expect(noteAppArrivals([app('p1', 'notes'), app('p1', 'board')], new Set(['p1']), later.seen).arrived).toEqual([])
  })

  it('an untrusted project is not watched, and trusting it again starts afresh', () => {
    const seen = noteAppArrivals([app('p1', 'notes')], new Set(['p1']), {}).seen
    const untrusted = noteAppArrivals([app('p1', 'notes'), app('p1', 'board')], new Set(), seen)
    expect(untrusted).toEqual({ seen: {}, arrived: [] })
    expect(noteAppArrivals([app('p1', 'notes'), app('p1', 'board')], new Set(['p1']), untrusted.seen).arrived).toEqual([])
  })

  it('stands in the inbox as unread and waiting, under its own id', () => {
    const [row] = buildInbox(appArrivalCandidates([{ key: 'p1/board', projectId: 'p1', appId: 'board', title: 'Board', asks: [] }]), 0)
    expect(row).toMatchObject({ id: 'app-arrival:p1/board', name: 'New app: Board', unread: true, state: 'waiting_input' })
    expect(isAppArrivalId(row!.id)).toBe(true)
  })
})
