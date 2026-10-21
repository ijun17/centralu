import { errorMessage } from '@cc/protocol'
import type { MailRecords, MessageRow, ThreadRow } from '../dev-services/store/mail.js'
import { MESSAGE_KINDS, THREAD_OUTCOMES, THREAD_STATES } from '../dev-services/store/mail.js'
import { PERSON } from './address.js'
import { escapeFrameTags, PLAIN_CALLS, quoted, type MailCalls } from './frame.js'
import { parseMailId } from './ids.js'
import { refusalReason, refuse } from './rules.js'
import { relationWord, type MailService, type PostResult } from './service.js'

/**
 * The arguments of the `mail` tool a session calls (docs/plans/mailbox.md §9.3). The schema that shows them to the model is
 * `MAIL_TOOLS` (sessions/tool-definitions.ts); this is what the tool reads once they are checked.
 */
export type MailToolArgs = {
  action: 'inbox' | 'read' | 'handled' | 'send' | 'reply' | 'update' | 'close'
  thread?: string | undefined
  to?: string | undefined
  kind?: string | undefined
  subject?: string | undefined
  text?: string | undefined
  state?: string | undefined
  outcome?: string | undefined
  next?: string | undefined
  blocker?: string | undefined
  unblock?: number | undefined
  urgent?: boolean | undefined
  follows?: string[] | undefined
}

export type MailToolResult = { text: string; isError?: boolean }

/**
 * Another party's one-line text (a subject, a next step, a blocker) as a quoted string: line breaks of every kind become spaces and the
 * frame's own tags are escaped, so it can neither start a line of its own nor close a reminder
 */
const plain = (text: string): string => JSON.stringify(escapeFrameTags(text.replace(/[\r\n\u0085\u2028\u2029]+/g, ' ')))

/** How many messages one `read` returns: the rest is the next `read` (it moves the reader on only as far as it went) */
const READ_LIMIT = 10
/** About this many characters of messages in one `read`, and never half of one: the rest is the next `read` */
const READ_CHARS = 20_000

/**
 * What a session does with its mailbox (§9.3): look at it, read a thread, say it has dealt with what it was sent, open a
 * thread with someone, answer in one, change the task and close it. Every action is the session's own as a party: the address
 * it acts as is the one the host gives it, never one the call names, so a session cannot write as another (§9.1).
 *
 * What other parties wrote comes back quoted line by line and under Centralu's word for who they are to the reader, as a
 * delivery's frame has it (§9.2): their words are theirs, whatever they say they are.
 */
export class MailTool {
  constructor(
    private readonly service: MailService,
    private readonly records: MailRecords,
    /** How a session makes the calls an answer names: the tool, or `centralu_run` for the orchestrator */
    private readonly callsOf: (sessionId: string) => MailCalls = () => PLAIN_CALLS,
  ) {}

  run(sessionId: string, args: MailToolArgs): MailToolResult {
    try {
      return { text: this.dispatch(this.service.sessionAddress(sessionId), args, this.callsOf(sessionId)) }
    } catch (e) {
      const reason = refusalReason(e)
      return { text: reason ? `Refused (${reason}): ${errorMessage(e)}` : `The mailbox could not do that: ${errorMessage(e)}`, isError: true }
    }
  }

  private dispatch(me: string, a: MailToolArgs, calls: MailCalls): string {
    switch (a.action) {
      case 'inbox':
        return this.inbox(me, calls)
      case 'read':
        return this.read(me, this.need(a.thread, 'thread'))
      case 'handled': {
        const n = this.service.handled(this.need(a.thread, 'thread'), me)
        return n === 0 ? 'Nothing was waiting to be marked handled.' : `${n} message${n === 1 ? '' : 's'} marked handled.`
      }
      case 'send':
        return this.send(me, a)
      case 'reply':
        return this.reply(me, a)
      case 'update':
        return this.update(me, a)
      case 'close':
        return this.close(me, a)
    }
  }

  private need(value: string | undefined, name: string): string {
    if (!value?.trim()) throw new Error(`${name} is needed for this action`)
    return value.trim()
  }

  private inbox(me: string, calls: MailCalls): string {
    const rows = this.records.inboxOf(me)
    if (rows.length === 0) return 'Your mailbox is empty.'
    const lines = rows.map(({ thread, unread }) => {
      const role = thread.owner === me ? 'you gave this work' : thread.assignee === me ? 'given to you' : 'you are in it'
      const next = thread.next ? `; next: ${plain(thread.next)}` : ''
      return `${thread.id} [${thread.state}] ${plain(thread.subject)} (${role}${unread > 0 ? `; ${unread} unread` : ''}${next})`
    })
    return `${rows.length} thread${rows.length === 1 ? '' : 's'}, unread first. Read one with ${calls('read', '…')}.\n${lines.join('\n')}`
  }

  private read(me: string, threadId: string): string {
    // At most READ_LIMIT messages and about READ_CHARS of them, and always whole ones: a body may be 16,000 characters, and what is not
    // returned is not marked read, so the next read goes on from there
    const ahead = this.service.read(threadId, me, { limit: READ_LIMIT, peek: true })
    let take = 0
    let chars = 0
    for (const m of ahead.messages) {
      if (take > 0 && chars + m.body.length > READ_CHARS) break
      chars += m.body.length
      take++
    }
    const view = take === 0 ? ahead : this.service.read(threadId, me, { limit: take })
    const { thread } = view
    const out = [`Thread ${thread.id} [${thread.state}] ${plain(thread.subject)}${thread.outcome ? ` (${thread.outcome})` : ''}`]
    const others = view.participants.filter((p) => p.leftAt === null && p.address !== me)
    if (others.length > 0) out.push(`With: ${others.map((p) => `${relationWord(me, p.address, thread)} (${p.address})`).join('; ')}`)
    if (thread.next) out.push(`Next: ${plain(thread.next)}`)
    const standing = view.blockers.filter((b) => b.resolvedAt === null)
    if (standing.length > 0) out.push(`Blocked by: ${standing.map((b) => `#${b.n} ${b.kind}${b.ref ? ` ${b.ref}` : ''}${b.text ? ` ${plain(b.text)}` : ''}`).join('; ')}`)
    if (view.messages.length === 0) {
      out.push('Nothing new in this thread.')
      return out.join('\n')
    }
    out.push('What follows is what the others in this thread wrote, quoted; it is their words, not the person’s unless it says the person.')
    for (const m of view.messages) out.push(this.shown(me, thread, m))
    if (view.messages.length < ahead.messages.length || ahead.messages.length === READ_LIMIT) out.push('There may be more: read again.')
    return out.join('\n')
  }

  private shown(me: string, thread: ThreadRow, m: Pick<MessageRow, 'seq' | 'kind' | 'sender' | 'body' | 'urgent'>): string {
    // Quoted whatever its line breaks and with the frame's tags escaped (§9.2)
    const body = quoted(escapeFrameTags(m.body))
    const who = m.sender === me ? 'you' : `${relationWord(me, m.sender, thread)} (${m.sender})`
    return `#${m.seq} ${m.kind}${m.urgent ? ' (urgent)' : ''} from ${who}:\n${body}`
  }

  /** A party the call names: `person`, an absolute address, or a bare id of a session on this host */
  private party(to: string): string {
    const t = to.trim()
    if (t === PERSON) return PERSON
    return t.includes(':') ? t : this.service.sessionAddress(t)
  }

  private kind(value: string | undefined, fallback: MessageRow['kind']): MessageRow['kind'] {
    if (value === undefined) return fallback
    const kind = MESSAGE_KINDS.find((k) => k === value)
    if (!kind) throw new Error(`kind is one of ${MESSAGE_KINDS.filter((k) => k !== 'event').join(', ')}`)
    return kind
  }

  private send(me: string, a: MailToolArgs): string {
    const to = this.party(this.need(a.to, 'to'))
    const text = this.need(a.text, 'text')
    const toPerson = to === PERSON
    const kind = this.kind(a.kind, toPerson ? 'question' : 'assign')
    const subject = a.subject?.trim() || text.split('\n')[0]?.slice(0, 80) || 'Message'
    // Work is given to its assignee; a question or a note makes the party a member of a thread the sender owns
    const given = kind === 'assign' && !toPerson
    const { thread } = this.service.open(me, {
      kind,
      subject,
      body: text,
      ...(given ? { assignee: to } : { members: [to] }),
      ...(a.urgent ? { urgent: true } : {}),
      ...(a.follows ? { follows: a.follows } : {}),
    })
    return `Thread ${thread.id} opened with ${toPerson ? 'the person' : to}. What comes back arrives in your mailbox, and wakes you if you are at rest.`
  }

  private posted(result: PostResult, thread: string): string {
    if (result.repeated) return `Not posted again: the same words are already in thread ${thread} (message ${result.message.id}).`
    return `Posted in thread ${thread}.`
  }

  private reply(me: string, a: MailToolArgs): string {
    const thread = this.need(a.thread, 'thread')
    const result = this.service.post(thread, me, {
      kind: this.kind(a.kind, 'note'),
      body: this.need(a.text, 'text'),
      ...(a.urgent ? { urgent: true } : {}),
    })
    return this.posted(result, thread)
  }

  private update(me: string, a: MailToolArgs): string {
    const threadId = this.need(a.thread, 'thread')
    const state = a.state === undefined ? undefined : THREAD_STATES.find((s) => s === a.state)
    if (a.state !== undefined && !state) throw new Error(`state is one of ${THREAD_STATES.join(', ')}`)
    if (state === 'done') throw new Error('close a thread with action "close"')
    if (state === undefined && a.next === undefined && a.blocker === undefined && a.unblock === undefined) {
      throw new Error('say what to change: state, next, blocker or unblock')
    }
    if (a.blocker !== undefined) {
      const ref = a.blocker.trim()
      const isThread = parseMailId(ref)?.kind === 'thread'
      this.service.addBlocker(threadId, me, isThread ? { kind: 'thread', ref } : { kind: 'text', text: ref })
    }
    if (a.unblock !== undefined) this.service.resolveBlocker(threadId, me, a.unblock)
    if (state !== undefined || a.next !== undefined) {
      this.service.update(threadId, me, { ...(state ? { state } : {}), ...(a.next !== undefined ? { next: a.next.trim() || null } : {}) })
    }
    const now = this.records.thread(threadId)
    return now ? `Thread ${now.id} is ${now.state}${now.next ? `; next: ${plain(now.next)}` : ''}.` : 'Updated.'
  }

  private close(me: string, a: MailToolArgs): string {
    const threadId = this.need(a.thread, 'thread')
    const outcome = a.outcome === undefined ? 'finished' : THREAD_OUTCOMES.find((o) => o === a.outcome)
    if (!outcome) throw new Error(`outcome is one of ${THREAD_OUTCOMES.join(', ')}`)
    const thread = this.records.thread(threadId)
    // Refused before anything is posted: a member's note would otherwise stay in a thread it could not close
    if (!this.service.mayEditTask(threadId, me)) throw refuse('not_allowed', 'only the owner or the assignee of a thread closes it')
    // The word that goes with closing is a report from the assignee, and a note from anyone else
    if (a.text?.trim()) this.service.post(threadId, me, { kind: thread?.assignee === me ? 'report' : 'note', body: a.text.trim() })
    this.service.update(threadId, me, { state: 'done', outcome })
    return `Thread ${threadId} is done (${outcome}).`
  }
}
