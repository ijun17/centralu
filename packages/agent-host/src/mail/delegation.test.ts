/**
 * Work a session gave another is written down in the mailbox as a thread (docs/plans/mailbox.md §8.1), beside the old path that
 * delivered it: the caller owns it, the child is the assignee, the task is the first `assign`, and nothing wakes anyone.
 */
import { describe, expect, it } from 'vitest'
import { Store } from '../dev-services/store.js'
import { sessionAddress } from './address.js'
import { delegationRecorder } from './delegation.js'
import { MailTurns } from './turns.js'
import { refusalReason } from './rules.js'
import { MailService } from './service.js'
import { mailRelations } from './relations.js'

const HOST = 'hub-aaaaaaaa'
const NOW = 1_800_000_000_000
const CALLER = sessionAddress(HOST, 'caller')
const CHILD = sessionAddress(HOST, 'child')

function setup() {
  const store = new Store()
  const clock = { t: NOW }
  // The relations of §9.1 refuse a session writing to a stranger: a recorded delegation is the host's act, after the tool's own checks
  const policy = mailRelations({
    // The caller started child and child3, so a task made with mail may go to them; the delegation is the host’s act and needs no such relation
    session: (id) => ({ kind: 'worker' as const, askedBy: id === 'child' || id === 'child3' ? 'caller' : null }),
    mailTool: () => true,
    inThread: () => false,
  })
  const mail = new MailService(store.mail, { hostId: () => HOST, now: () => clock.t, policy })
  return { store, mail, clock }
}
const task = (over: Partial<Parameters<MailService['recordDelegation']>[1]> = {}) => ({ assignee: CHILD, task: 'Land #12\nand check the docs', origin: 'start_agent' as const, ...over })

describe('a delegation written down', () => {
  it('is a running thread the caller owns and the child is assigned, whose first message is the task as the caller wrote it', () => {
    const { mail } = setup()
    const { thread, message, continued } = mail.recordDelegation(CALLER, task({ projectId: 'p1' }))
    expect(continued).toBe(false)
    expect(thread).toMatchObject({ owner: CALLER, assignee: CHILD, state: 'running', origin: 'start_agent', projectId: 'p1', subject: 'Land #12' })
    expect(message).toMatchObject({ sender: CALLER, kind: 'assign', body: 'Land #12\nand check the docs' })
  })

  it('is delivered and read for the child already, so nothing wakes it: the old path gave it the task', () => {
    const { store, mail } = setup()
    const { message } = mail.recordDelegation(CALLER, task())
    expect(store.mail.receiptsOf(message.id)).toEqual([expect.objectContaining({ recipient: CHILD, deliveredAt: NOW, readAt: NOW })])
    expect(mail.drain(CHILD, {}).messageIds).toEqual([])
    expect(store.mail.hasDue(CHILD, NOW + 60_000)).toBe(false)
  })

  it('does not go through the relations or the rate: the delegation’s own checks came first', () => {
    const { mail } = setup()
    // A session that did not start the child, to a child in another project: the policy alone would refuse it
    const stranger = sessionAddress(HOST, 'stranger')
    expect(() => mail.open(stranger, { kind: 'assign', subject: 's', body: 'b', assignee: CHILD })).toThrow()
    expect(() => mail.recordDelegation(stranger, task())).not.toThrow()
    for (let i = 0; i < 40; i++) mail.recordDelegation(sessionAddress(HOST, `c${i}`), task({ task: `task ${i}` }))
  })

  it('a later instruction to the same child is a note in the thread they have, and the child has it in hand again', () => {
    const { store, mail, clock } = setup()
    const first = mail.recordDelegation(CALLER, task())
    store.mail.updateThread(first.thread.id, { state: 'review' }, NOW, false)
    clock.t += 5_000
    const again = mail.recordDelegation(CALLER, task({ task: 'also run the linter', origin: 'agent_session' }))
    expect(again.continued).toBe(true)
    expect(again.thread.id).toBe(first.thread.id)
    expect(again.message).toMatchObject({ kind: 'note', body: 'also run the linter', sender: CALLER })
    expect(again.thread.state).toBe('running')
    const events = store.mail.messagesAfter(first.thread.id, 0).filter((m) => m.kind === 'event')
    expect(events.map((e) => e.facts)).toEqual([expect.objectContaining({ change: 'state', from: 'review', to: 'running' })])
    expect(store.mail.receiptsOf(again.message.id)[0]).toMatchObject({ recipient: CHILD, deliveredAt: NOW + 5_000, readAt: NOW + 5_000 })
  })

  it('a thread that is done is not added to: the new instruction opens a thread that follows it', () => {
    const { mail, clock } = setup()
    const first = mail.recordDelegation(CALLER, task())
    mail.update(first.thread.id, CALLER, { state: 'done', outcome: 'finished' })
    clock.t += 1_000
    const second = mail.recordDelegation(CALLER, task({ task: 'one more thing' }))
    expect(second.continued).toBe(false)
    expect(second.thread.id).not.toBe(first.thread.id)
    expect(second.thread.follows).toEqual([first.thread.id])
    expect(second.thread.state).toBe('running')
  })

  it('a different child is a different thread', () => {
    const { mail } = setup()
    const a = mail.recordDelegation(CALLER, task())
    const b = mail.recordDelegation(CALLER, task({ assignee: sessionAddress(HOST, 'other') }))
    expect(b.thread.id).not.toBe(a.thread.id)
  })

  it('a task past the longest a session posts is cut with Centralu’s note, and the whole of it is the child’s conversation', () => {
    const { mail } = setup()
    const { message } = mail.recordDelegation(CALLER, task({ task: 'x'.repeat(20_000) }))
    expect(message.body.length).toBeLessThanOrEqual(16_000)
    expect(message.body).toContain('[Centralu: cut here. The full task is in the session’s conversation (read_session).]'.replace('’', "'"))
    expect(message.body.startsWith('xxxx')).toBe(true)
  })

  it('takes its subject from the first line of the task, cut at 200 characters as a subject is', () => {
    const { mail } = setup()
    expect(mail.recordDelegation(CALLER, task({ task: `${'w'.repeat(300)}\nmore` })).thread.subject).toBe(`${'w'.repeat(200)}…`)
    expect(mail.recordDelegation(sessionAddress(HOST, 'c2'), task({ task: '\n\nsecond line only' })).thread.subject).toBe('second line only')
  })

  it('refuses a task with nothing in it, two parties that are one, an address that is not a session, and an origin that is not one', () => {
    const { mail } = setup()
    const reason = (fn: () => unknown) => {
      try {
        fn()
      } catch (e) {
        return refusalReason(e)
      }
      return 'NOT REFUSED'
    }
    expect(reason(() => mail.recordDelegation(CALLER, task({ task: '  ' })))).toBe('empty')
    expect(reason(() => mail.recordDelegation(CALLER, task({ assignee: CALLER })))).toBe('bad_value')
    expect(reason(() => mail.recordDelegation(CALLER, task({ assignee: 'person' })))).toBe('bad_address')
    expect(reason(() => mail.recordDelegation(CALLER, task({ origin: 'nonsense' as never })))).toBe('bad_value')
  })
})

describe('a delegation handed on in the middle of work', () => {
  it('is a child of the thread of the turn the caller is in, and works at the depth the host knows', () => {
    const { store, mail } = setup()
    const turns = new MailTurns(store.mail)
    const record = delegationRecorder(mail, (id) => ({ projectId: null, depth: id === 'grand' ? 2 : 0 }), turns)
    // 'caller' is doing the work 'boss' gave it, in a turn of that thread
    const work = mail.recordDelegation(sessionAddress(HOST, 'boss'), { assignee: CALLER, task: 'Land #12', origin: 'start_agent' }).thread
    turns.beginOther('caller', 'caller', work.id)
    record('caller', 'grand', 'start_agent', 'Write the tests')
    expect(store.mail.latestBetween(CALLER, sessionAddress(HOST, 'grand'))).toMatchObject({ parentId: work.id, depth: 2 })
    // A turn that belongs to no thread (the person's own) hands nothing on from anything
    turns.beginOther('caller', 'person', null)
    record('caller', 'other', 'start_agent', 'Another')
    expect(store.mail.latestBetween(CALLER, sessionAddress(HOST, 'other'))).toMatchObject({ parentId: null, depth: 0 })
  })
})

describe('a delegation next to the tasks made with the mail tool', () => {
  it('does not take a task one gave through mail, which has its own assign still to arrive, for the delegation’s thread', () => {
    const { mail } = setup()
    const mine = mail.open(CALLER, { kind: 'assign', subject: 'Task X', body: 'x', assignee: CHILD })
    const delegated = mail.recordDelegation(CALLER, task({ task: 'Task Y' }))
    expect(delegated.continued).toBe(false)
    expect(delegated.thread.id).not.toBe(mine.thread.id)
    expect(mine.thread.state).toBe('open')
  })

  it('archiving a party moves the work as §3.3 has it, the same as for a task made with mail: the person owns a gone owner’s, a gone assignee leaves it open', () => {
    const { store, mail } = setup()
    const owned = mail.recordDelegation(CALLER, task()).thread
    const had = mail.recordDelegation(sessionAddress(HOST, 'owner2'), task({ assignee: sessionAddress(HOST, 'child2') })).thread
    mail.partyGone(CALLER)
    mail.partyGone(sessionAddress(HOST, 'child2'))
    // Never closed by it: the child goes on, and its later reports reach the person, who may drop the work
    expect(store.mail.thread(owned.id)).toMatchObject({ owner: 'person', assignee: CHILD, state: 'running' })
    expect(store.mail.participants(owned.id).find((p) => p.address === 'person')).toMatchObject({ role: 'owner' })
    expect(store.mail.thread(had.id)).toMatchObject({ owner: sessionAddress(HOST, 'owner2'), assignee: null, state: 'open' })
    const events = store.mail.messagesAfter(owned.id, 0).filter((m) => m.kind === 'event').map((m) => m.facts)
    expect(events).toEqual([expect.objectContaining({ change: 'owner_gone', party: CALLER })])
    expect(store.mail.inboxOf('person').map((r) => r.thread.id)).toContain(owned.id)
  })
})

describe('the recorder the host hands the manager', () => {
  it('writes the thread from ids, with the child’s project', () => {
    const { store, mail } = setup()
    delegationRecorder(mail, (id) => (id === 'child' ? { projectId: 'p9' } : undefined))('caller', 'child', 'ask_project', 'Ask the other project')
    const [row] = store.mail.threadsOfParty(CALLER, 'owner')
    expect(row).toMatchObject({ assignee: CHILD, origin: 'ask_project', projectId: 'p9', subject: 'Ask the other project', state: 'running' })
    delegationRecorder(mail, () => ({ projectId: '' }))('caller', 'child2', 'start_agent', 'An agent outside any project')
    expect(store.mail.latestBetween(CALLER, sessionAddress(HOST, 'child2'))?.projectId).toBeNull()
  })
})
