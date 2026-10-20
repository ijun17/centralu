import { errorMessage, oneLineText, type MailHeldRow, type MailMessage, type MailParty, type MailThreadRow, type MailThreadView } from '@cc/protocol'
import type { MailRecords, ThreadRow } from '../dev-services/store/mail.js'
import { PERSON, parseAddress } from './address.js'
import type { MailDelivery } from './delivery.js'
import type { MailService, ThreadView } from './service.js'

/** What the person's side needs to know of a session to name it: nothing the mailbox keeps */
export type PersonHost = {
  session(sessionId: string): { name: string; state: string } | undefined
}

/** How many messages one `mail.thread` returns; `more` says there are further ones */
const THREAD_PAGE = 100
const PREVIEW_CHARS = 140

/**
 * The person's side of the mailbox (#1347, docs/plans/mailbox.md §10.1): what the Inbox lists and shows, and the acts that are
 * the person's. Everything the person writes goes through the same `MailService` a session's post does, as the person: their
 * words are theirs by who is asking (§7.1), and the rules that bind everyone bind this too, apart from the ones that are the
 * person's to be freed of (the person may write in any thread, close it, give it to another session).
 *
 * Parties come back as Centralu names them (the session's name in the sidebar, an app's id), never as a name they gave themselves.
 */
export class MailPerson {
  constructor(
    private readonly service: MailService,
    private readonly records: MailRecords,
    private readonly delivery: Pick<MailDelivery, 'resumeSession' | 'resumeThread' | 'answerCrowd' | 'crowdWaiting'>,
    private readonly host: PersonHost,
  ) {}

  list(): { threads: MailThreadRow[]; held: MailHeldRow[]; waiting: number } {
    const held = this.records.heldReceipts()
    const heldBy = new Map<string, number>()
    const heldRows: MailHeldRow[] = []
    for (const r of held) {
      const message = this.records.message(r.messageId)
      const thread = message && this.records.thread(message.threadId)
      if (!message || !thread || r.held === null) continue
      heldBy.set(thread.id, (heldBy.get(thread.id) ?? 0) + 1)
      heldRows.push({
        messageId: message.id,
        threadId: thread.id,
        subject: thread.subject,
        sender: this.party(message.sender),
        recipient: this.party(r.recipient),
        kind: message.kind,
        reason: r.held,
        preview: oneLineText(message.body, PREVIEW_CHARS),
        since: message.createdAt,
      })
    }
    const threads = this.records.inboxOf(PERSON, 100).map(({ thread, unread }) => this.row(thread, unread, heldBy.get(thread.id) ?? 0))
    return { threads, held: heldRows, waiting: this.delivery.crowdWaiting() }
  }

  /** A thread with its messages, which the person reads: what is returned is read for them */
  thread(threadId: string, opts: { after?: number | undefined; all?: boolean | undefined; tail?: number | undefined; before?: number | undefined } = {}): MailThreadView {
    const view = this.service.read(threadId, PERSON, {
      limit: THREAD_PAGE,
      ...(opts.after !== undefined ? { after: opts.after } : {}),
      ...(opts.all ? { all: true } : {}),
      ...(opts.tail !== undefined ? { tail: Math.min(opts.tail, THREAD_PAGE) } : {}),
      ...(opts.before !== undefined ? { before: opts.before } : {}),
    })
    const last = view.messages.at(-1)?.seq
    // An end of the thread has nothing after it; a page from the start or from a place has
    const more = opts.tail === undefined && last !== undefined && this.records.messagesAfter(threadId, last, 1).length > 0
    return this.view(view, more, view.older === true)
  }

  reply(threadId: string, text: string, kind: 'note' | 'answer' | 'question' = 'note'): MailThreadView {
    const posted = this.service.post(threadId, PERSON, { kind, body: text })
    return this.thread(threadId, { after: posted.message.seq - 1 })
  }

  close(threadId: string, outcome: 'finished' | 'failed' | 'stopped' | 'dropped' = 'finished'): MailThreadRow {
    const thread = this.service.update(threadId, PERSON, { state: 'done', outcome })
    return this.row(thread, 0, 0)
  }

  reassign(threadId: string, sessionId: string, text: string): MailThreadView {
    this.service.assign(threadId, PERSON, { assignee: this.service.sessionAddress(sessionId), body: text })
    return this.thread(threadId)
  }

  unblock(threadId: string, n: number): MailThreadRow {
    return this.row(this.service.resolveBlocker(threadId, PERSON, n), 0, 0)
  }

  held(action: 'release' | 'dismiss', recipient: string, messageIds: string[]): { changed: number } {
    return { changed: action === 'release' ? this.service.resendHeld(recipient, messageIds) : this.service.dismissHeld(recipient, messageIds) }
  }

  resume(target: { sessionId?: string | undefined; threadId?: string | undefined }): void {
    if (target.sessionId !== undefined) this.delivery.resumeSession(target.sessionId)
    else if (target.threadId !== undefined) this.delivery.resumeThread(target.threadId)
  }

  /**
   * The answer is taken at once: waking a crowd resumes the sessions two at a time and takes as long as that takes, longer than a
   * window waits for an answer. The list shows who is still waiting as it goes
   */
  wake(wake: boolean): void {
    this.delivery.answerCrowd(wake).catch((e: unknown) => console.error(`[mail] waking the sessions failed: ${errorMessage(e)}`))
  }

  // ── Shapes ──

  private party(address: string): MailParty {
    const p = parseAddress(address)
    if (p?.kind === 'session') {
      const s = this.host.session(p.sessionId)
      return { address, kind: 'session', sessionId: p.sessionId, name: s?.name ?? null, state: s?.state ?? null }
    }
    if (p?.kind === 'app') return { address, kind: 'app', sessionId: null, name: p.appId, state: null }
    return { address, kind: p?.kind ?? 'unknown', sessionId: null, name: null, state: null }
  }

  private row(thread: ThreadRow, unread: number, held: number): MailThreadRow {
    const last = this.records.lastMessageOf(thread.id)
    return {
      id: thread.id,
      subject: thread.subject,
      state: thread.state,
      outcome: thread.outcome,
      next: thread.next,
      projectId: thread.projectId,
      owner: this.party(thread.owner),
      assignee: thread.assignee === null ? null : this.party(thread.assignee),
      unread,
      held,
      blocked: this.records.blockers(thread.id).filter((b) => b.resolvedAt === null).length,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      last: last ? { sender: this.party(last.sender), kind: last.kind, preview: oneLineText(last.body, PREVIEW_CHARS), at: last.createdAt } : null,
    }
  }

  private view({ thread, participants, blockers, messages }: ThreadView, more: boolean, older = false): MailThreadView {
    return {
      thread: this.row(thread, 0, 0),
      parties: participants.filter((p) => p.leftAt === null).map((p) => ({ party: this.party(p.address), role: p.role })),
      blockers: blockers.map((b) => ({ n: b.n, kind: b.kind, ref: b.ref, text: b.text, resolved: b.resolvedAt !== null })),
      messages: messages.map((m): MailMessage => ({
        id: m.id,
        seq: m.seq,
        sender: this.party(m.sender),
        kind: m.kind,
        urgent: m.urgent,
        body: m.body,
        facts: { ...(m.facts ?? {}) },
        createdAt: m.createdAt,
        ...(m.receipts ? { receipts: m.receipts.map((r) => ({ ...r, recipient: this.party(r.recipient) })) } : {}),
      })),
      more,
      older,
      follows: thread.follows.flatMap((id) => {
        const f = this.records.thread(id)
        return f ? [{ id: f.id, subject: f.subject }] : []
      }),
    }
  }
}
