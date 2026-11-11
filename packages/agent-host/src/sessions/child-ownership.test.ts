import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionLiveDefaults } from '@cc/protocol'
import { Store } from '../dev-services/store.js'
import { ChildOwnership, type Delegation } from './child-ownership.js'
import type { AgentStartRecord } from './agent-start-record.js'

/*
 * The ownership state on its own (#428): each change writes its store mirror, and an owner change moves every map in
 * one call. The session manager's tests (handoff-children, busy-requests, delegated-cards) cover the
 * same state through the tools.
 */

let store: Store
let own: ChildOwnership

beforeEach(() => {
  store = new Store()
  own = new ChildOwnership(store)
})
afterEach(() => {
  store.close()
  vi.useRealTimers()
})

const delegation = (callerId: string, sessionId: string, extra: Partial<Delegation> = {}): Delegation =>
  ({ callerId, sessionId, target: { id: 'p', name: 'p', path: '/p' }, settled: false, ...extra }) as unknown as Delegation

const start = (requestId: string, callerId: string, extra: Partial<AgentStartRecord> = {}): AgentStartRecord => ({
  req: { requestId, callerId, projectId: 'p', tool: 'claude', task: 't', detail: { kind: 'agent_start', tool: 'claude', text: 't' } as never },
  detached: false,
  done: Promise.resolve(),
  end: () => {},
  ...extra,
})

/** Session `id` in the store, so its rows can be written: whose a turn is is read from them (#1639) */
const seedSession = (id: string) => {
  if (store.sessions.listSessions().some((s) => s.id === id)) return
  if (!store.projects.listProjects().length) store.projects.addProject({ id: 'p1', path: '/tmp/p1', name: 'p1' })
  store.sessions.upsertSession({
    id, projectId: 'p1', kind: 'worker', tool: 'claude', externalId: null, name: id, autoNamed: false, state: 'idle',
    lastReadSeq: 0, lastSeq: 0, createdAt: 1, waitingSince: null, live: false, model: null, effort: null,
    verbosity: null, serviceTier: null, permissionPreset: 'normal', importedFrom: null, worktree: null,
    parentSessionId: null, scopeSessionIds: null, roleAppend: null, appId: null, ...sessionLiveDefaults(),
  })
}
const HUB = { sessionId: '_hub-orchestrator', name: 'Parent' }
/** A message given session `id`'s tool under `inputId`, as the user row the host writes: the person's, a caller's, an app's, a relayed report's or a hub's. Returns its row */
function give(id: string, inputId: string, by: 'person' | 'caller' | 'app' | 'report' | 'hub' = 'person'): number {
  seedSession(id)
  const seq = store.messages.nextSeq(id)
  const from = by === 'hub' ? HUB : by === 'caller' || by === 'report' ? { sessionId: 'c', name: 'C' } : undefined
  const payload = { text: 't', inputId, ...(from ? { from } : {}), ...(by === 'app' ? { fromApp: { appId: 'a', name: 'A' } } : {}), ...(by === 'report' ? { relayed: true } : {}) }
  store.messages.appendMessages([{ sessionId: id, seq, role: 'user', kind: 'text', payload, ts: 1 }])
  return seq
}
/** The session's turn writes its words */
function says(id: string): void {
  seedSession(id)
  store.messages.appendMessages([{ sessionId: id, seq: store.messages.nextSeq(id), role: 'assistant', kind: 'text', payload: { text: 'words' }, ts: 1 }])
}
/** A turn begins after every row stored now, as `SessionEvents` notes it */
function begins(id: string): void {
  own.turnStarted(id)
  own.noteTurnStart(id, store.messages.nextSeq(id) - 1)
}

describe('the mailbox hears of a turn that starts (docs/plans/mailbox.md §6)', () => {
  const heard = () => {
    const turns: { sessionId: string; by: string; cli: boolean; source: string; ownerId?: string; again?: true }[] = []
    own.onTurnStarted((sessionId, turn) => void turns.push({ sessionId, ...turn }))
    return turns
  }

  it('says whose request the turn runs for: the session its message names, else the caller of a delegation still running there (its first prompt)', () => {
    const turns = heard()
    // Whatever delegation runs there, the message the turn opened with names its sender (docs/plans/mailbox.md §10.6.4)
    own.setDelegation('other>a', delegation('other', 'a'))
    give('a', 'a-1', 'caller')
    begins('a')
    own.setDelegation('owner>b', delegation('owner', 'b'))
    begins('b')
    own.setDelegation('gone>c', delegation('gone', 'c', { settled: true }))
    begins('c')
    expect(turns).toEqual([
      { sessionId: 'a', by: 'work', cli: false, source: 'caller', ownerId: 'c' },
      { sessionId: 'b', by: 'work', cli: true, source: 'caller', ownerId: 'owner' },
      { sessionId: 'c', by: 'work', cli: true, source: 'caller' },
    ])
  })

  it('says the person’s message is theirs', () => {
    const turns = heard()
    give('b', 'b-1')
    begins('b')
    expect(turns).toEqual([{ sessionId: 'b', by: 'person', cli: false, source: 'caller' }])
  })

  it('says what the work’s message was: a caller’s send, a report about another session, an app’s; the newest message guesses, and the input the tool names says again', () => {
    const turns = heard()
    give('a', 'a-1', 'report')
    begins('a')
    give('b', 'b-1', 'app')
    begins('b')
    // The person’s message last, after a report: the turn opens as the person’s, and the tool names the report
    give('c', 'c-1', 'report')
    give('c', 'c-2')
    begins('c')
    own.turnNamed('c', ['c-1'])
    // Into a running turn, a message the tool did not take in is the turn's it opens after, and keeps what it was
    begins('d')
    give('d', 'in-1', 'report')
    says('d')
    own.turnEnded('d', [])
    begins('d')
    own.turnNamed('d', ['in-1'])
    expect(turns.map((t) => [t.sessionId, t.by, t.source, t.cli, !!t.again])).toEqual([
      ['a', 'work', 'report', false, false],
      ['b', 'work', 'app', false, false],
      ['c', 'person', 'caller', false, false],
      ['c', 'work', 'report', false, true],
      ['d', 'work', 'caller', true, false],
      ['d', 'work', 'caller', true, false],
      ['d', 'work', 'report', false, true],
    ])
  })

  it('never breaks the turn when the mailbox fails', () => {
    own.onTurnStarted(() => {
      throw new Error('the store is busy')
    })
    expect(() => own.turnStarted('a')).not.toThrow()
    expect(own.turnEnded('a')).toEqual({ by: 'work' })
  })
})

describe('the mailbox hears that a call returned an answer (docs/plans/mailbox.md §8.1)', () => {
  it('is told who read what, and never breaks the call when the mailbox fails', () => {
    const seen: unknown[] = []
    own.onAnswered((callerId, childId, how) => void seen.push([callerId, childId, how]))
    own.answered('caller', 'child', { ok: true, text: 'done' })
    own.answered('caller', 'child')
    own.answered('same', 'same', { ok: true, text: 'itself' })
    expect(seen).toEqual([
      ['caller', 'child', { ok: true, text: 'done' }],
      ['caller', 'child', undefined],
    ])
    own.onAnswered(() => {
      throw new Error('the store is busy')
    })
    expect(() => own.answered('caller', 'child', { ok: true, text: 'x' })).not.toThrow()
  })
})

describe('the mailbox hears that a session is done with work it gave', () => {
  it('is told who deleted whose work, and never breaks the delete when the mailbox fails', () => {
    const seen: unknown[] = []
    own.onFinishedWith((callerId, childId) => void seen.push([callerId, childId]))
    own.finishedWith('caller', 'child')
    own.finishedWith('same', 'same')
    expect(seen).toEqual([['caller', 'child']])
    own.onFinishedWith(() => {
      throw new Error('the store is busy')
    })
    expect(() => own.finishedWith('caller', 'child')).not.toThrow()
  })
})

describe('the mailbox reads the tasks open with a session (docs/plans/mailbox.md §10.6.3)', () => {
  it('is asked for the session and the side, is none without a mailbox, and never breaks the caller when the mailbox fails', () => {
    expect(own.openTasks('child', 'to')).toEqual([])
    const seen: unknown[] = []
    own.onOpenTasks((sessionId, side) => {
      seen.push([sessionId, side])
      return side === 'to' ? ['caller'] : ['helper']
    })
    expect(own.openTasks('child', 'to')).toEqual(['caller'])
    expect(own.openTasks('child', 'from')).toEqual(['helper'])
    expect(seen).toEqual([['child', 'to'], ['child', 'from']])
    own.onOpenTasks(() => {
      throw new Error('the store is busy')
    })
    expect(own.openTasks('child', 'to')).toEqual([])
  })
})

describe('moveOwner', () => {
  it('moves every map for the moving children, and leaves what is not theirs', () => {
    const d1 = delegation('from', 'c1', { agent: true })
    const d2 = delegation('from', 'c2')
    const kept = delegation('from', 'stays')
    own.setDelegation('from>c1', d1)
    own.setDelegation('from>proj>c2', d2)
    own.setDelegation('from>stays', kept)
    own.setLinkedReport('c2', { assistantId: 'from', busy: false })
    const made = start('r-made', 'from', { ended: { childId: 'c1' } })
    const open = start('r-open', 'from')
    own.addAgentStart(made)
    own.addAgentStart(open)

    own.moveOwner('from', 'to', { sessions: ['c1', 'c2'], starts: [open] }, () => {})

    expect([...own.delegations.keys()].sort()).toEqual(['from>stays', 'to>c1', 'to>proj>c2'])
    expect(d1.callerId).toBe('to')
    expect(kept.callerId).toBe('from')
    expect(own.linkedReports.get('c2')?.assistantId).toBe('to')
    expect(made.req.callerId).toBe('to')
    // The open request's caller is the card mover's to change, with its card
    expect(open.req.callerId).toBe('from')
    expect(open.detached).toBe(true)
    expect([...own.handedOver]).toEqual([
      ['c1', { from: 'from', to: 'to' }],
      ['c2', { from: 'from', to: 'to' }],
      ['r-open', { from: 'from', to: 'to' }],
    ])
  })

  it('the cards move after the maps and before the handover is recorded; then the waits on what moved end', () => {
    const order: string[] = []
    const d = delegation('from', 'c1', { leaving: new Set([() => order.push('delegation wait ended')]) })
    own.setDelegation('from>c1', d)
    const open = start('r-open', 'from', { leaving: new Set([() => order.push('start wait ended')]) })
    own.addAgentStart(open)
    own.moveOwner('from', 'to', { sessions: ['c1'], starts: [open] }, () => {
      order.push(`cards: delegation ${own.delegations.has('to>c1') ? 'moved' : 'not moved'}, handover ${own.handedOver.size}`)
    })
    expect(order).toEqual(['cards: delegation moved, handover 0', 'delegation wait ended', 'start wait ended'])
  })
})

describe('forgetting a session', () => {
  it('drops what a handoff gave from it or to it', () => {
    own.recordHandedOver('c1', 'gone', 'heir')
    own.recordHandedOver('c2', 'other', 'gone')
    own.recordHandedOver('gone', 'x', 'y')
    own.recordHandedOver('c3', 'other', 'heir')
    own.forgetHandedOver('gone')
    expect([...own.handedOver.keys()]).toEqual(['c3'])
  })

  it('drops a delegation only while it is the one named', () => {
    const a = delegation('c', 's')
    const b = delegation('c', 's')
    own.setDelegation('k', b)
    own.dropDelegation('k', a)
    expect(own.delegations.get('k')).toBe(b)
    own.dropDelegation('k', b)
    expect(own.delegations.has('k')).toBe(false)
  })
})

/*
 * Whose a turn is (#1377, docs/plans/turn-starter.md "After #1948 step 3"): read from the store's user rows of the inputs the tool names, and
 * read when it ends. The host-level runs go through the manager.
 */
describe('whose a turn is', () => {
  it("the person at rest: the next turn is theirs; none recorded or the CLI's own: the work's", () => {
    give('s', 'p')
    begins('s')
    says('s')
    expect(own.turnEnded('s')).toEqual({ by: 'person' })
    // No message: the CLI started it (the work's tasks ended)
    begins('s')
    expect(own.turnEnded('s')).toEqual({ by: 'work' })
    // A turn never started reads as the work's: a host that did not see it begin
    expect(own.turnEnded('s')).toEqual({ by: 'work' })
  })

  it("a caller's, an app's or Centralu's message makes it the work's, also with the person's beside it when the tool names both", () => {
    give('s', 'w', 'caller')
    give('s', 'p')
    begins('s')
    own.turnNamed('s', ['w', 'p'])
    expect(own.turnEnded('s')).toEqual({ by: 'work', wrote: true })
  })

  it('the person into a running turn of the work: noted; into their own: nothing', () => {
    give('s', 'w', 'caller')
    begins('s')
    // Decided at the turn's end: a tool that takes every message into the running turn (no list of what it took)
    give('s', 'p1')
    says('s')
    expect(own.turnEnded('s')).toEqual({ by: 'work', wrote: true })
    give('s', 'p2')
    begins('s')
    give('s', 'p3')
    expect(own.turnEnded('s')).toEqual({ by: 'person' })
  })

  // The tool names the inputs a turn took (Claude's result): a message it did not take in is the turn's it opens
  it("a message the turn did not take in is the next turn's, theirs; one it took in is noted on this", () => {
    give('s', 'w', 'caller')
    begins('s')
    own.turnNamed('s', ['w'])
    give('s', 'in')
    give('s', 'held')
    says('s')
    expect(own.turnEnded('s', ['in'])).toEqual({ by: 'work', wrote: true })
    begins('s')
    own.turnNamed('s', ['held'])
    expect(own.turnEnded('s', ['held'])).toEqual({ by: 'person' })
  })

  it('naming none (an empty list) takes none in, and a tool that cannot name them (null) notes none (#1639)', () => {
    for (const taken of [[], null]) {
      give('s', `w-${String(taken)}`, 'caller')
      begins('s')
      own.turnNamed('s', [`w-${String(taken)}`])
      give('s', `p-${String(taken)}`)
      says('s')
      expect(own.turnEnded('s', taken)).toEqual({ by: 'work' })
    }
  })

  it('a turn a host did not see begin (it took the session over mid-turn) is the work’s, unless the inputs its end names say otherwise', () => {
    give('s', 'p')
    begins('s')
    says('s')
    expect(new ChildOwnership(store).turnEnded('s', null)).toEqual({ by: 'work' })
    expect(new ChildOwnership(store).turnEnded('s', ['p'])).toEqual({ by: 'person' })
    // A control: the host that saw it begin reads it as the person's
    expect(own.turnEnded('s', null)).toEqual({ by: 'person' })
  })

  it('reads only the inputs the tool names: of two messages before the turn, the one it names', () => {
    give('s', 'c1')
    give('s', 'c2', 'caller')
    begins('s')
    own.turnNamed('s', ['c1'])
    expect(own.turnEnded('s', [])).toEqual({ by: 'person' })
  })
})

// #1604: a sender's note into a running turn that the tool runs as the next turn is named back by the turn that opens
describe('what a turn that opens ran for', () => {
  /** A hub's message given the tool as `id`: its row says whose it is */
  const hub = (id: string) => ({ seq: give('s', id, 'hub'), from: HUB })

  it('names the sender and row of the note the turn opens for, once', () => {
    const note = hub('note-id')
    expect(own.turnNamed('s', ['other-id', 'note-id'])).toEqual(note)
    expect(own.turnNamed('s', ['note-id'])).toBeUndefined()
  })

  it('names nothing for a turn the tool opens with no input of a sender, or when the tool does not say', () => {
    const note = hub('note-id')
    expect(own.turnNamed('s', null)).toBeUndefined()
    expect(own.turnNamed('s', undefined)).toBeUndefined()
    expect(own.turnNamed('s', ['note-id'])).toEqual(note)
    begins('s')
    expect(own.turnNamed('s', [])).toBeUndefined()
    // The last named is the one it ran for: a person's message is no hub's
    give('s', 'person-id')
    begins('s')
    expect(own.turnNamed('s', ['note-id', 'person-id'])).toBeUndefined()
  })

  it('names the note a turn did not take, for the turn the tool runs it as, though turns have run since it was given', () => {
    begins('s')
    const note = hub('not-taken')
    says('s')
    own.turnEnded('s', [])
    begins('s')
    says('s')
    own.turnEnded('s', [])
    begins('s')
    expect(own.turnNamed('s', ['not-taken'])).toEqual(note)
  })

  it('keeps them across a host swap: a host that takes over the session still says whose message the turn it runs is for', () => {
    const note = hub('note-id')
    expect(new ChildOwnership(store).turnNamed('s', ['note-id'])).toEqual(note)
  })

  it("keeps nothing of a session's turns when it is deleted: not where its turns began", () => {
    hub('a')
    own.noteTurnStart('s', 1)
    expect(store.settings.appSetting('turn_span:s')).not.toBeNull()
    own.forgetTurns('s')
    expect(store.settings.appSetting('turn_span:s')).toBeNull()
  })
})

// #1604: where a hub reads the words of a turn from
describe('where the last turn that ended began', () => {
  it('is kept for the turns of every session, a hub following it or not: a stop notice reads the stopped turn by it (#1946)', () => {
    expect(own.turnRows('other')).toBeUndefined()
    own.noteTurnStart('other', 4)
    expect(own.turnRows('other')).toEqual({ after: 4 })
    own.noteTurnStart('s', 4)
    expect(own.turnRows('s')).toEqual({ after: 4 })
  })

  it('is the turn before the running one, up to where the running one began, when the running one has not ended', () => {
    own.noteTurnStart('s', 4)
    own.turnEnded('s')
    expect(own.turnRows('s')).toEqual({ after: 4 })
    own.noteTurnStart('s', 9)
    // The hub reads the end of the first turn as the second begins
    expect(own.turnRows('s')).toEqual({ after: 4, through: 9 })
  })

  // #1812: a hub reads a turn's words after its end, by when more than one turn may have followed it
  it('is the turn a hub names by where it began, up to where the next began, though later turns have begun and ended', () => {
    for (const start of [1, 3, 5, 7]) {
      own.noteTurnStart('s', start)
      own.turnEnded('s')
    }
    expect(own.turnRows('s', 1)).toEqual({ after: 1, through: 3 })
    expect(own.turnRows('s', 5)).toEqual({ after: 5, through: 7 })
    expect(own.turnRows('s', 7)).toEqual({ after: 7 })
  })

  it('is the last turn that ended for a start no longer kept, or a list a build before it left behind', () => {
    for (let start = 1; start <= 10; start++) {
      own.noteTurnStart('s', start)
      own.turnEnded('s')
    }
    // Eight are kept: the first two are gone
    expect(own.turnRows('s', 2)).toEqual({ after: 10 })
    expect(own.turnRows('s', 3)).toEqual({ after: 3, through: 4 })
    // An older build wrote the span since: its list does not end at the latest start, so only the two it keeps are read
    store.settings.setAppSetting('turn_span:s', JSON.stringify({ latest: { since: 12, ended: true }, previous: { since: 11 }, starts: [3, 4, 10] }))
    expect(own.turnRows('s', 3)).toEqual({ after: 12 })
    expect(own.turnRows('s', 11)).toEqual({ after: 11, through: 12 })
  })

  it('is the latest turn once it has ended, even when it said nothing: never the turn before it', () => {
    own.noteTurnStart('s', 4)
    own.turnEnded('s')
    own.noteTurnStart('s', 9)
    own.turnEnded('s')
    expect(own.turnRows('s')).toEqual({ after: 9 })
  })

  it('is closed with the process: a turn that never sent its end has its own words', () => {
    own.noteTurnStart('s', 4)
    own.turnEnded('s')
    own.noteTurnStart('s', 9)
    // A control: the turn still running reads as the turn before it
    expect(own.turnRows('s')).toEqual({ after: 4, through: 9 })
    own.noteTurnEnd('s')
    expect(own.turnRows('s')).toEqual({ after: 9 })
    // Closing it again, or a session whose turns were never seen, is nothing
    own.noteTurnEnd('s')
    own.noteTurnEnd('nobody')
    expect(own.turnRows('s')).toEqual({ after: 9 })
    expect(store.settings.appSetting('turn_span:nobody')).toBeNull()
  })

  it('survives a host swap: the host that takes the session over reads where the running turn began, and ends it', () => {
    own.noteTurnStart('s', 4)
    own.turnEnded('s')
    own.noteTurnStart('s', 9)
    const next = new ChildOwnership(store)
    expect(next.turnRows('s')).toEqual({ after: 4, through: 9 })
    next.turnEnded('s')
    expect(new ChildOwnership(store).turnRows('s')).toEqual({ after: 9 })
  })
})

/*
 * #1639 (docs/plans/turn-starter.md): a turn is guessed at its start by the newest row, a message given at rest, else it is the CLI's own; when
 * the tool names the input the turn opened from, it is decided by that, with no clock
 */
describe('whose a turn is, by the inputs the tool names (#1639)', () => {
  const told: { sessionId: string; by: string; cli: boolean; again?: true }[] = []
  beforeEach(() => {
    told.length = 0
    own.onTurnStarted((sessionId, t) => void told.push({ sessionId, by: t.by, cli: t.cli, ...(t.again ? { again: t.again } : {}) }))
  })

  it('a message the tool holds queued for 20 s still starts its sender’s turn: no window decides it', () => {
    vi.useFakeTimers()
    give('s', 'caller-1', 'caller')
    vi.advanceTimersByTime(20_000)
    begins('s')
    expect(told).toEqual([{ sessionId: 's', by: 'work', cli: false }])
  })

  it('a turn the tool names from the person’s row is the person’s, and from a caller’s or an app’s row the work’s', () => {
    for (const [by, turn] of [['person', 'person'], ['caller', 'work'], ['app', 'work']] as const) {
      give('s', `${by}-1`, by)
      says('s')
      begins('s')
      own.turnNamed('s', [`${by}-1`])
      expect(own.turnEnded('s', [`${by}-1`])).toEqual({ by: turn })
    }
    // Each was guessed the CLI's own (the newest row was the turn before's words), and decided again as the tool named it
    expect(told.filter((t) => t.again)).toEqual([
      { sessionId: 's', by: 'person', cli: false, again: true },
      { sessionId: 's', by: 'work', cli: false, again: true },
      { sessionId: 's', by: 'work', cli: false, again: true },
    ])
  })

  it('is decided again when the tool names the input the turn opened from: the start went by the newest row', () => {
    give('s', 'caller-0', 'caller')
    begins('s')
    // A caller's note the turn does not take in; the person writes once it ended
    give('s', 'caller-1', 'caller')
    says('s')
    own.turnEnded('s', ['caller-0'])
    give('s', 'person-1')
    begins('s')
    own.turnNamed('s', ['caller-1'])
    expect(told.slice(1)).toEqual([{ sessionId: 's', by: 'person', cli: false }, { sessionId: 's', by: 'work', cli: false, again: true }])
    // The same answer again is not told twice, and the next turn, after this one's words, is the CLI's own until named
    own.turnNamed('s', ['caller-1'])
    expect(told).toHaveLength(3)
    says('s')
    expect(own.turnEnded('s', [])).toEqual({ by: 'work' })
    begins('s')
    expect(told.at(-1)).toEqual({ sessionId: 's', by: 'work', cli: true })
  })

  it('an input named that no message went in under (a mail wake, a compact), or none named, is the CLI’s own', () => {
    give('s', 'person-1')
    begins('s')
    own.turnNamed('s', ['wake-1'])
    expect(told.at(-1)).toEqual({ sessionId: 's', by: 'work', cli: true, again: true })
    own.turnEnded('s', ['wake-1'])
    give('s', 'person-2')
    begins('s')
    own.turnNamed('s', [])
    expect(told.at(-1)).toEqual({ sessionId: 's', by: 'work', cli: true, again: true })
    // Not an opening: nothing changes
    own.turnNamed('s', null)
    expect(told).toHaveLength(4)
  })

  it('a note the turn says it took joined it; one it did not take is the next turn’s', () => {
    give('s', 'caller-1', 'caller')
    begins('s')
    own.turnNamed('s', ['caller-1'])
    give('s', 'person-1')
    give('s', 'person-2')
    expect(own.turnEnded('s', ['person-1'])).toEqual({ by: 'work', wrote: true })
    begins('s')
    own.turnNamed('s', ['person-2'])
    expect(own.turnEnded('s', ['person-2'])).toEqual({ by: 'person' })
  })

  it('a turn whose opening was not named (a card was up) is decided by the inputs its end names, however long they waited', () => {
    vi.useFakeTimers()
    give('s', 'person-1')
    give('s', 'caller-1', 'caller')
    vi.advanceTimersByTime(20_000)
    says('s')
    begins('s')
    expect(own.turnEnded('s', ['person-1', 'caller-1'])).toEqual({ by: 'work', wrote: true })
    expect(told.at(-1)).toEqual({ sessionId: 's', by: 'work', cli: false, again: true })
  })

  // Review of #1929: what a host that takes a kept session over mid-turn reads
  describe('across a keeper swap', () => {
    it('a work turn the person wrote into stays the work’s, with the person noted', () => {
      give('s', 'caller-1', 'caller')
      begins('s')
      own.turnNamed('s', ['caller-1'])
      give('s', 'person-1')
      // The CLI names both at the end: the caller's it opened from, and the person's it took in at a tool round
      expect(new ChildOwnership(store).turnEnded('s', ['caller-1', 'person-1'])).toEqual({ by: 'work', wrote: true })
    })

    it('the person’s message given into the turn, from a tool that names nothing at the end (Codex), is noted on it', () => {
      give('s', 'caller-1', 'caller')
      begins('s')
      give('s', 'person-1')
      expect(new ChildOwnership(store).turnEnded('s', undefined)).toEqual({ by: 'work', wrote: true })
    })

    it('reads a message given at rest from its row: a new session’s first one', () => {
      give('s', 'person-1')
      const next = new ChildOwnership(store)
      next.onTurnStarted((sessionId, t) => void told.push({ sessionId, by: t.by, cli: t.cli }))
      next.turnStarted('s')
      expect(told).toEqual([{ sessionId: 's', by: 'person', cli: false }])
    })
  })

  it('a person’s message held over a turn’s end and taken into the next work turn at a tool round is noted on it', () => {
    give('s', 'caller-0', 'caller')
    begins('s')
    own.turnNamed('s', ['caller-0'])
    give('s', 'caller-1', 'caller')
    give('s', 'person-1')
    says('s')
    // Neither was taken: both wait for the next turn, which opens on the caller's
    expect(own.turnEnded('s', ['caller-0'])).toEqual({ by: 'work' })
    begins('s')
    own.turnNamed('s', ['caller-1'])
    expect(own.turnEnded('s', ['caller-1', 'person-1'])).toEqual({ by: 'work', wrote: true })
  })
})
