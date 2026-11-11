import type { MailHeldRow, MailMessage, MailParty, MailThreadRow, MailThreadView } from '@cc/protocol/client'
import type { MailPort } from '../ports/index.js'
import type { MockClock } from './clock.js'
import type { Emit } from './event-bus.js'
import { mockError } from './mock-error.js'

const PERSON: MailParty = { address: 'person', kind: 'person', sessionId: null, name: null, state: null }

/** A mock session as a mailbox party: `session:mock/<id>`, named by what the test gives */
export function mockSessionParty(sessionId: string, name: string, state = 'idle'): MailParty {
  return { address: `session:mock/${sessionId}`, kind: 'session', sessionId, name, state }
}

type Thread = {
  row: MailThreadRow
  messages: MailMessage[]
  /** The seq the person has read up to */
  read: number
  /** Whether the person has something here to answer (the host's `canReply`) */
  canReply: boolean
}

/**
 * The person's mailbox (#1347), in memory: a thread a test or the demo seeds, and the person's acts on it. It keeps the host's
 * rules that a screen shows (a thread that is done takes no reply; an unread count that falls when the thread is read) and none
 * of the delivery.
 */
export class MailMock {
  private readonly threads = new Map<string, Thread>()
  private heldRows: MailHeldRow[] = []
  /** Sleeping sessions waiting for the person's word (`mail.wake`); a test sets it */
  waiting = 0
  /** What the person pressed, for a test to read */
  readonly calls: string[] = []

  constructor(
    private readonly clock: MockClock,
    private readonly emit: Emit,
  ) {}

  /** Puts a thread in the mailbox with its first message, unread for the person */
  seed(spec: {
    subject: string
    from: MailParty
    body: string
    kind?: string
    /** The answers a question offers to pick from (#1630) */
    choices?: string[]
    state?: string
    assignee?: MailParty | null
    /** A turn of the thread is going in its assignee: closing tells that session and stops nothing (C12) */
    working?: boolean
    held?: { reason: string; recipient: MailParty }
    /** Mail between sessions that is only held for the person: nothing of theirs to answer, so the window offers no reply box */
    onlyHeld?: boolean
  }): string {
    const id = `mock.t_${this.clock.next()}`
    const now = this.clock.now()
    const message: MailMessage = { id: `mock.m_${this.clock.next()}`, seq: 1, sender: spec.from, kind: spec.kind ?? 'question', urgent: false, body: spec.body, facts: {}, ...(spec.choices ? { choices: spec.choices } : {}), createdAt: now }
    const row: MailThreadRow = {
      id,
      subject: spec.subject,
      state: spec.state ?? 'open',
      outcome: null,
      next: null,
      projectId: null,
      owner: spec.from,
      assignee: spec.assignee ?? null,
      unread: 1,
      held: 0,
      blocked: 0,
      ...(spec.working ? { working: true } : {}),
      createdAt: now,
      updatedAt: now,
      last: { sender: spec.from, kind: message.kind, preview: spec.body.slice(0, 140), at: now },
    }
    this.threads.set(id, { row, messages: [message], read: 0, canReply: !spec.onlyHeld })
    if (spec.held) {
      this.heldRows.push({ messageId: message.id, threadId: id, subject: spec.subject, sender: spec.from, recipient: spec.held.recipient, kind: message.kind, reason: spec.held.reason, preview: spec.body.slice(0, 140), since: now })
      row.held = 1
    }
    this.emit({ type: 'mail_changed', threadId: id, toPerson: true })
    return id
  }

  /** Another message from a session in a thread, as the host adds one: unread for the person */
  say(threadId: string, spec: { from: MailParty; body: string; kind?: string; choices?: string[] }): void {
    const t = this.must(threadId)
    const message: MailMessage = { id: `mock.m_${this.clock.next()}`, seq: t.messages.length + 1, sender: spec.from, kind: spec.kind ?? 'question', urgent: false, body: spec.body, facts: {}, ...(spec.choices ? { choices: spec.choices } : {}), createdAt: this.clock.now() }
    t.messages.push(message)
    t.row.unread += 1
    t.row.last = { sender: spec.from, kind: message.kind, preview: spec.body.slice(0, 140), at: message.createdAt }
    this.touch(t)
  }

  private must(threadId: string): Thread {
    const t = this.threads.get(threadId)
    if (!t) throw mockError(`Thread not found: ${threadId}`, 'refused')
    return t
  }

  private view(t: Thread, messages: MailMessage[], older = false): MailThreadView {
    return {
      thread: { ...t.row },
      parties: [
        { party: t.row.owner, role: 'owner' },
        ...(t.row.assignee ? [{ party: t.row.assignee, role: 'assignee' }] : []),
      ],
      blockers: [],
      messages: messages.map((m) => ({ ...m })),
      more: false,
      older,
      follows: [],
      canReply: t.canReply,
    }
  }

  private touch(t: Thread): void {
    t.row.updatedAt = this.clock.now()
    this.emit({ type: 'mail_changed', threadId: t.row.id, toPerson: false })
  }

  readonly mail: MailPort = {
    list: async () => ({
      threads: [...this.threads.values()]
        .map((t) => ({ ...t.row }))
        .sort((a, b) => Number(b.unread > 0) - Number(a.unread > 0) || b.updatedAt - a.updatedAt),
      held: this.heldRows.map((h) => ({ ...h })),
      waiting: this.waiting,
    }),
    thread: async (threadId, opts) => {
      const t = this.must(threadId)
      if (opts?.tail !== undefined) {
        // The end of the thread, or the page before `before`: read to the end when it is the end
        const pool = t.messages.filter((m) => opts.before === undefined || m.seq < opts.before)
        const page = pool.slice(-opts.tail)
        if (opts.before === undefined) {
          t.read = Math.max(t.read, page.at(-1)?.seq ?? 0)
          t.row.unread = 0
        }
        return this.view(t, page, pool.length > page.length)
      }
      const after = opts?.all ? 0 : (opts?.after ?? t.read)
      const messages = t.messages.filter((m) => m.seq > after)
      t.read = Math.max(t.read, messages.at(-1)?.seq ?? 0)
      t.row.unread = 0
      return this.view(t, messages)
    },
    reply: async (threadId, text, kind, answers) => {
      const t = this.must(threadId)
      if (t.row.state === 'done') throw mockError('this thread is done; open a follow-up', 'refused')
      // As the host does (`pickTarget`): a pick names its question, whose choices include the words, and a question is answered once
      const open = t.messages.findLast((m) => m.sender.kind !== 'person' && m.kind === 'question' && !t.messages.some((a) => a.replyTo === m.id))
      const question = answers === undefined ? open : t.messages.find((m) => m.id === answers)
      if (answers !== undefined && !question?.choices?.includes(text)) throw mockError(`${answers} does not offer that choice.`, 'refused')
      if (answers !== undefined && question && t.messages.some((m) => m.replyTo === question.id && m.sender.kind === 'person')) throw mockError(`${question.id} is answered already: a question is answered once. Write to say more.`, 'refused')
      const message: MailMessage = { id: `mock.m_${this.clock.next()}`, seq: t.messages.length + 1, sender: PERSON, kind: kind ?? 'note', urgent: false, body: text, facts: answers !== undefined ? { picked: true } : {}, ...(question ? { replyTo: question.id } : {}), createdAt: this.clock.now() }
      t.messages.push(message)
      t.read = message.seq
      t.row.last = { sender: PERSON, kind: message.kind, preview: text.slice(0, 140), at: message.createdAt }
      this.touch(t)
      return this.view(t, [message])
    },
    close: async (threadId, outcome) => {
      const t = this.must(threadId)
      // As the host does (C12): the session whose turn is on the thread is told in Centralu's words without a wake, and its turn goes on
      const helper = t.row.working ? t.row.assignee?.sessionId : null
      if (helper) this.emit({ type: 'notice', sessionId: helper, level: 'info', from: 'Centralu', label: 'mail', text: '✉ Centralu told it the person closed its work' })
      t.row.state = 'done'
      t.row.outcome = outcome ?? 'finished'
      t.row.working = false
      this.touch(t)
      return { ...t.row }
    },
    held: async (action, recipient, messageIds) => {
      this.calls.push(`${action}:${recipient}:${messageIds.join(',')}`)
      const gone = this.heldRows.filter((h) => h.recipient.address === recipient && messageIds.includes(h.messageId))
      this.heldRows = this.heldRows.filter((h) => !gone.includes(h))
      for (const h of gone) {
        const t = this.threads.get(h.threadId)
        if (t) {
          t.row.held = Math.max(0, t.row.held - 1)
          this.touch(t)
        }
      }
      return { changed: gone.length }
    },
    resume: async (target) => {
      this.calls.push('sessionId' in target ? `resume:session:${target.sessionId}` : `resume:thread:${target.threadId}`)
      // A pause lifted sends what it held: a thread's turns (`loop`), or a session's budget (`budget`)
      const freed = this.heldRows.filter((h) => ('sessionId' in target ? h.reason === 'budget' && h.recipient.sessionId === target.sessionId : h.reason === 'loop' && h.threadId === target.threadId))
      this.heldRows = this.heldRows.filter((h) => !freed.includes(h))
      for (const h of freed) {
        const t = this.threads.get(h.threadId)
        if (t) {
          t.row.held = Math.max(0, t.row.held - 1)
          this.touch(t)
        }
      }
    },
    wake: async (wake) => {
      this.calls.push(`wake:${wake}`)
      this.waiting = 0
    },
  }
}
