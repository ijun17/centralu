import type { MailHeldRow, MailMessage, MailParty, MailThreadRow, MailThreadView } from '@cc/protocol'
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
  blockers: MailThreadView['blockers']
  /** The seq the person has read up to */
  read: number
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
    state?: string
    assignee?: MailParty | null
    /** A turn of the thread is going in its assignee: Drop and Mark done ask first (3.10) */
    working?: boolean
    held?: { reason: string; recipient: MailParty }
  }): string {
    const id = `mock.t_${this.clock.next()}`
    const now = this.clock.now()
    const message: MailMessage = { id: `mock.m_${this.clock.next()}`, seq: 1, sender: spec.from, kind: spec.kind ?? 'question', urgent: false, body: spec.body, facts: {}, createdAt: now }
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
    this.threads.set(id, { row, messages: [message], blockers: [], read: 0 })
    if (spec.held) {
      this.heldRows.push({ messageId: message.id, threadId: id, subject: spec.subject, sender: spec.from, recipient: spec.held.recipient, kind: message.kind, reason: spec.held.reason, preview: spec.body.slice(0, 140), since: now })
      row.held = 1
    }
    this.emit({ type: 'mail_changed', threadId: id, toPerson: true })
    return id
  }

  /** Adds a blocker a test wants the screen to show */
  block(threadId: string, text: string): void {
    const t = this.must(threadId)
    t.blockers.push({ n: t.blockers.length + 1, kind: 'text', ref: null, text, resolved: false })
    t.row.blocked = t.blockers.filter((b) => !b.resolved).length
    t.row.state = 'blocked'
    this.emit({ type: 'mail_changed', threadId, toPerson: false })
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
      blockers: t.blockers.map((b) => ({ ...b })),
      messages: messages.map((m) => ({ ...m })),
      more: false,
      older,
      follows: [],
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
    reply: async (threadId, text, kind) => {
      const t = this.must(threadId)
      if (t.row.state === 'done') throw mockError('this thread is done; open a follow-up', 'refused')
      const message: MailMessage = { id: `mock.m_${this.clock.next()}`, seq: t.messages.length + 1, sender: PERSON, kind: kind ?? 'note', urgent: false, body: text, facts: {}, createdAt: this.clock.now() }
      t.messages.push(message)
      t.read = message.seq
      t.row.last = { sender: PERSON, kind: message.kind, preview: text.slice(0, 140), at: message.createdAt }
      this.touch(t)
      return this.view(t, [message])
    },
    close: async (threadId, outcome) => {
      const t = this.must(threadId)
      t.row.state = 'done'
      t.row.outcome = outcome ?? 'finished'
      this.touch(t)
      return { ...t.row }
    },
    reassign: async (threadId, sessionId, text) => {
      const t = this.must(threadId)
      t.row.assignee = mockSessionParty(sessionId, sessionId)
      const message: MailMessage = { id: `mock.m_${this.clock.next()}`, seq: t.messages.length + 1, sender: PERSON, kind: 'assign', urgent: false, body: text, facts: {}, createdAt: this.clock.now() }
      t.messages.push(message)
      t.read = message.seq
      this.touch(t)
      return this.view(t, [message])
    },
    unblock: async (threadId, n) => {
      const t = this.must(threadId)
      const b = t.blockers.find((x) => x.n === n && !x.resolved)
      if (!b) throw mockError(`thread ${threadId} has no standing blocker ${n}`, 'refused')
      b.resolved = true
      t.row.blocked = t.blockers.filter((x) => !x.resolved).length
      if (t.row.blocked === 0) t.row.state = 'open'
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
