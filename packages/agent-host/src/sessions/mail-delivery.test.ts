/**
 * The mailbox's delivery into real sessions (#1347, docs/plans/mailbox.md §5, §7.1, §9.2): a session at rest is woken with the
 * frame stamped as Centralu's channel and a compact line in its conversation, never a user message; one in a turn or asleep
 * keeps its mail until it can take it; and a session that is gone is not woken.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import type { NormalizedEvent, SessionInfo } from '@cc/protocol'
import type { InputObserver } from '../adapters/contract.js'
import { MailDelivery } from '../mail/delivery.js'
import { MailService } from '../mail/service.js'
import { openBy } from '../mail/mail.test-helpers.js'
import { MAIL_ACCEPT_MS } from './session-events.js'
import { FakeHandle, managerWorld } from './manager.test-helpers.js'

let w: ReturnType<typeof managerWorld>
let mail: MailService
let delivery: MailDelivery
let clock = { t: 1_800_000_000_000 }

beforeEach(() => {
  w = managerWorld()
  clock = { t: 1_800_000_000_000 }
  mail = new MailService(w.store.mail, { hostId: () => 'hub-aaaaaaaa', now: () => clock.t })
  // The timers are not used: a test looks at a mailbox when it says so
  delivery = new MailDelivery(mail, w.store.mail, w.mgr.mailSessions(), { now: () => clock.t, schedule: () => () => {} })
  w.mgr.useMail({ sessionGone: (id) => void mail.sessionGone(id), sessionChanged: (id) => delivery.poke(id) })
  delivery.start()
})
afterEach(() => delivery.stop())

const create = async () => {
  const project = (await w.rpc('projects.add', { path: tmpdir() })) as { id: string }
  return (await w.rpc('agents.createSession', { projectId: project.id, cwd: tmpdir(), tool: 'claude' })) as SessionInfo
}
const handleOf = (id: string): FakeHandle => {
  const h = w.adapter.handleOf(id)
  if (!h) throw new Error(`no process for ${id}`)
  return h
}
const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve()
  await new Promise<void>((r) => setImmediate(r))
}
/** Moves the clock past the 2 s debounce and looks at the mailbox, as its timer would */
const due = async (sessionId: string) => {
  clock.t += 3_000
  await delivery.process(mail.sessionAddress(sessionId))
  await settle()
}
const stored = (sessionId: string) => w.store.messages.loadMessages(sessionId, 200)
const mailLines = (sessionId: string) => stored(sessionId).filter((m) => m.kind === 'marker' && (m.payload as { label?: string }).label === 'mail')

describe('a session at rest is woken by mail', () => {
  it('with the frame as the CLI’s input stamped as the channel of Centralu, a line in the conversation, and no message of the person’s', async () => {
    const giver = await create()
    const worker = await create()
    const { thread } = openBy(mail, { by: mail.sessionAddress(giver.id), kind: 'assign', subject: 'Land #12', body: 'please land it', assignee: mail.sessionAddress(worker.id) })
    const userRowsBefore = stored(worker.id).filter((m) => m.role === 'user').length
    await due(worker.id)

    const h = handleOf(worker.id)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]).toContain('[SYSTEM NOTIFICATION - NOT USER INPUT]')
    expect(h.sent[0]).toContain(`thread="${thread.id}"`)
    expect(h.sent[0]).toContain('> please land it')
    expect(h.origins[0]).toEqual({ kind: 'channel', server: 'centralu' })
    // The conversation keeps a compact line from Centralu's record, and no user row: nothing reads as the person
    expect(stored(worker.id).filter((m) => m.role === 'user')).toHaveLength(userRowsBefore)
    expect(mailLines(worker.id)).toHaveLength(1)
    expect(mailLines(worker.id)[0]!.payload).toMatchObject({ type: 'notice', level: 'info', from: 'Centralu', label: 'mail', text: '✉ 1 message in 1 thread, from the session that gave you this work' })
    expect(w.events.some((e: NormalizedEvent) => e.type === 'user_message' && e.sessionId === worker.id)).toBe(false)
    const first = w.store.mail.messagesAfter(thread.id, 0)[0]!
    expect(w.store.mail.receiptsOf(first.id)[0]!.deliveredAt).not.toBeNull()
  })

  // The fake tool gives every session the same conversation id, so a test that wakes a session uses one session and the person to give it work

  it('a session asleep is resumed to take it', async () => {
    // A tool whose sessions can sleep (as app-notice.test.ts puts one to sleep)
    Object.assign(w.adapter.capabilities, { backgroundTasks: true })
    const worker = await create()
    expect(await w.mgr.sleepSession(worker.id)).toBe(true)
    expect(w.mgr.mailSessions().receiver(worker.id)).toEqual({ kind: 'ready', live: false, quiet: false })
    openBy(mail, { by: 'person', kind: 'assign', subject: 's', body: 'wake up', assignee: mail.sessionAddress(worker.id) })
    await due(worker.id)
    expect(handleOf(worker.id).sent.some((t) => t.includes('> wake up'))).toBe(true)
  })

  it('mail for a session in a turn waits for the turn’s end, which pokes it', async () => {
    const worker = await create()
    handleOf(worker.id).send('working')
    expect(w.mgr.sessionInfo(worker.id)?.state).toBe('working')
    openBy(mail, { by: 'person', kind: 'assign', subject: 's', body: 'after this turn', assignee: mail.sessionAddress(worker.id) })
    await due(worker.id)
    expect(handleOf(worker.id).sent).toEqual(['working'])

    handleOf(worker.id).finishTurn()
    await settle()
    expect(handleOf(worker.id).sent.some((t) => t.includes('> after this turn'))).toBe(true)
  })

  it('mail for a session with a card standing waits: it is never taken as the answer, and goes once the card is answered', async () => {
    const worker = await create()
    handleOf(worker.id).emitApproval('req-1')
    expect(w.mgr.sessionInfo(worker.id)?.state).toBe('waiting_approval')
    openBy(mail, { by: 'person', kind: 'assign', subject: 's', body: 'after the card', assignee: mail.sessionAddress(worker.id) })
    await due(worker.id)
    expect(handleOf(worker.id).sent).toEqual([])
    // The card is answered by the person's decision, and only then does the session take the mail
    handleOf(worker.id).respondApproval('req-1', 'deny')
    await settle()
    expect(handleOf(worker.id).sent.filter((t) => t.includes('> after the card'))).toHaveLength(1)
  })
})

describe('a session restored from the trash', () => {
  it('takes the mail that waited for it, and the work it held is not given back', async () => {
    const worker = await create()
    const { thread } = openBy(mail, { by: 'person', kind: 'assign', subject: 's', body: 'while you were away', assignee: mail.sessionAddress(worker.id) })
    await w.rpc('agents.deleteSession', { sessionId: worker.id })
    expect(w.store.mail.thread(thread.id)).toMatchObject({ assignee: null, state: 'open' })
    clock.t += 3_000
    await w.rpc('trash.restore', { sessionId: worker.id })
    await settle()
    expect(handleOf(worker.id).sent.some((t) => t.includes('> while you were away'))).toBe(true)
    expect(w.store.mail.thread(thread.id)?.assignee).toBeNull()
  })
})

describe('what a session is to the delivery', () => {
  it('working is a turn, a standing card a card, a turn’s end is ready for its next message, gone is gone, idle is ready with whether it is live and takes quiet input', async () => {
    const s = await create()
    const port = w.mgr.mailSessions()
    expect(port.receiver(s.id)).toEqual({ kind: 'ready', live: true, quiet: false })
    ;(w.adapter as { quietInput?: boolean }).quietInput = true
    expect(port.receiver(s.id)).toEqual({ kind: 'ready', live: true, quiet: true })
    handleOf(s.id).send('go')
    expect(port.receiver(s.id)).toEqual({ kind: 'busy', why: 'turn' })
    handleOf(s.id).emitApproval('r')
    expect(port.receiver(s.id)).toEqual({ kind: 'busy', why: 'card' })
    handleOf(s.id).respondApproval('r', 'deny')
    handleOf(s.id).finishTurn()
    // "Awaiting input": the turn is over
    expect(w.mgr.sessionInfo(s.id)?.state).toBe('waiting_input')
    expect(port.receiver(s.id)).toEqual({ kind: 'ready', live: true, quiet: true })
    expect(port.receiver('no-such-session')).toEqual({ kind: 'gone' })
  })

  it('a host that is leaving delivers nothing more, also to a session it was in the middle of waking', async () => {
    const worker = await create()
    const h = handleOf(worker.id)
    const before = h.sent.length
    await w.mgr.detachAll()
    const input = { text: 'mail', quiet: false, line: '✉ 1 message' }
    await expect(w.mgr.mailSessions().deliver(worker.id, input)).rejects.toThrow()
    await expect(w.mgr.mailSessions().deliver(worker.id, { ...input, quiet: true })).rejects.toThrow()
    expect(h.sent.length).toBe(before)
    // And it says it is not at rest, so the delivery does not even try
    expect(w.mgr.mailSessions().receiver(worker.id)).toEqual({ kind: 'busy', why: 'turn' })
  })

  it('a failure the tool tells after the wait for it ran out reaches the delivery, through the manager’s port', async () => {
    const worker = await create()
    let observer!: InputObserver
    Object.assign(handleOf(worker.id), {
      sendTracked: (_text: string, o: InputObserver) => {
        observer = o
        return new Promise<void>(() => {})
      },
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const late = vi.fn()
      const delivered = w.mgr.mailSessions().deliver(worker.id, { text: 'mail', quiet: false, line: '✉ 1 message' }, late)
      await vi.advanceTimersByTimeAsync(MAIL_ACCEPT_MS + 1_000)
      await delivered
      observer.fail(new Error('the session closed with it queued'))
      expect(late).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a session in the trash is not woken, and its mail stays', async () => {
    const giver = await create()
    const worker = await create()
    openBy(mail, { by: mail.sessionAddress(giver.id), kind: 'assign', subject: 's', body: 'x', assignee: mail.sessionAddress(worker.id) })
    await w.rpc('agents.deleteSession', { sessionId: worker.id })
    await due(worker.id)
    expect(w.mgr.mailSessions().receiver(worker.id)).toEqual({ kind: 'gone' })
    expect(w.store.mail.recipientsWithMail()).toContain(mail.sessionAddress(worker.id))
  })
})
