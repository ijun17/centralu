/**
 * The person's side of the mailbox (#1347, docs/plans/mailbox.md §10.1): what the Inbox lists and shows, the person's words, and
 * the acts that are theirs, over a real store and the same `MailService` a session writes through, and through the RPC door.
 */
import { describe, expect, it } from 'vitest'
import { MailThreadView, RpcMethods } from '@cc/protocol'
import { Store } from '../dev-services/store.js'
import { createRpcHandler } from '../rpc.js'
import type { SessionManager } from '../sessions/manager.js'
import { PERSON, appAddress, sessionAddress } from './address.js'
import { MailPerson } from './person.js'
import { mailRelations } from './relations.js'
import { refusalReason } from './rules.js'
import { MailService } from './service.js'
import { openBy } from './mail.test-helpers.js'

const HOST = 'hub-aaaaaaaa'
const NOW = 1_800_000_000_000
const S1 = sessionAddress(HOST, 's1')
const S2 = sessionAddress(HOST, 's2')
const APP = appAddress(HOST, 'p1', 'board')

function setup() {
  const store = new Store()
  const clock = { t: NOW }
  const mail = new MailService(store.mail, { hostId: () => HOST, now: () => clock.t })
  const calls: string[] = []
  const delivery = {
    resumeSession: (id: string) => void calls.push(`session:${id}`),
    resumeThread: (id: string) => void calls.push(`thread:${id}`),
    answerCrowd: async (wake: boolean) => void calls.push(`crowd:${wake}`),
    crowdWaiting: () => 3,
  }
  const sessions = new Map([
    ['s1', { name: 'Orchestrator work', state: 'idle' }],
    ['s2', { name: 'Parser', state: 'working' }],
  ])
  const person = new MailPerson(mail, store.mail, delivery, { session: (id) => sessions.get(id) })
  return { store, mail, person, clock, calls }
}

describe('what the Inbox lists', () => {
  it('the threads the person is in, unread first, with the parties as Centralu names them, the last word, and how much waits', () => {
    const { mail, person, store, clock } = setup()
    expect(person.list()).toEqual({ threads: [], held: [], waiting: 3 })

    const a = openBy(mail, { by: S1, kind: 'question', subject: 'Which branch?', body: 'main or release?', members: [PERSON] })
    clock.t += 5_000
    const b = openBy(mail, { by: PERSON, kind: 'assign', subject: 'Land #12', body: 'please land it', assignee: S2 })
    clock.t += 5_000
    mail.post(b.thread.id, S2, { kind: 'note', body: 'on it' })

    const { threads } = person.list()
    // Both have something unread for the person; the latest change is first
    expect(threads.map((t) => t.id)).toEqual([b.thread.id, a.thread.id])
    expect(threads.find((t) => t.id === a.thread.id)).toMatchObject({
      subject: 'Which branch?',
      state: 'open',
      unread: 1,
      held: 0,
      owner: { address: S1, kind: 'session', sessionId: 's1', name: 'Orchestrator work', state: 'idle' },
      assignee: null,
      last: { sender: { address: S1, name: 'Orchestrator work' }, kind: 'question', preview: 'main or release?' },
    })
    expect(threads.find((t) => t.id === b.thread.id)).toMatchObject({
      owner: { address: PERSON, kind: 'person', sessionId: null, name: null },
      assignee: { address: S2, name: 'Parser', state: 'working' },
      last: { kind: 'note', preview: 'on it' },
    })
    // Read, it is no longer unread
    expect(person.thread(a.thread.id).messages).toHaveLength(1)
    expect(person.list().threads.find((t) => t.id === a.thread.id)?.unread).toBe(0)
    expect(store.mail.inboxOf(PERSON)).toHaveLength(2)
  })

  it('says a turn of the thread is going, so the Inbox asks before Drop or Mark done stops it (3.10); never for a thread that is done', () => {
    const { mail, person } = setup()
    const { thread } = openBy(mail, { by: S1, kind: 'assign', subject: 'Land #12', body: 'please', assignee: S2 })
    expect(person.thread(thread.id).thread.working).toBeFalsy()
    mail.useClosing({ turnRunning: () => true, closed: () => {} })
    expect(person.thread(thread.id).thread.working).toBe(true)
    person.close(thread.id, 'dropped')
    expect(person.thread(thread.id).thread.working).toBeFalsy()
  })

  it('mail held for the person is listed with why and for whom, and counts on its thread', () => {
    const { mail, person, store, clock } = setup()
    const { thread, message } = openBy(mail, { by: S1, kind: 'assign', subject: 'Work', body: 'do it', assignee: S2, members: [PERSON] })
    clock.t += 10_000
    store.mail.setHeld(S2, [message.id], 'loop')
    const list = person.list()
    expect(list.held).toEqual([
      expect.objectContaining({ messageId: message.id, threadId: thread.id, subject: 'Work', reason: 'loop', kind: 'assign', preview: 'do it', sender: expect.objectContaining({ address: S1 }), recipient: expect.objectContaining({ address: S2, name: 'Parser' }) }),
    ])
    expect(list.threads[0]!.held).toBe(1)
  })

  it('an app is named by its app id, a party that is gone by its address alone', () => {
    const { mail, person } = setup()
    const { thread } = openBy(mail, { by: S1, kind: 'assign', subject: 'Merge', body: 'merge #12', assignee: APP, members: [PERSON] })
    mail.post(thread.id, APP, { kind: 'notice', body: 'PR 12 merged' })
    const view = person.thread(thread.id)
    expect(view.messages.at(-1)!.sender).toEqual({ address: APP, kind: 'app', sessionId: null, name: 'board', state: null })
    const gone = openBy(mail, { by: sessionAddress(HOST, 'gone'), kind: 'question', subject: 'q', body: 'b', members: [PERSON] })
    expect(person.thread(gone.thread.id).messages[0]!.sender).toMatchObject({ kind: 'session', sessionId: 'gone', name: null, state: null })
  })
})

describe('a thread, and the person’s words in it', () => {
  it('shows the parties, the blockers and the messages, and reads them in pages of 100 with more to say so', () => {
    const { mail, person, clock } = setup()
    const { thread } = openBy(mail, { by: PERSON, kind: 'assign', subject: 's', body: 'm1', assignee: S2 })
    for (let i = 2; i <= 105; i++) {
      clock.t += 1_000
      mail.post(thread.id, PERSON, { kind: 'note', body: `m${i}` })
    }
    const first = person.thread(thread.id)
    expect(first.messages).toHaveLength(100)
    expect(first.more).toBe(true)
    expect(first.parties.map((p) => [p.party.address, p.role])).toEqual(expect.arrayContaining([[PERSON, 'owner'], [S2, 'assignee']]))
    const second = person.thread(thread.id)
    expect(second.messages.map((m) => m.seq)).toEqual([101, 102, 103, 104, 105])
    expect(second.more).toBe(false)
    // From the start again
    expect(person.thread(thread.id, { all: true }).messages.length).toBe(100)
  })

  it('a long thread opens at its end: the newest 100, read to the end, with the earlier part to ask for', () => {
    const { mail, person, clock, store } = setup()
    const { thread } = openBy(mail, { by: S1, kind: 'question', subject: 'q', body: 'm1', members: [PERSON] })
    for (let i = 2; i <= 105; i++) {
      clock.t += 3_000
      mail.post(thread.id, S1, { kind: 'note', body: `m${i}` })
    }
    const end = person.thread(thread.id, { tail: 100 })
    expect(end.messages.map((m) => m.seq)).toEqual(Array.from({ length: 100 }, (_, i) => i + 6))
    expect(end).toMatchObject({ older: true, more: false })
    expect(end.messages.at(-1)!.body).toBe('m105')
    // Read to its end, though the earlier part was not shown
    expect(person.list().threads.find((t) => t.id === thread.id)!.unread).toBe(0)
    expect(store.mail.readPosition(thread.id, PERSON)).toBe(105)

    const earlier = person.thread(thread.id, { tail: 100, before: 6 })
    expect(earlier.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5])
    expect(earlier.older).toBe(false)
    // Asked again from where it is: nothing new
    expect(person.thread(thread.id).messages).toEqual([])
  })

  it('a reply is the person’s words, goes to the thread’s receivers, and comes back as the new message alone', () => {
    const { mail, person, store } = setup()
    const { thread } = openBy(mail, { by: S1, kind: 'question', subject: 'q', body: 'which?', members: [PERSON] })
    person.thread(thread.id)
    const back = person.reply(thread.id, 'the release branch', 'answer')
    expect(back.messages.map((m) => [m.kind, m.sender.address, m.body])).toEqual([['answer', PERSON, 'the release branch']])
    const posted = store.mail.messagesAfter(thread.id, 0).at(-1)!
    expect(posted.sender).toBe(PERSON)
    expect(store.mail.receiptsOf(posted.id).map((r) => r.recipient)).toEqual([S1])
    // The person said it: the session’s mailbox shows it as the person’s (§7.1)
    expect(mail.drain(S1).text).toContain('the release branch')
  })

  it('a reply to a thread that is done is refused with its reason', () => {
    const { mail, person } = setup()
    const { thread } = openBy(mail, { by: S1, kind: 'assign', subject: 's', body: 'b', assignee: S2 })
    person.close(thread.id, 'dropped')
    try {
      person.reply(thread.id, 'more')
      throw new Error('not refused')
    } catch (e) {
      expect(refusalReason(e)).toBe('thread_done')
    }
  })

  it('close ends it with an outcome, reassign gives it to another session, unblock resolves a blocker', () => {
    const { mail, person, store } = setup()
    const { thread } = openBy(mail, { by: S1, kind: 'assign', subject: 's', body: 'b', assignee: S2 })
    mail.addBlocker(thread.id, S1, { kind: 'text', text: 'waiting for a design' })
    expect(person.unblock(thread.id, 1)).toMatchObject({ id: thread.id, blocked: 0, state: 'open' })

    const s3 = sessionAddress(HOST, 's3')
    const moved = person.reassign(thread.id, 's3', 'please take this over')
    expect(store.mail.thread(thread.id)?.assignee).toBe(s3)
    expect(moved.messages.at(-1)).toMatchObject({ kind: 'assign', sender: { address: PERSON } })

    expect(person.close(thread.id, 'stopped')).toMatchObject({ state: 'done', outcome: 'stopped' })
  })

  it('release sends held mail now, dismiss lets it go; resume and the crowd’s answer go to the delivery', async () => {
    const { mail, person, store, calls } = setup()
    const { message } = openBy(mail, { by: S1, kind: 'assign', subject: 's', body: 'b', assignee: S2 })
    store.mail.setHeld(S2, [message.id], 'failed')
    expect(person.held('release', S2, [message.id])).toEqual({ changed: 1 })
    expect(store.mail.receiptsOf(message.id)[0]).toMatchObject({ held: null })
    store.mail.setHeld(S2, [message.id], 'failed')
    expect(person.held('dismiss', S2, [message.id])).toEqual({ changed: 1 })
    expect(store.mail.heldReceipts()).toEqual([])

    person.resume({ sessionId: 's2' })
    person.resume({ threadId: 't' })
    person.wake(true)
    person.wake(false)
    await Promise.resolve()
    expect(calls).toEqual(['session:s2', 'thread:t', 'crowd:true', 'crowd:false'])
  })
})

describe('the person gives work only to a session that can read it (§9.3)', () => {
  it('reassign meets the same receiver check as any post: a seat with no mail tool is refused with no_mailbox, and the thread stays as it was', () => {
    const store = new Store()
    const noTool = new Set(['s3'])
    const policy = mailRelations({
      session: () => ({ kind: 'worker' }),
      mailTool: (id) => !noTool.has(id),
      inThread: () => false,
    })
    const mail = new MailService(store.mail, { hostId: () => HOST, now: () => NOW, policy })
    const person = new MailPerson(mail, store.mail, { resumeSession: () => {}, resumeThread: () => {}, answerCrowd: async () => {}, crowdWaiting: () => 0 }, { session: () => undefined })
    const { thread } = openBy(mail, { by: PERSON, kind: 'assign', subject: 's', body: 'b', assignee: S2 })
    let reason: string | undefined
    try {
      person.reassign(thread.id, 's3', 'please take this over')
    } catch (e) {
      reason = refusalReason(e)
    }
    expect(reason).toBe('no_mailbox')
    expect(store.mail.thread(thread.id)?.assignee).toBe(S2)
    expect(person.reassign(thread.id, 's4', 'you, then').thread.assignee?.sessionId).toBe('s4')
  })
})

describe('waking the sleeping sessions', () => {
  it('is answered at once, not when the last session has been resumed', async () => {
    const store = new Store()
    const mail = new MailService(store.mail, { hostId: () => HOST, now: () => NOW })
    let release!: () => void
    const slow = new Promise<void>((r) => (release = r))
    const person = new MailPerson(mail, store.mail, { resumeSession: () => {}, resumeThread: () => {}, answerCrowd: () => slow, crowdWaiting: () => 12 }, { session: () => undefined })
    const rpc = createRpcHandler({} as SessionManager, new Map(), { mail: person })
    await expect(rpc('mail.wake', { wake: true })).resolves.toEqual({ ok: true })
    release()
  })
})

describe('through the RPC door', () => {
  const door = (mailPerson?: MailPerson) => createRpcHandler({} as SessionManager, new Map(), mailPerson ? { mail: mailPerson } : {})

  it('answers in the protocol’s shapes, and the person’s reply is theirs whatever the call says', async () => {
    const { mail, person } = setup()
    const rpc = door(person)
    const { thread } = openBy(mail, { by: S1, kind: 'question', subject: 'q', body: 'which?', members: [PERSON] })

    const list = RpcMethods['mail.list'].result.parse(await rpc('mail.list', {}))
    expect(list.threads.map((t) => t.id)).toEqual([thread.id])
    const view = MailThreadView.parse(await rpc('mail.thread', { threadId: thread.id }))
    expect(view.messages[0]!.body).toBe('which?')
    // A field the call adds to be someone else is not read: the sender is the person
    const replied = MailThreadView.parse(await rpc('mail.reply', { threadId: thread.id, text: 'the release', from: S2 }))
    expect(replied.messages[0]!.sender.address).toBe(PERSON)
    expect(await rpc('mail.resume', { threadId: thread.id })).toEqual({ ok: true })
  })

  it('asks for at most a page of the end of a thread', async () => {
    const { person } = setup()
    const rpc = door(person)
    await expect(rpc('mail.thread', { threadId: 't', tail: 101 })).rejects.toThrow()
    await expect(rpc('mail.thread', { threadId: 't', tail: 0 })).rejects.toThrow()
  })

  it('refuses a resume that names both or neither, a reply with no words, and a host with no mailbox', async () => {
    const { person } = setup()
    const rpc = door(person)
    await expect(rpc('mail.resume', { sessionId: 's', threadId: 't' })).rejects.toThrow()
    await expect(rpc('mail.resume', {})).rejects.toThrow()
    await expect(rpc('mail.reply', { threadId: 't', text: '' })).rejects.toThrow()
    await expect(door()('mail.list', {})).rejects.toThrow('The mailbox is unavailable on this host')
  })
})
