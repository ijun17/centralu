/**
 * Every turn is recorded with who started it and the thread it belongs to (docs/plans/mailbox.md §6, slice 3): the ones the
 * mailbox's delivery starts, and the ones it did not (the person typing, a caller's message, the CLI running on). The guards of
 * §7.9 count only the first kind.
 */
import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
import { Store } from '../dev-services/store.js'
import { sessionAddress } from './address.js'
import { delegationRecorder, turnRecorder } from './delegation.js'
import { MailService } from './service.js'
import { MailTurns } from './turns.js'

const HOST = 'hub-aaaaaaaa'
const NOW = 1_800_000_000_000
const OWNER = sessionAddress(HOST, 'owner')

function setup() {
  const store = new Store()
  const clock = { t: NOW }
  const mail = new MailService(store.mail, { hostId: () => HOST, now: () => clock.t })
  const turns = new MailTurns(store.mail, { now: () => clock.t })
  const recorder = turnRecorder(mail, store.mail, turns)
  const delegate = delegationRecorder(mail, () => ({ projectId: 'p1' }), turns)
  const threadOf = (child: string) => store.mail.latestBetween(OWNER, sessionAddress(HOST, child))!
  return { store, mail, turns, recorder, delegate, clock, threadOf }
}
const ends = (turns: MailTurns, sessionId: string, calls = false) => {
  if (calls) turns.observe({ type: 'tool_call', sessionId } as NormalizedEvent, false)
  turns.observe({ type: 'turn_complete', sessionId }, true)
}
const work = { by: 'work', added: false, cli: false, source: 'caller' } as const
const person = { by: 'person', added: false, cli: false, source: 'caller' } as const

describe('a turn the mailbox did not start', () => {
  it('the person’s own is recorded with no thread, and ends with how it went', () => {
    const { store, turns, recorder } = setup()
    recorder('child', person)
    expect(turns.current('child')).toEqual({ by: 'person', threadId: null })
    ends(turns, 'child', true)
    expect(store.mail.turnsOf('child')).toEqual([expect.objectContaining({ turnSeq: 1, threadId: null, startedBy: 'person', outcome: 'acted', endedAt: NOW })])
    expect(turns.current('child')).toBeUndefined()
  })

  it('a caller’s message starts a turn of the thread that caller owns with the session', () => {
    const { store, turns, recorder, delegate, threadOf } = setup()
    delegate('owner', 'child', 'start_agent', 'Land #12')
    const thread = threadOf('child')
    recorder('child', { ...work, ownerId: 'owner' })
    expect(turns.current('child')).toEqual({ by: 'caller', threadId: thread.id })
    expect(store.mail.hasOpenTurn(thread.id)).toBe(true)
    ends(turns, 'child')
    expect(store.mail.hasOpenTurn(thread.id)).toBe(false)
    expect(store.mail.turnsOf('child')[0]).toMatchObject({ startedBy: 'caller', threadId: thread.id, outcome: 'empty' })
  })

  it('the CLI running on by itself, after the background work of the work’s last turn, is a turn of that thread too', () => {
    const { turns, recorder, delegate, threadOf } = setup()
    delegate('owner', 'child', 'start_agent', 'Run the watcher')
    recorder('child', { by: 'work', added: false, cli: true, source: 'caller', ownerId: 'owner' })
    expect(turns.current('child')).toEqual({ by: 'cli', threadId: threadOf('child').id })
  })

  it('the person adding their message to the task is their turn, of the task’s thread; just asking is of none', () => {
    const { turns, recorder, delegate, threadOf } = setup()
    delegate('owner', 'child', 'start_agent', 'Land #12')
    recorder('child', { by: 'work', added: true, cli: false, source: 'caller', ownerId: 'owner' })
    expect(turns.current('child')).toEqual({ by: 'person', threadId: threadOf('child').id })
    ends(turns, 'child')
    recorder('child', { ...person, ownerId: 'owner' })
    expect(turns.current('child')).toEqual({ by: 'person', threadId: null })
  })

  it('belongs to no thread when it has no owner, no thread between the two, or the thread is done', () => {
    const { mail, turns, recorder, delegate, threadOf } = setup()
    recorder('a', work)
    expect(turns.current('a')).toEqual({ by: 'caller', threadId: null })
    recorder('b', { ...work, ownerId: 'owner' })
    expect(turns.current('b')).toEqual({ by: 'caller', threadId: null })
    delegate('owner', 'c', 'start_agent', 'x')
    mail.update(threadOf('c').id, OWNER, { state: 'done', outcome: 'finished' })
    recorder('c', { ...work, ownerId: 'owner' })
    expect(turns.current('c')).toEqual({ by: 'caller', threadId: null })
  })

  it('a turn a caller’s message started before the delegation was written down belongs to its thread from then; the person’s does not', () => {
    const { store, turns, recorder, delegate, threadOf } = setup()
    recorder('child', { ...work, ownerId: 'owner' })
    expect(turns.current('child')).toEqual({ by: 'caller', threadId: null })
    delegate('owner', 'child', 'start_agent', 'Land #12')
    expect(turns.current('child')).toEqual({ by: 'caller', threadId: threadOf('child').id })
    expect(store.mail.turnsOf('child')[0]).toMatchObject({ threadId: threadOf('child').id })
    ends(turns, 'child')
    recorder('child', person)
    delegate('owner', 'child', 'agent_session', 'and more')
    expect(turns.current('child')).toEqual({ by: 'person', threadId: null })
  })

  it('is the turn mail started when one is going: the wake was its first input, and nothing is added', () => {
    const { store, turns, recorder, delegate, threadOf } = setup()
    delegate('owner', 'child', 'start_agent', 'x')
    const id = threadOf('child').id
    turns.begin('child', id)
    recorder('child', { ...work, ownerId: 'owner' })
    expect(store.mail.turnsOf('child')).toHaveLength(1)
    expect(turns.current('child')).toEqual({ by: 'mail', threadId: id })
  })

  it('numbers its turns, so that one turn of a thread is told from the next (what a request’s turn has read is that turn’s)', () => {
    const { turns, delegate, threadOf } = setup()
    expect(turns.numberOf('child')).toBeUndefined()
    delegate('owner', 'child', 'start_agent', 'x')
    const id = threadOf('child').id
    const first = turns.begin('child', id)
    expect(turns.numberOf('child')).toBe(first)
    const second = turns.begin('child', id)
    expect(second).not.toBe(first)
    expect(turns.numberOf('child')).toBe(second)
  })

  it('a turn that never saw its end is closed lost when the next one starts', () => {
    const { store, turns, recorder } = setup()
    recorder('child', person)
    recorder('child', person)
    expect(store.mail.turnsOf('child').map((t) => [t.turnSeq, t.outcome])).toEqual([
      [1, 'lost'],
      [2, null],
    ])
    expect(turns.current('child')).toMatchObject({ by: 'person' })
  })
})

describe('the guards of §7.9 count only the turns mail started', () => {
  it('turns of the person that did nothing are no empty run, and their tokens are no budget', () => {
    const { turns, recorder } = setup()
    for (let i = 0; i < 4; i++) {
      recorder('child', person)
      turns.observe({ type: 'usage_update', sessionId: 'child', request: { inputTokens: 500_000, cacheCreationTokens: 0 } } as unknown as NormalizedEvent, false)
      // Not while it runs either
      expect(turns.tokensInAnHour('child')).toBe(0)
      ends(turns, 'child')
    }
    expect(turns.budgetSpent('child')).toBe(false)
    expect(turns.tokensInAnHour('child')).toBe(0)
  })

  it('and three of mail’s that did nothing are one', () => {
    const { turns } = setup()
    for (let i = 0; i < 3; i++) {
      turns.begin('child', null)
      ends(turns, 'child')
    }
    expect(turns.budgetSpent('child')).toBe(true)
  })
})

describe('what starts a turn that is not a caller’s send', () => {
  it('a report or notice about another session is a turn of its own kind, with no thread; so is an app’s message', () => {
    const { store, turns, recorder } = setup()
    recorder('owner', { by: 'work', added: false, cli: false, source: 'report', ownerId: 'x' })
    expect(turns.current('owner')).toEqual({ by: 'report', threadId: null })
    ends(turns, 'owner')
    recorder('owner', { by: 'work', added: false, cli: false, source: 'app' })
    expect(turns.current('owner')).toEqual({ by: 'app', threadId: null })
    expect(store.mail.turnsOf('owner').map((t) => t.startedBy)).toEqual(['report', 'app'])
  })

  it('and a loop of them counts for no guard', () => {
    const { store, turns, recorder } = setup()
    for (let i = 0; i < 30; i++) {
      recorder('owner', { by: 'work', added: false, cli: false, source: 'report' })
      ends(turns, 'owner')
    }
    expect(turns.budgetSpent('owner')).toBe(false)
    expect(store.mail.turnsOf('owner')).toHaveLength(30)
  })
})

describe('a thread found after the turn began', () => {
  it('binds to the turn that is the work of the caller who gave it, and to no other caller’s, the person’s or a report’s', () => {
    const { turns, recorder, delegate, threadOf } = setup()
    // Another caller’s turn is going in the child when this caller’s delegation is written down
    recorder('child', { ...work, ownerId: 'someone-else' })
    delegate('owner', 'child', 'start_agent', 'x')
    expect(turns.current('child')).toEqual({ by: 'caller', threadId: null })
    ends(turns, 'child')
    // A turn that is nobody’s work, a report’s, the person’s
    for (const turn of [work, { ...work, source: 'report' as const }, person]) {
      recorder('child', turn)
      delegate('owner', 'child', 'agent_session', 'y')
      expect(turns.current('child')?.threadId).toBeNull()
      ends(turns, 'child')
    }
    // The caller’s own
    recorder('child', { ...work, ownerId: 'owner' })
    delegate('owner', 'child', 'agent_session', 'z')
    expect(turns.current('child')).toEqual({ by: 'caller', threadId: threadOf('child').id })
  })
})

describe('turns across a restart of the host', () => {
  it('a kept session’s open row is read back and its end recorded; any other open row is closed lost', () => {
    const { store, recorder } = setup()
    recorder('kept', person)
    recorder('not-kept', { ...work, ownerId: 'owner' })
    const next = new MailTurns(store.mail, { now: () => NOW + 5_000, keepOpen: (id) => id === 'kept' })
    next.closeStale()
    expect(store.mail.turnsOf('kept')).toEqual([expect.objectContaining({ startedBy: 'person', endedAt: null })])
    expect(store.mail.turnsOf('not-kept')).toEqual([expect.objectContaining({ outcome: 'lost', endedAt: NOW + 5_000 })])
    expect(next.current('kept')).toEqual({ by: 'person', threadId: null })
    // Its end is what the new host sees now, and it counts as the kind it was
    next.observe({ type: 'tool_call', sessionId: 'kept' } as NormalizedEvent, false)
    next.observe({ type: 'turn_complete', sessionId: 'kept' }, true)
    expect(store.mail.turnsOf('kept')[0]).toMatchObject({ outcome: 'acted', endedAt: NOW + 5_000 })
  })

  it('with nothing kept, every open row is closed lost, as before; a row of a word this build does not know is read as a caller’s', () => {
    const { store, recorder } = setup()
    recorder('a', person)
    store.mail.startTurn({ sessionId: 'b', turnSeq: 1, threadId: null, startedBy: 'some-newer-word', startedAt: NOW })
    new MailTurns(store.mail, { now: () => NOW + 1 }).closeStale()
    expect(store.mail.openTurns()).toEqual([])
    const kept = new MailTurns(store.mail, { keepOpen: () => true })
    store.mail.startTurn({ sessionId: 'c', turnSeq: 1, threadId: null, startedBy: 'some-newer-word', startedAt: NOW })
    kept.closeStale()
    expect(kept.current('c')).toEqual({ by: 'caller', threadId: null })
  })
})
