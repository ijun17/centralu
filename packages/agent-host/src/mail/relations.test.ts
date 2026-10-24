import { describe, expect, it } from 'vitest'
import { Store } from '../dev-services/store.js'
import { CENTRALU, PERSON, appAddress, sessionAddress } from './address.js'
import { mailRelations, type RelationsHost } from './relations.js'
import { refusalReason } from './rules.js'
import { MailService } from './service.js'
import { openBy } from './mail.test-helpers.js'

const HOST = 'hub-aaaaaaaa'
const a = (id: string) => sessionAddress(HOST, id)
const ORCH = a('orch')
const COORD = a('coord')
const PARENT = a('parent')
const CHILD = a('child')
const OTHER = a('other')
const MEMBER = a('member')
const APP = appAddress(HOST, 'p1', 'board')

/** A parent and its child, the orchestrator, a coordinator with one member, and a stranger; `gone` is not here */
const sessions: Record<string, { kind: 'worker' | 'orchestrator' | 'coordinator'; askedBy?: string | null; scopeSessionIds?: string[] | null }> = {
  orch: { kind: 'orchestrator' },
  coord: { kind: 'coordinator', scopeSessionIds: ['member'] },
  parent: { kind: 'worker' },
  child: { kind: 'worker', askedBy: 'parent' },
  other: { kind: 'worker' },
  member: { kind: 'worker' },
}

function policy(extra: Partial<RelationsHost> = {}, inThread: (t: string, who: string) => boolean = () => false) {
  return mailRelations({ session: (id) => sessions[id], mailTool: () => true, inThread, ...extra })
}
const may = (from: string, to: string, p = policy()) => p.mayWrite(from, to, null)

describe('who may write to whom (§9.1)', () => {
  it('a session writes to the sessions it started and to the person; to the one that started it only in a thread they share', () => {
    expect(may(PARENT, CHILD)).toBeNull()
    expect(may(CHILD, PARENT)).toMatch(/orchestrator is the way/)
    expect(policy({}, (_t, who) => who === PARENT).mayWrite(CHILD, PARENT, { id: 't1' } as never)).toBeNull()
    expect(may(CHILD, PERSON)).toBeNull()
    expect(may(OTHER, PERSON)).toBeNull()
  })

  it('and to nobody else but the orchestrator, which any session may ask, a new thread too (§9.7, #1447): a stranger, a child, a coordinator', () => {
    expect(may(OTHER, CHILD)).toMatch(/orchestrator is the way/)
    expect(may(CHILD, OTHER)).toMatch(/orchestrator is the way/)
    expect(may(CHILD, a('child2'))).toMatch(/gone/)
    expect(may(OTHER, ORCH)).toBeNull()
    expect(may(CHILD, ORCH)).toBeNull()
    expect(may(COORD, ORCH)).toBeNull()
    expect(policy().isOrchestrator?.(ORCH)).toBe(true)
    expect(policy().isOrchestrator?.(OTHER)).toBe(false)
    expect(policy().isOrchestrator?.(a('gone'))).toBe(false)
  })

  it('the orchestrator writes to any session, and a coordinator to the members of its scope only', () => {
    expect(may(ORCH, OTHER)).toBeNull()
    expect(may(COORD, MEMBER)).toBeNull()
    expect(may(COORD, OTHER)).not.toBeNull()
  })

  it('the person and Centralu write to any session that is here, and to none that is gone', () => {
    expect(may(PERSON, OTHER)).toBeNull()
    expect(may(CENTRALU, OTHER)).toBeNull()
    expect(may(PERSON, a('gone'))).toMatch(/session archive or deleted/)
    expect(may(CENTRALU, a('gone'))).toMatch(/gone/)
    expect(may(PERSON, CENTRALU)).toMatch(/only sends/)
  })

  it('a reply needs no relation: anyone in the thread writes to anyone in it who is here', () => {
    const p = policy({}, (_t, who) => who === OTHER || who === a('gone'))
    expect(p.mayWrite(CHILD, OTHER, { id: 't1' } as never)).toBeNull()
    // But not to a session that has gone since, and not to a party that is not in the thread
    expect(p.mayWrite(CHILD, a('gone'), { id: 't1' } as never)).toMatch(/gone/)
    expect(p.mayWrite(CHILD, PARENT, { id: 't1' } as never)).not.toBeNull()
  })

  it('an app writes to a session that called it, and to no other; no one writes to an app yet', () => {
    const p = policy({ appCalledBy: (app, session) => app === APP && session === 'parent' })
    expect(may(APP, PARENT, p)).toBeNull()
    expect(may(APP, a('other'), p)).toMatch(/called it/)
    expect(may(APP, ORCH, p)).toMatch(/called it/)
    expect(may(APP, PERSON, p)).toMatch(/inside a thread/)
    expect(may(PARENT, APP, p)).toMatch(/no mail yet/)
    expect(may(PERSON, APP, p)).toMatch(/no mail yet/)
    // With nothing recording who called an app, as before the apps' API: nobody did
    expect(may(APP, PARENT)).toMatch(/called it/)
  })
})

describe('a child does not give its parent work (§9.1)', () => {
  function setup() {
    const store = new Store()
    const rel = mailRelations({
      session: (id) => sessions[id],
      mailTool: () => true,
      inThread: (t, who) => store.mail.participants(t).some((x) => x.address === who && x.leftAt === null),
    })
    return { mail: new MailService(store.mail, { hostId: () => HOST, policy: rel }), store }
  }
  const reason = (fn: () => unknown) => {
    try {
      fn()
    } catch (e) {
      return refusalReason(e)
    }
    return 'NOT REFUSED'
  }

  it('a new thread from the child to its parent is refused, assign or question alike; its reply in the parent’s thread is not', () => {
    const { mail } = setup()
    expect(reason(() => openBy(mail, { by: CHILD, kind: 'assign', subject: 's', body: 'do this', assignee: PARENT }))).toBe('policy')
    expect(reason(() => openBy(mail, { by: CHILD, kind: 'question', subject: 's', body: 'which?', members: [PARENT] }))).toBe('policy')
    const { thread } = openBy(mail, { by: PARENT, kind: 'assign', subject: 'work', body: 'go', assignee: CHILD })
    expect(mail.post(thread.id, CHILD, { kind: 'question', body: 'which one?' }).duplicate).toBe(false)
  })
})

describe('a participant that cannot take mail does not block the others (§9.1)', () => {
  const present = new Set(['parent', 'child', 'member', 'other', 'orch'])
  const noTool = new Set<string>()
  function setup() {
    const store = new Store()
    const rel = mailRelations({
      session: (id) => (present.has(id) ? sessions[id] : undefined),
      mailTool: (id) => !noTool.has(id),
      inThread: (t, who) => store.mail.participants(t).some((x) => x.address === who && x.leftAt === null),
    })
    return { mail: new MailService(store.mail, { hostId: () => HOST, policy: rel }), store }
  }

  it('a member gone to the session archive, or left without a mail tool, gets no receipt; the assignee still hears the owner, the person and the close', () => {
    present.add('member')
    present.add('orch')
    noTool.clear()
    const { mail, store } = setup()
    const { thread } = openBy(mail, { by: ORCH, kind: 'assign', subject: 'work', body: 'go', assignee: CHILD, members: [MEMBER, OTHER, PARENT] })
    present.delete('member')
    noTool.add('other')
    const note = mail.post(thread.id, ORCH, { kind: 'note', body: 'still on?' })
    expect(store.mail.receiptsOf(note.message.id).map((r) => r.recipient).sort()).toEqual([CHILD, PARENT].sort())
    const word = mail.post(thread.id, PERSON, { kind: 'note', body: 'please go on' })
    expect(store.mail.receiptsOf(word.message.id).map((r) => r.recipient).sort()).toEqual([CHILD, ORCH, PARENT].sort())
    expect(mail.update(thread.id, CHILD, { state: 'done' }).state).toBe('done')
  })

  it('is refused, saying why, only when nobody is left to take it', () => {
    present.add('member')
    present.add('orch')
    noTool.clear()
    const { mail } = setup()
    const { thread } = openBy(mail, { by: ORCH, kind: 'question', subject: 'q', body: 'which?', members: [MEMBER] })
    present.delete('member')
    let reason: string | undefined
    try {
      mail.post(thread.id, ORCH, { kind: 'note', body: 'anyone?' })
    } catch (e) {
      reason = refusalReason(e)
    }
    expect(reason).toBe('policy')
    present.add('member')
  })
})

describe('the call a wake names is the one the receiver can make (§9.3, #850)', () => {
  it('is centralu_run for a seat that runs mail as a command, the tool for the rest', () => {
    const p = policy({ mailCommand: (id) => id === 'orch' })
    expect(p.calls?.(ORCH)?.('read', 't1')).toBe('centralu_run(command="mail", args={action: "read", thread: "t1"})')
    for (const to of [OTHER, PERSON, APP, a('gone')]) expect(p.calls?.(to)?.('read', 't1'), to).toBe('mail(action="read", thread="t1")')
  })

  it('reaches the orchestrator’s wake: the person’s word to it is framed with centralu_run', () => {
    const store = new Store()
    const mail = new MailService(store.mail, {
      hostId: () => HOST,
      policy: mailRelations({ session: (id) => sessions[id], mailTool: (id) => id !== 'coord', mailCommand: (id) => id === 'orch', inThread: () => false }),
    })
    openBy(mail, { by: PERSON, kind: 'assign', subject: 's', body: 'tell me when it lands', assignee: ORCH })
    const toOrchestrator = mail.drain(ORCH, {}).text
    expect(toOrchestrator).toContain('centralu_run(command="mail"')
    expect(toOrchestrator).not.toContain('mail(action=')
    openBy(mail, { by: PERSON, kind: 'assign', subject: 's', body: 'and you', assignee: OTHER })
    expect(mail.drain(OTHER, {}).text).toContain('Read it with mail(action=')
  })
})

describe('mail only reaches a session that can read it (§9.3)', () => {
  const noTool = new Set(['orch', 'coord', 'member'])
  const p = () => policy({ mailTool: (id) => !noTool.has(id) })

  it('a seat with no mail tool cannot be written to, by anyone: the person, Centralu, its own parent, the orchestrator', () => {
    for (const from of [PERSON, CENTRALU, PARENT, ORCH]) expect(p().cannotRead?.(MEMBER), from).toMatch(/cannot read mail/)
    expect(p().cannotRead?.(ORCH)).toMatch(/cannot read mail/)
    expect(p().cannotRead?.(COORD)).toMatch(/cannot read mail/)
    expect(p().cannotRead?.(OTHER)).toBeNull()
    // A person, an app and a session that is gone are not this rule's: they have their own
    expect(p().cannotRead?.(PERSON)).toBeNull()
    expect(p().cannotRead?.(APP)).toBeNull()
    expect(p().cannotRead?.(a('gone'))).toBeNull()
  })

  it('the service refuses it with the reason no_mailbox, in a new thread, a reply, an assign to another session, and a member added', () => {
    const store = new Store()
    const rel = mailRelations({
      session: (id) => sessions[id],
      mailTool: (id) => !noTool.has(id),
      inThread: (t, who) => store.mail.participants(t).some((x) => x.address === who && x.leftAt === null),
    })
    const mail = new MailService(store.mail, { hostId: () => HOST, policy: rel })
    const refusedAs = (fn: () => unknown) => {
      try {
        fn()
      } catch (e) {
        return refusalReason(e)
      }
      return 'NOT REFUSED'
    }
    expect(refusedAs(() => openBy(mail, { by: PERSON, kind: 'assign', subject: 's', body: 'b', assignee: MEMBER }))).toBe('no_mailbox')
    expect(refusedAs(() => openBy(mail, { by: ORCH, kind: 'assign', subject: 's', body: 'b', assignee: MEMBER }))).toBe('no_mailbox')
    const { thread } = openBy(mail, { by: PERSON, kind: 'assign', subject: 's', body: 'b', assignee: OTHER })
    expect(refusedAs(() => mail.assign(thread.id, PERSON, { assignee: MEMBER, body: 'you now' }))).toBe('no_mailbox')
    expect(refusedAs(() => mail.addMember(thread.id, PERSON, ORCH))).toBe('no_mailbox')
    // A session that can read it still can
    expect(mail.assign(thread.id, PERSON, { assignee: CHILD, body: 'you now' }).thread.assignee).toBe(CHILD)
  })

  it('mail already waiting for a session that lost the tool is not handed over', () => {
    const store = new Store()
    let tool = true
    const rel = mailRelations({ session: (id) => sessions[id], mailTool: () => tool, inThread: () => false })
    const mail = new MailService(store.mail, { hostId: () => HOST, policy: rel })
    openBy(mail, { by: PERSON, kind: 'assign', subject: 's', body: 'b', assignee: OTHER })
    tool = false
    expect(mail.drain(OTHER).messageIds).toEqual([])
    tool = true
    expect(mail.drain(OTHER).messageIds).toHaveLength(1)
  })
})

describe('the policy in the service: an app assignee cannot name an arbitrary owner (§9.1, M1)', () => {
  function setup(called: (app: string, session: string) => boolean) {
    const store = new Store()
    const rel = mailRelations({
      session: (id) => sessions[id],
      appCalledBy: called,
      mailTool: () => true,
      inThread: (t, who) => store.mail.participants(t).some((p) => p.address === who && p.leftAt === null),
    })
    const mail = new MailService(store.mail, { hostId: () => HOST, policy: rel })
    return { mail, store }
  }

  it('an app taking work opens a thread for the session that called it, and for no other', () => {
    const { mail, store } = setup((_app, session) => session === 'parent')
    const open = (owner: string) => openBy(mail, { by: APP, kind: 'notice', subject: 'Land #12', body: 'queued', owner, assignee: APP, state: 'running' })
    expect(open(PARENT).thread).toMatchObject({ owner: PARENT, assignee: APP })
    let reason: string | undefined
    try {
      open(OTHER)
    } catch (e) {
      reason = refusalReason(e)
    }
    expect(reason).toBe('policy')
    expect(store.mail.threadsOfParty(OTHER, 'owner')).toEqual([])
  })

  it('a session’s assign to a session it did not start is refused, and one to its child is not', () => {
    const { mail } = setup(() => false)
    expect(() => openBy(mail, { by: OTHER, kind: 'assign', subject: 's', body: 'b', assignee: CHILD })).toThrow(/orchestrator is the way/)
    expect(openBy(mail, { by: PARENT, kind: 'assign', subject: 's', body: 'b', assignee: CHILD }).thread.assignee).toBe(CHILD)
  })
})
