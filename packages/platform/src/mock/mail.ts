import { mailAsk, type MailHeldRow, type MailMessage, type MailParty, type MailTaskRow, type MailThreadRow, type MailThreadView, type UnreachedMachine, type WatchView } from '@cc/protocol/client'
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
  /** Sessions' mail the person is not in: opened from Tasks, never listed (`MailThreadView.lookIn`) */
  lookIn?: boolean
}

/**
 * The person's mailbox (#1347), in memory. It keeps the host's rules a screen shows (a done thread takes no reply,
 * reading lowers the unread count) and none of the delivery.
 */
export class MailMock {
  private readonly threads = new Map<string, Thread>()
  private heldRows: MailHeldRow[] = []
  /** Sleeping sessions waiting for the person's word (`mail.wake`); a test sets it */
  waiting = 0
  readonly calls: string[] = []
  /** By session id (#1324) */
  private readonly watchRows = new Map<string, WatchView[]>()
  /** False stands in for an older host: both watch methods are unknown to it */
  knowsWatches = true
  /** As `mail.tasks` lists it (#1577) */
  private taskRows: MailTaskRow[] = []
  /** How many a host with more open work listed (#1577) */
  tasksCapped: number | null = null
  /** The linked machines whose tasks a hub could not read (#2268) */
  tasksUnreached: UnreachedMachine[] = []
  /** False stands in for a host older than Tasks: `mail.tasks` is unknown to it */
  knowsTasks = true

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
      ask: null,
      unread: 1,
      held: 0,
      blocked: 0,
      ...(spec.working ? { working: true } : {}),
      createdAt: now,
      updatedAt: now,
      last: { sender: spec.from, kind: message.kind, preview: spec.body.slice(0, 140), at: now },
    }
    const thread: Thread = { row, messages: [message], read: 0, canReply: !spec.onlyHeld }
    row.ask = this.asking(thread)
    this.threads.set(id, thread)
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

  /**
   * Puts work on the host's task list with the chain it opens: the person's own when they gave it or are asked,
   * else one between sessions they look into. `state` and `outcome` are the host's words (`MailTaskRow`)
   */
  seedTask(spec: { subject: string; owner: MailParty; assignee: MailParty; body?: string; kind?: 'assign' | 'question'; state?: string; outcome?: string; held?: string }): string {
    const kind = spec.kind ?? 'assign'
    const asksPerson = spec.assignee.kind === 'person'
    const held = spec.held === undefined ? {} : { held: { reason: spec.held, recipient: spec.assignee } }
    const root = this.seed({ subject: spec.subject, from: spec.owner, body: spec.body ?? spec.subject, kind, assignee: spec.assignee, onlyHeld: !asksPerson, ...held })
    const t = this.must(root)
    // Held for the person, it is theirs to act on: no look in
    if (spec.owner.kind !== 'person' && !asksPerson && spec.held === undefined) {
      t.lookIn = true
      t.row.unread = 0
      t.row.ask = null
    }
    const now = this.clock.now()
    this.taskRows.push({ id: t.messages[0]?.id ?? root, root, subject: spec.subject, kind, owner: spec.owner, assignee: spec.assignee, state: spec.state ?? (spec.held === undefined ? 'open' : 'held'), outcome: spec.outcome ?? null, createdAt: now, updatedAt: now })
    this.emit({ type: 'mail_changed', threadId: root, toPerson: false })
    return root
  }

  /** Puts a watch on a session, as its `mail` tool would: the header lists it */
  seedWatch(sessionId: string, spec: Omit<WatchView, 'id' | 'createdAt'>): string {
    const id = `mock.w_${this.clock.next()}`
    this.watchRows.set(sessionId, [...(this.watchRows.get(sessionId) ?? []), { ...spec, id, createdAt: this.clock.now() }])
    this.emit({ type: 'watches_changed', sessionId })
    return id
  }

  private olderHost(method: string): void {
    if (!this.knowsWatches) throw mockError(`Unknown method: ${method}. This Centralu host does not have it; the window may be from another build.`)
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
      canReply: t.canReply && !t.lookIn,
      lookIn: t.lookIn === true,
    }
  }

  /** As `MailPerson.asking`: a session's questions no message of the person's names, until the thread is done */
  private asking(t: Thread): MailThreadRow['ask'] {
    const open = t.row.state === 'done' ? [] : t.messages.filter((m) => m.kind === 'question' && m.sender.kind === 'session' && !t.messages.some((a) => a.sender.kind === 'person' && a.replyTo === m.id))
    const newest = open.at(-1)
    return newest ? mailAsk(newest, newest.sender, open.map((m) => m.id)) : null
  }

  private touch(t: Thread): void {
    t.row.ask = this.asking(t)
    t.row.updatedAt = this.clock.now()
    this.emit({ type: 'mail_changed', threadId: t.row.id, toPerson: false })
  }

  readonly mail: MailPort = {
    list: async () => ({
      threads: [...this.threads.values()]
        .filter((t) => !t.lookIn)
        .map((t) => ({ ...t.row }))
        .sort((a, b) => Number(b.unread > 0) - Number(a.unread > 0) || b.updatedAt - a.updatedAt),
      held: this.heldRows.map((h) => ({ ...h })),
      waiting: this.waiting,
    }),
    tasks: async () => {
      if (!this.knowsTasks) throw mockError('Unknown method: mail.tasks. This Centralu host does not have it; the window may be from another build.')
      return { tasks: this.taskRows.map((t) => ({ ...t })), capped: this.tasksCapped, unreached: this.tasksUnreached.map((m) => ({ ...m })) }
    },
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
      // A look in reads nothing for anyone, as the host's does (a mail line folded open in a conversation, #2333)
      if (opts?.lookIn === true) return { ...this.view(t, messages), lookIn: true }
      t.read = Math.max(t.read, messages.at(-1)?.seq ?? 0)
      t.row.unread = 0
      return this.view(t, messages)
    },
    reply: async (threadId, text, kind, answers) => {
      const t = this.must(threadId)
      if (t.row.state === 'done') throw mockError('this thread is done; open a follow-up', 'refused')
      // As `pickTarget`: an answer names its question (a pick is one of its choices), answered once
      const open = t.messages.findLast((m) => m.sender.kind !== 'person' && m.kind === 'question' && !t.messages.some((a) => a.replyTo === m.id))
      const question = answers === undefined ? open : t.messages.find((m) => m.id === answers)
      if (answers !== undefined && !question) throw mockError(`There is no message ${answers} to answer.`, 'refused')
      if (answers !== undefined && question && t.messages.some((m) => m.replyTo === question.id && m.sender.kind === 'person')) throw mockError(`${question.id} is answered already: a question is answered once. Write to say more.`, 'refused')
      const message: MailMessage = { id: `mock.m_${this.clock.next()}`, seq: t.messages.length + 1, sender: PERSON, kind: kind ?? (question ? 'answer' : 'note'), urgent: false, body: text, facts: answers !== undefined && question?.choices?.includes(text) ? { picked: true } : {}, ...(question ? { replyTo: question.id } : {}), createdAt: this.clock.now() }
      t.messages.push(message)
      t.read = message.seq
      // As `MailPerson.reply`: the answer reads what it answers and what came before, not after
      const answered = (question ?? t.messages.findLast((m) => m.sender.kind !== 'person'))?.seq ?? 0
      t.row.unread = Math.min(t.row.unread, t.messages.filter((m) => m.sender.kind !== 'person' && m.seq > answered).length)
      t.row.last = { sender: PERSON, kind: message.kind, preview: text.slice(0, 140), at: message.createdAt }
      this.touch(t)
      return this.view(t, [message])
    },
    close: async (threadId, outcome) => {
      const t = this.must(threadId)
      if (t.lookIn) throw mockError('You are not in this mail: you can read it, not close it.', 'refused')
      // As the host (C12): the session working the thread is told without a wake, and its turn goes on
      const helper = t.row.working ? t.row.assignee?.sessionId : null
      if (helper) this.emit({ type: 'notice', sessionId: helper, level: 'info', from: 'Centralu', label: 'mail', text: 'Centralu told it the person closed its work' })
      t.row.state = 'done'
      t.row.outcome = outcome ?? 'finished'
      t.row.working = false
      // As `closeFor`: what was said to the person counts as read, so the row stops waiting
      t.row.unread = 0
      t.read = t.messages.at(-1)?.seq ?? t.read
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
      this.calls.push(`resume:thread:${target.threadId}`)
      // A pause lifted sends what it held: a thread's turns (`loop`)
      const freed = this.heldRows.filter((h) => h.reason === 'loop' && h.threadId === target.threadId)
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
    watches: async (sessionId) => {
      this.olderHost('watches.list')
      return (this.watchRows.get(sessionId) ?? []).map((w) => ({ ...w }))
    },
    cancelWatch: async (id) => {
      this.olderHost('watches.cancel')
      this.calls.push(`cancelWatch:${id}`)
      for (const [sessionId, rows] of this.watchRows) {
        if (!rows.some((w) => w.id === id)) continue
        this.watchRows.set(sessionId, rows.filter((w) => w.id !== id))
        this.emit({ type: 'watches_changed', sessionId })
        return true
      }
      return false
    },
  }
}
