import { describe, expect, it } from 'vitest'
import type { SessionState } from '@cc/protocol'
import { appArrivalCandidates, buildInbox, countWaiting, isAppArrivalId, isProposalId, noteAppArrivals, nextWaitingSession, pendingProposals, proposalCandidates, stampProposals, type InboxCandidate } from './inbox.js'

const NOW = 1_000_000

const s = (id: string, state: SessionState, opts: Partial<InboxCandidate> = {}): InboxCandidate => ({
  id, projectId: 'p1', name: id, state,
  // Unread by default, so a `waiting_input` session is listed unless a test reads it (#669)
  waitingSince: NOW - 60_000, lastSeq: 2, lastReadSeq: 1, ...opts,
})

describe('inbox order (FR-15)', () => {
  it('newest first, whatever the state (#2213)', () => {
    const inbox = buildInbox(
      [
        s('a', 'waiting_input', { waitingSince: NOW - 1000 }),
        s('b', 'error', { waitingSince: NOW - 3000 }),
        s('c', 'waiting_approval', { waitingSince: NOW - 2000 }),
      ],
      NOW,
    )
    expect(inbox.map((i) => i.id)).toEqual(['a', 'c', 'b'])
  })

  it('a row with no start time has just arrived, so it is first', () => {
    const inbox = buildInbox(
      [s('old', 'waiting_approval', { waitingSince: NOW - 99_000 }), s('proposal', 'waiting_approval', { waitingSince: null }), s('new', 'waiting_approval', { waitingSince: NOW - 1000 })],
      NOW,
    )
    expect(inbox.map((i) => i.id)).toEqual(['proposal', 'new', 'old'])
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
  const inbox = buildInbox([s('a', 'waiting_approval', { waitingSince: NOW - 1000 }), s('b', 'error', { waitingSince: NOW - 2000 }), s('c', 'waiting_input', { waitingSince: NOW - 3000 })], NOW)

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
    const inbox = buildInbox([s('done', 'waiting_input', { waitingSince: NOW - 90_000 }), s('quit', 'idle', { waitingSince: null, interruption: quit })], NOW)
    expect(inbox.map((i) => i.id)).toEqual(['quit', 'done'])
    expect(inbox[0]).toMatchObject({ waitingSince: quit.at, waitingMs: 30_000 })
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
  })
})

/** A pending assistant proposal waits on the person like an approval (#703) */
describe('pending proposals', () => {
  const proposals = proposalCandidates(pendingProposals({ mcpProposals: [{ name: 'playwright' }], skillProposals: [{ name: 'weekly' }] }))

  it('are listed as approvals, as the newest since they have no start time, and counted with them', () => {
    const inbox = buildInbox([...proposals, s('a', 'waiting_approval'), s('b', 'error')], NOW)
    expect(inbox.map((i) => i.id)).toEqual(['proposal:mcp:playwright', 'proposal:skill:weekly', 'a', 'b'])
    expect(countWaiting([...proposals, s('a', 'waiting_approval')])).toEqual({ approval: 3, error: 0, input: 0 })
  })

  // The inbox is newest first: a proposal or an app that arrived is placed by when this window first saw it, not on top for good
  it('are placed by the time the window first saw them, among the sessions', () => {
    const stamped = proposalCandidates(pendingProposals({ mcpProposals: [{ name: 'playwright', at: NOW - 5000 }], skillProposals: [] }))
    const arrival = appArrivalCandidates([{ key: 'p1/board', projectId: 'p1', appId: 'board', title: 'Board', asks: [], at: NOW - 50_000 }])
    const inbox = buildInbox([...stamped, ...arrival, s('new', 'waiting_approval', { waitingSince: NOW - 1000 }), s('old', 'waiting_approval', { waitingSince: NOW - 99_000 })], NOW)
    expect(inbox.map((i) => i.id)).toEqual(['new', 'proposal:mcp:playwright', 'app-arrival:p1/board', 'old'])
  })

  it('keep the time of the read that first saw them', () => {
    const first = stampProposals([], [{ name: 'a' }, { name: 'b' }], 100)
    expect(first.map((p) => p.at)).toEqual([100, 100])
    const again = stampProposals(first, [{ name: 'b' }, { name: 'c' }], 900)
    expect(again).toEqual([{ name: 'b', at: 100 }, { name: 'c', at: 900 }])
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
    const first = noteAppArrivals([app('p1', 'notes')], new Set(['p1']), {}, NOW)
    expect(first).toEqual({ seen: { p1: ['p1/notes'] }, arrived: [] })
    const later = noteAppArrivals([app('p1', 'notes'), app('p1', 'board')], new Set(['p1']), first.seen, NOW + 5)
    expect(later.arrived.map((a) => a.key)).toEqual(['p1/board'])
    // The time the window noted it, which orders its row
    expect(later.arrived[0]?.at).toBe(NOW + 5)
    expect(noteAppArrivals([app('p1', 'notes'), app('p1', 'board')], new Set(['p1']), later.seen, NOW).arrived).toEqual([])
  })

  it('an untrusted project is not watched, and trusting it again starts afresh', () => {
    const seen = noteAppArrivals([app('p1', 'notes')], new Set(['p1']), {}, NOW).seen
    const untrusted = noteAppArrivals([app('p1', 'notes'), app('p1', 'board')], new Set(), seen, NOW)
    expect(untrusted).toEqual({ seen: {}, arrived: [] })
    expect(noteAppArrivals([app('p1', 'notes'), app('p1', 'board')], new Set(['p1']), untrusted.seen, NOW).arrived).toEqual([])
  })

  it('stands in the inbox as unread and waiting, under its own id', () => {
    const [row] = buildInbox(appArrivalCandidates([{ key: 'p1/board', projectId: 'p1', appId: 'board', title: 'Board', asks: [], at: 0 }]), 0)
    expect(row).toMatchObject({ id: 'app-arrival:p1/board', name: 'New app: Board', unread: true, state: 'waiting_input' })
    expect(isAppArrivalId(row!.id)).toBe(true)
  })
})
