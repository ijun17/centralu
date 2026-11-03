import { createHash } from 'node:crypto'
import { createListeners } from '@cc/common'
import { errorMessage, oneLineText } from '@cc/protocol'
import { asObj } from '../json-value.js'
import {
  HIDDEN_HOLDS,
  MailTargetMissing,
  type HandOverScope,
  type MailFacts,
  type MailKind,
  type MailRow,
  type MailboxRecords,
  type NewMail,
  type NewRecipient,
  type RecipientRow,
  type ReleaseWhy,
  type StoredMail,
} from '../dev-services/store/mailbox.js'
import { CENTRALU, PERSON, parseAddress, sessionAddress } from './address.js'
import { buildMessageFrame, mailCalls, type MessageCalls, type MessageFrameItem } from './frame.js'
import { UlidMaker, messageIdOf } from './ids.js'
import type { MailReach } from './reach.js'
import {
  ASKS_PER_HOUR,
  HOUR_MS,
  MAX_RECIPIENTS,
  MINUTE_MS,
  PAIR_NEW_PER_HOUR,
  READ_CHAIN,
  READ_CHARS,
  READ_ITEMS,
  REFUSAL_TEXT,
  REPEAT_WINDOW_MS,
  bodyLimit,
  cutTask,
  depthOf,
  dueAt,
  firstLineOf,
  flowsDownTo,
  pickWork,
  postsPerMinute,
  quietAnswer,
  refuse,
  wakesMessage,
  type SenderClass,
} from './rules.js'
import type { TurnNow } from './turns.js'

/*
 * The message service (#1684, docs/plans/mailbox.md §16 M2): mail without threads. It stores and answers over `MailboxRecords` and asks `MailReach`
 * who may write to whom and what is held. It delivers nothing and wakes nobody, never calls `MailTurns` or the manager (what it needs of a session's
 * turn comes through the `turn` option), and nothing in the host calls it before slice M3a.
 *
 * **Who is calling is an argument, never a field of the input**, as `MailService`: a tool that spreads its arguments cannot name `person` or `centralu`.
 */

export type QuietReason = 'budget'
/** Why a row is left out of a delivery and kept for the person: the one hold (§7.4), or a pair's turns ran away (§7.5) */
export type HoldReason = 'policy' | 'loop'

/** What a send names: resolved addresses (the tool resolves names), the text, and the flags a sender may set */
export type SendInput = {
  /** 1 to 10 addresses. Empty with `replyTo`: the sender of the message answered */
  to: readonly string[]
  text: string
  needsReply?: boolean
  replyTo?: string
  urgent?: boolean
  /** Per recipient: `orchestrator` when the sender named the role (D15) */
  via?: readonly (string | null)[]
  /** A request to the orchestrator cites the person's newest message in the sender's conversation as their word for it (docs/plans/cited-requests.md) */
  cite?: boolean
}
/**
 * `asWork`: an answer to a clarification, stored as a task (§9.7). `cited`: the person's message a request to the orchestrator cites, checked.
 * `notCited`: why a citation the request asked for did not pass the check, so the orchestrator reads the request as the session's own words
 */
export type SendResult = {
  message: MailRow
  held: { recipient: string; why: HoldReason }[]
  answered: string | null
  quiet: boolean
  asWork: boolean
  cited?: { seq: number; at: number }
  notCited?: string
}

/** How old the person's message a request cites may be (owner, 2026-11-03) */
export const CITE_MS = 30 * 60_000

export type DelegationOrigin = 'start_agent' | 'agent_session' | 'send_to_session' | 'create_session' | 'ask_project' | 'script'
export type TaskInput = { text: string; origin: DelegationOrigin | 'person' | 'mail'; delivered: boolean; replyTo?: string }

/** A session's turn, as `MailTurns.current` gives it (§8.2 step 6) */
export type { TurnNow }

export type TurnReport = {
  outcome: 'finished' | 'failed' | 'stopped' | 'paused' | 'waiting'
  body: string
  answer?: string
  error?: string
  reason?: string
  paused?: number
  waitingOn?: number
  personNote?: boolean
  /** When the turn that ended began, for the tasks its report covers (§9.3): the turn has ended by the time the old path reports it */
  startedAt?: number
}
export type ReportWritten = { message: MailRow; duplicate: boolean; first: boolean } | { settledAlready: true }

/** `withheld`: a request to the orchestrator whose words are shown only in the turn it starts (§7.6); the body is left out */
export type ReadItem = { message: MailRow; row: RecipientRow | null; relation: string; phantom?: 'not_sent' | 'gone' | 'held'; withheld?: true }
export type ReadView = { items: ReadItem[]; older: string | null; marked: number }
export type InboxView = {
  needReply: ReadItem[]
  unread: ReadItem[]
  waiting: { row: RecipientRow; message: MailRow }[]
  held: { row: RecipientRow; message: MailRow; why: HoldReason }[]
}
export type HandedOverMessage = { messageId: string; firstLine: string; kind: MailKind; unread: boolean }
/** The calls a wake names; `mailCalls` makes them. M3c renames `MessageCalls` when the old `MailCalls` of `frame.ts` goes */
export type MailCalls = MessageCalls

export type DrainOptions = {
  /** Mail that is told of once more, delivered and still unread */
  again?: boolean
  /** Left out, and nothing is written about it */
  skip?: (message: MailRow, row: RecipientRow) => boolean
  /** Told of, but not a reason for a turn */
  quiet?: (message: MailRow, row: RecipientRow) => QuietReason | null | undefined
  /** Left out and held for the person */
  holdBack?: (message: MailRow, row: RecipientRow) => HoldReason | null | undefined
}
export type DrainResult = {
  /** The wake frame; empty when there is nothing to say */
  text: string
  messageIds: string[]
  /** Those whose words are in the text whole */
  inline: string[]
  /** Those the text only points at */
  pointed: string[]
  wake: boolean
  immediate: boolean
  /** Whether anything in it waits for an answer: it goes before the rest when many sessions are woken at once */
  needsReply: boolean
  line: string
  quieted: { messageId: string; reason: QuietReason }[]
  heldBack: { messageId: string; reason: HoldReason }[]
  /** The task (or, for the orchestrator, the first request of its asker) a turn this delivery starts is the work of, or null */
  workMessage: string | null
  /** For the orchestrator, the session whose requests this delivery carries */
  asker: string | null
}

export type MailChange = { messageId: string; rootId: string; recipients: string[] }

export class MessageService {
  private readonly now: () => number
  private readonly ulids: UlidMaker
  private readonly listeners = createListeners<MailChange>((e) => console.error(`[mail] a listener failed: ${errorMessage(e)}`))
  private queued: MailChange[] = []
  private running = false

  constructor(
    private readonly records: MailboxRecords,
    private readonly reach: MailReach,
    private readonly opts: {
      hostId: string
      now?: () => number
      ids?: UlidMaker
      /** `MailTurns.current`: the session's turn now (§8.2 step 6) */
      turn?: (sessionAddress: string) => TurnNow | null
      /** How a wake names its calls to this session; the tool at the version-2 schema when absent */
      calls?: (sessionAddress: string) => MailCalls
      /** The newest message the person typed in this session (`MessageRecords.newestPersonMessage`); none cites anything when absent */
      personSaid?: (sessionId: string) => { seq: number; ts: number } | null
    },
  ) {
    this.now = opts.now ?? Date.now
    this.ulids = opts.ids ?? new UlidMaker()
  }

  sessionAddress(sessionId: string): string {
    return sessionAddress(this.opts.hostId, sessionId)
  }

  /** Hears every change once it has committed: a message written, and who it is for. A listener that throws is said on stderr */
  onChange(listener: (c: MailChange) => void): () => void {
    return this.listeners.add(listener)
  }

  /** One unit of work; what it queued for the listeners goes out once it has committed, and is dropped if it did not */
  private run<T>(fn: () => T): T {
    if (this.running) return fn()
    this.running = true
    this.queued = []
    let result: T
    try {
      result = this.records.transaction(fn)
    } catch (e) {
      this.queued = []
      throw e
    } finally {
      this.running = false
    }
    const merged = new Map<string, MailChange>()
    for (const c of this.queued) {
      const kept = merged.get(c.messageId)
      merged.set(c.messageId, kept ? { ...kept, recipients: [...new Set([...kept.recipients, ...c.recipients])] } : c)
    }
    this.queued = []
    for (const c of merged.values()) this.listeners.emit(c)
    return result
  }

  // ── Writing ──

  /**
   * A session's or the person's message (D1 to D8). Guards: the post rate, `pair_rate`, `repeat`, `ask_rate` and the number of recipients. It records the
   * cause, the depth and a clarification's task, holds what the one hold or the depth holds, delivers an answer that needs nothing quietly, and settles
   * (or, when the answer is held, marks) the sender's own row on the message it answers. An answer to a clarification is stored as a task (§9.7)
   */
  send(sender: string, input: SendInput): SendResult {
    const from = parseAddress(sender)
    if (!from || from.kind === 'centralu') throw refuse('not_allowed', 'Centralu sends with notice and report')
    const cls: SenderClass = from.kind
    const text = this.checkText(cls, input.text)
    if (input.urgent === true && cls !== 'session' && cls !== 'person') throw refuse('field_not_allowed', 'only a session or the person marks mail urgent')
    const target = input.replyTo === undefined ? undefined : this.readable(sender, input.replyTo)

    let to = [...new Set(input.to)]
    if (to.length === 0) {
      if (!target) throw refuse('bad_value', 'a message needs at least one recipient')
      if (target.sender === sender) throw refuse('own_message', REFUSAL_TEXT.own_message(target.id))
      to = [target.sender]
    }
    if (to.length > MAX_RECIPIENTS) throw refuse('recipients', REFUSAL_TEXT.recipients())

    const causeId = this.causeOf(sender)
    const cause = causeId === null ? null : (this.records.message(causeId) ?? null)
    // A clarification: a session's word to the owner of the task its turn is for (§9.7). It is no request
    const clarifies = cls === 'session' && cause?.kind === 'task' && to.length === 1 && to[0] === cause.sender ? cause.id : undefined
    // The owner's answer to one is work again: a task from the owner to the one who asked
    const asWork = target !== undefined && this.answersClarification(sender, target, to)
    const kind: MailKind = asWork ? 'task' : 'message'

    const requests = to.map((r) => this.isRequest({ sender, kind: 'message', replyTo: target?.id ?? null, facts: { clarifies } }, r))
    for (const [i, r] of to.entries()) {
      const party = parseAddress(r)
      if (!party) throw refuse('bad_address', `Not a mail address: ${JSON.stringify(r)}`)
      if (r === sender) throw refuse('bad_value', 'a message is for someone else')
      const why = this.reach.mayWrite(sender, r, requests[i])
      if (why !== null) throw refuse(why, this.refusalText(why, r))
    }

    return this.run(() => {
      const now = this.now()
      // The person's message a request cites, checked here, in the send's transaction: evidence for the orchestrator's judgement (docs/plans/cited-requests.md §3)
      const word = input.cite === true && requests.includes(true) && from.kind === 'session' ? this.personWord(sender, from.sessionId, now) : null
      const cited = word !== null && typeof word === 'object' ? word : undefined
      this.guards(sender, cls, to, text, target, requests, now)

      const needsReply = kind === 'message' && (input.needsReply ?? target === undefined)
      const about = cause === null ? [] : this.aboutFollowUp(cause)
      const depth = kind === 'message' ? depthOf(cause, about, to) : 0
      const urgent = input.urgent === true
      const senderProject = this.reach.projectOf(sender)
      // The hold judges what the message is to the one hold, whatever it is stored as
      const holds = to.map((r) => this.reach.holdFor({ kind: 'message', sender, senderProject, depth }, r))
      const quiet =
        kind === 'message' && target !== undefined && to.length === 1 && to[0] === target.sender &&
        quietAnswer({ kind, sender, needsReply, urgent }, target, { parent: this.reach.parentOf(target.sender), owesTask: this.records.newestTask(sender, target.sender) !== undefined, request: requests[0] === true })
      const facts: MailFacts = { ...(clarifies !== undefined ? { clarifies } : {}), ...(quiet ? { quiet: true } : {}), ...(cited ? { cites: cited } : {}) }

      const stored = this.put(
        // The citation's one use: `UNIQUE(sender, dedupe_key)` (`personWord` looked first, in this transaction)
        { sender, kind, body: text, needsReply, replyTo: target?.id ?? null, causeId, depth, urgent, facts, origin: cls === 'person' ? 'person' : cls === 'app' ? 'app' : 'mail', ...(cited ? { dedupeKey: citeKey(cited.seq) } : {}) },
        to.map((r, i) => this.row(r, { dueAt: dueAt(now, urgent, cls === 'person'), via: input.to.length > 0 ? (input.via?.[input.to.indexOf(r)] ?? null) : null, held: holds[i] ?? null })),
      )
      const held = to.flatMap((recipient, i) => (holds[i] ? [{ recipient, why: holds[i] }] : []))
      // What is held waits for the person: the Inbox lists it (§7.4), so it hears of it
      if (held.length > 0) this.changed(stored, [PERSON])

      // The sender's own row on what it answers: settled, or while the answer is held, marked so the question stays open (D8)
      if (target?.kind === 'message' && target.needsReply && this.records.recipient(target.id, sender)) {
        if (held.length === 0) this.records.settle(target.id, sender, 'answered', now, stored.id)
        else this.answerHeld(target, stored, held[0]?.why ?? 'policy')
      }
      return { message: stored, held, answered: target?.id ?? null, quiet, asWork, ...(cited ? { cited } : {}), ...(typeof word === 'string' ? { notCited: word } : {}) }
    })
  }

  /**
   * The person's word a request cites, checked in code (docs/plans/cited-requests.md §3): the newest message the person typed in the sender's own
   * conversation, at most `CITE_MS` old and not later than now, not cited before by this sender. Or, when none passes, why not, in words for the sender
   */
  private personWord(sender: string, sessionId: string, now: number): { seq: number; at: number } | string {
    const said = this.opts.personSaid?.(sessionId) ?? null
    if (!said) return 'the person has typed nothing in this session that it could cite'
    const age = now - said.ts
    // A clock set back makes a message look newer than it is
    if (age < 0) return "the person's last message here is dated later than now"
    if (age > CITE_MS) return `the person's last message here is ${Math.round(age / 60_000)} minutes old, and a citation may be ${CITE_MS / 60_000} at most`
    if (this.records.hasDedupe(sender, citeKey(said.seq))) return "the person's last message here was cited by an earlier request already"
    return { seq: said.seq, at: said.ts }
  }

  /** Work a delegation tool gave: a task from `sender` to `recipient`, whose turn Centralu reports (D2, D7). Written delivered when the old path delivered its words */
  task(sender: string, recipient: string, input: TaskInput): MailRow {
    const from = parseAddress(sender)
    if (!from || from.kind === 'centralu') throw refuse('not_allowed', 'Centralu sends with notice and report')
    // The delegation tool has started the child already: a long text is cut as the old record cut it, never refused (Q-M2-13)
    const text = cutTask(input.text, bodyLimit(from.kind))
    if (text === '') throw refuse('empty', 'a task says something')
    return this.run(() => {
      const now = this.now()
      return this.put(
        { sender, kind: 'task', body: text, replyTo: input.replyTo ?? null, causeId: this.causeOf(sender), origin: input.origin },
        [this.row(recipient, { dueAt: input.delivered ? now : dueAt(now, false, from.kind === 'person'), ...(input.delivered ? { deliveredAt: now, readAt: now } : {}) })],
      )
    })
  }

  /** A delegation refused for the caller's untrusted project (§7.4): the record S16 is built from, written delivered and read, since the agent has the refusal already */
  refused(callerId: string, input: { tool: string; target: string; firstLine: string; projectId: string }): void {
    const to = this.sessionAddress(callerId)
    const now = this.now()
    const firstLine = oneLineText(input.firstLine, 120)
    this.run(() =>
      this.centralu(to, {
        kind: 'notice',
        body: REFUSAL_TEXT.untrusted_project(this.reach.projectLabel(input.projectId), input.target),
        facts: { refused: { ...input, firstLine } },
        dedupeKey: `refused:${to}:${hash16([input.tool, input.target, input.firstLine])}:${Math.floor(now / MINUTE_MS)}`,
        delivered: true,
      }),
    )
  }

  /**
   * How a turn of delegated work ended (§9.3): Centralu's report, replying to the task, for its sender. A turn that ended for good settles the task
   * `reported`, and every other open task from the same sender to the same child that was delivered before the turn began (F4, K3); a pause
   * (`paused`, `waiting`) settles nothing, wakes its owner the first time and is quiet after. The same pause again is the stored report, `duplicate`
   */
  report(taskId: string, input: TurnReport): ReportWritten {
    return this.run(() => {
      const task = this.records.message(taskId)
      // A task, or for the orchestrator's request turn the request it was for (§9.2): Centralu reports either to its sender
      const row = task && (task.kind === 'task' || task.kind === 'message') ? this.records.recipients(taskId).find((r) => task.kind === 'task' || this.isRequest(task, r.recipient)) : undefined
      if (!task || !row) throw refuse('unknown_message', REFUSAL_TEXT.unknown_message(taskId))
      // A request's turn is reported whatever its row says: a moved request is settled `legacy`, and its asker is told all the same (§6.3)
      if (row.settled !== null && task.kind === 'task') return { settledAlready: true }
      const now = this.now()
      const pause = input.outcome === 'paused' || input.outcome === 'waiting'
      const first = !pause || !this.records.reportsOn(taskId).some((r) => r.facts.outcome === 'paused' || r.facts.outcome === 'waiting')
      const startedAt = input.startedAt ?? this.opts.turn?.(row.recipient)?.startedAt
      const covers = pause || startedAt === undefined || task.kind !== 'task'
        ? []
        : this.records
            .watchedFrom(task.sender)
            .filter((x) => x.recipient === row.recipient && x.messageId !== taskId && x.deliveredAt !== null && x.deliveredAt < startedAt && this.records.message(x.messageId)?.kind === 'task')
            .map((x) => x.messageId)
      const facts: MailFacts = {
        outcome: input.outcome,
        about: { session: row.recipient },
        ...(input.error ? { error: input.error } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.paused ? { paused: input.paused } : {}),
        ...(input.waitingOn ? { waitingOn: input.waitingOn } : {}),
        ...(input.personNote ? { personNote: true } : {}),
        ...(input.answer ? { answer: input.answer } : {}),
        ...(covers.length > 0 ? { covers } : {}),
        ...(first ? {} : { quiet: true }),
      }
      const stored = this.centralu(task.sender, {
        kind: 'report',
        body: input.body,
        facts,
        replyTo: taskId,
        dedupeKey: `report:${task.sender}:${taskId}:${input.outcome}:${input.paused ?? input.waitingOn ?? 0}`,
      })
      if (!stored.duplicate && !pause) {
        for (const id of [taskId, ...covers]) this.records.settle(id, row.recipient, 'reported', now)
      }
      return { message: stored, duplicate: stored.duplicate, first }
    })
  }

  /** A task the old report paths no longer owe is settled `reported` with no report: the old path told its sender (§9.5). Returns the rows settled */
  settleReported(taskId: string, recipient: string): number {
    return this.run(() => (this.records.message(taskId)?.kind === 'task' ? this.records.settle(taskId, recipient, 'reported', this.now()) : 0))
  }

  /**
   * The work handed on in the child's current work for `owner` that is still owed (§9.4): task rows caused by the child's turn's task from `owner`
   * (else its newest unsettled task from `owner`), not settled, not held, and still owed by the old report paths (`oldOwes`, §9.5)
   */
  waitingOn(owner: string, child: string, current: string | null, oldOwes: (sender: string, recipient: string) => boolean): number {
    const work = current === null ? undefined : this.records.message(current)
    const task = work?.kind === 'task' && work.sender === owner ? work : this.records.newestTask(owner, child)
    // A task not delivered yet is owed too: the old path marks its report when the delivery gives it (§9.7), so until then only the row says so
    return task ? this.records.handedOn(task.id).filter((r) => !r.delivered || oldOwes(r.sender, r.recipient)).length : 0
  }

  /** A notice from Centralu (D2, D21): quiet when `facts.quiet`. Undefined when its `dedupeKey` was used already */
  notice(recipient: string, input: { body: string; facts: MailFacts; dedupeKey: string }): MailRow | undefined {
    const stored = this.run(() => this.centralu(recipient, { kind: 'notice', ...input }))
    return stored.duplicate ? undefined : stored
  }

  /** `mail done` (D8): as a recipient, no answer is needed; as the sender, the message is withdrawn for every unsettled recipient */
  done(by: string, id: string): { settled: number; how: 'done' | 'withdrawn' | 'none' | 'unwatched' } {
    return this.run(() => {
      const m = this.records.message(id)
      if (!m) throw refuse('unknown_message', REFUSAL_TEXT.unknown_message(id))
      const mine = m.sender === by
      const row = mine ? undefined : this.records.recipient(id, by)
      if (!mine && !row) throw refuse('not_yours', REFUSAL_TEXT.not_yours(id))
      // A request is marked done in the turn it starts, where its words are shown (§7.6)
      if (!mine && this.isRequest(m, by) && m.sender !== this.opts.turn?.(by)?.asker) throw refuse('not_allowed', REFUSAL_TEXT.withheld(id))
      // A task is settled by its report, not by its receiver saying it needs nothing: that would take the report from its owner
      if (!m.needsReply && (m.kind !== 'task' || !mine)) return { settled: 0, how: 'unwatched' }
      if (mine) {
        const n = this.records.settle(id, 'all', 'withdrawn', this.now())
        return { settled: n, how: n > 0 ? 'withdrawn' : 'none' }
      }
      if (row?.settled !== null) return { settled: 0, how: 'none' }
      return { settled: this.records.settle(id, by, 'done', this.now()), how: 'done' }
    })
  }

  // ── Reading ──

  /**
   * `mail read` (§8.4): with no id the reader's unread mail, oldest first, at most 10 messages and about 20,000 characters, never half a message, marked
   * read; with an id that message and its chain back, at most 9 ancestors oldest first, phantoms for what the reader may not read (§5.5), and the
   * message itself marked read. `before` is the older half of a chain. A request to the orchestrator is read only in its asker's turn (§7.6)
   */
  read(reader: string, opts: { id?: string; before?: string } = {}): ReadView {
    return this.run(() => {
      const now = this.now()
      const asker = this.opts.turn?.(reader)?.asker ?? null
      if (opts.id === undefined && opts.before === undefined) {
        const items: ReadItem[] = []
        let chars = 0
        for (const { message } of this.records.unreadFor(reader)) {
          const item = this.item(message, reader, asker)
          // Work not delivered yet reaches the session by delivery, which a read here would take it out of (#1683)
          if (item.withheld || (item.row?.deliveredAt === null && (message.kind === 'task' || this.isRequest(message, reader)))) continue
          if (items.length >= READ_ITEMS || (items.length > 0 && chars + message.body.length > READ_CHARS)) break
          items.push(item)
          chars += message.body.length
        }
        const marked = this.records.markRead(reader, items.map((i) => i.message.id), now)
        return { items, older: null, marked }
      }
      const id = opts.id ?? opts.before ?? ''
      const base = opts.id === undefined ? this.records.message(id) : this.readable(reader, id)
      if (!base) throw refuse('unknown_message', REFUSAL_TEXT.unknown_message(id))
      const chain = this.records.chain(id, READ_CHAIN)
      const oldest = chain.at(-1) ?? base
      const missing = oldest.replyTo !== null && chain.length < READ_CHAIN && this.records.message(oldest.replyTo) === undefined
      const items = [...(missing ? [this.gone(oldest.replyTo ?? '')] : []), ...chain.reverse().map((m) => this.item(m, reader, asker)), ...(opts.id === undefined ? [] : [this.item(base, reader, asker)])]
      const read = opts.id === undefined ? undefined : items.at(-1)
      const marked = read && !read.phantom && !read.withheld && read.row ? this.records.markRead(reader, [base.id], now) : 0
      return { items, older: !missing && chain.length === READ_CHAIN && oldest.replyTo !== null ? oldest.id : null, marked }
    })
  }

  /** What the reader's `inbox` lists (S6): what waits for its answer, what is unread, what it asked and is not answered, and its mail held for the person */
  inbox(reader: string): InboxView {
    const asker = this.opts.turn?.(reader)?.asker ?? null
    const messageOf = (row: RecipientRow) => this.records.message(row.messageId)
    const needReply = this.records
      .unansweredTo(reader)
      .flatMap((row) => {
        const m = messageOf(row)
        return m?.kind === 'message' && !isHidden(row) ? [m] : []
      })
      .map((m) => this.item(m, reader, asker))
    const listed = new Set(needReply.map((i) => i.message.id))
    const unread = this.records
      .unreadFor(reader)
      .filter((p) => !listed.has(p.message.id))
      .map((p) => this.item(p.message, reader, asker))
    const waiting = this.records.watchedFrom(reader).flatMap((row) => {
      const message = messageOf(row)
      return message?.kind === 'message' && message.needsReply ? [{ row, message }] : []
    })
    const held = this.records.heldRows().flatMap((row) => {
      const message = messageOf(row)
      return message?.sender === reader && isHidden(row) ? [{ row, message, why: row.held === 'loop' ? ('loop' as const) : ('policy' as const) }] : []
    })
    return { needReply, unread, waiting, held }
  }

  /** The messages to or from `address`, newest first, as the address reads them (the person's Inbox feed, M6's `mail.inbox`, §12.2). Marks nothing */
  feed(address: string, opts: { before?: string; limit: number }): { items: ReadItem[]; older: boolean } {
    const found = this.records.feedOf(address, { ...(opts.before === undefined ? {} : { before: opts.before }), limit: opts.limit + 1 })
    return { items: found.slice(0, opts.limit).map((m) => this.item(m, address, null)), older: found.length > opts.limit }
  }

  watchedTo(recipient: string): RecipientRow[] {
    return this.records.watchedTo(recipient)
  }

  // ── The wake ──

  /**
   * What a delivery to `recipient` would send now, and which messages it covers (§8.2). It reads the rows as they are: what was read since is not in it,
   * nor a reminder whose messages are settled, nor mail whose sender may no longer write. The one hold and the depth hold a row (`heldBack`, which the
   * delivery writes); a task is the work of the turn it starts, one to a wake, and for the orchestrator one asker's requests; everything else rides along
   */
  drain(recipient: string, opts: DrainOptions = {}): DrainResult {
    const now = this.now()
    const toOrchestrator = this.reach.isOrchestrator(recipient)
    const parent = this.reach.parentOf(recipient)
    type Candidate = { row: RecipientRow; message: MailRow; down: boolean; quietFor: QuietReason | null | undefined; request: boolean }
    const candidates: Candidate[] = []
    const heldBack: DrainResult['heldBack'] = []
    for (const { row, message } of this.records.pendingFor(recipient, now, opts.again === true)) {
      const request = this.isRequest(message, recipient)
      if (message.sender === recipient || this.reach.mayWrite(message.sender, recipient, request) !== null || opts.skip?.(message, row)) continue
      if (this.reminderSettled(message, recipient)) {
        this.records.markRead(recipient, [message.id], now)
        continue
      }
      // A row an older build's person released goes as it is: never held again (§6.3)
      const releasedBefore = row.held === 'released' && message.facts.releasedTo?.includes(recipient) === true
      const why = (releasedBefore ? null : this.reach.holdFor(message, recipient, row.held === 'released')) ?? opts.holdBack?.(message, row)
      if (why) {
        heldBack.push({ messageId: message.id, reason: why })
        continue
      }
      const sender = parseAddress(message.sender)?.kind
      candidates.push({
        row,
        message,
        request,
        down: flowsDownTo({ fromPerson: sender === 'person', fromSession: sender === 'session', kind: message.kind, toOrchestrator, fromParent: parent === message.sender }),
        quietFor: sender === 'person' ? null : opts.quiet?.(message, row),
      })
    }

    // One turn, one task (D17): a delivery that starts a turn carries at most one task, or for the orchestrator one asker's requests
    const wakesIt = (c: Candidate) => !c.quietFor && wakesMessage(c.message)
    const isWork = (c: Candidate) => (toOrchestrator ? c.request : c.message.kind === 'task')
    const groupOf = (c: Candidate) => (toOrchestrator ? c.message.sender : c.message.id)
    const picked = pickWork(
      candidates
        .filter((c) => wakesIt(c) && isWork(c))
        .map((c) => ({ key: groupOf(c), decides: c.message.urgent || c.message.sender === PERSON, needsReply: toOrchestrator && c.message.needsReply, dueAt: c.row.dueAt })),
      now,
    )
    const turnStarts = candidates.some(wakesIt)
    const handedOn = turnStarts && picked === null ? candidates.map((c) => (wakesIt(c) ? this.handedOnFrom(c.message, recipient) : undefined)).find((id) => id !== undefined) : undefined
    const kept = turnStarts ? candidates.filter((c) => !isWork(c) || groupOf(c) === picked) : candidates
    const workMessage = !turnStarts ? null : handedOn ?? (toOrchestrator ? (kept.find((c) => c.request)?.message.id ?? null) : picked)

    const items: MessageFrameItem[] = []
    const relations = new Set<string>()
    const quieted: DrainResult['quieted'] = []
    let wake = false
    let immediate = false
    let needsReply = false
    for (const { row, message, down, quietFor } of kept) {
      if (quietFor) quieted.push({ messageId: message.id, reason: quietFor })
      else if (wakesMessage(message)) wake = true
      if (message.urgent || message.sender === PERSON) immediate = true
      if (message.kind === 'message' && message.needsReply) needsReply = true
      const relation = this.relation(recipient, message)
      relations.add(relation)
      items.push(this.frameItem(recipient, message, relation, down && row.deliveredAt === null, row.lastError === 'maybe_repeated'))
    }
    const calls = this.opts.calls?.(recipient) ?? mailCalls(2, 'plain')
    const frame = buildMessageFrame(items, calls)
    return {
      text: frame.text,
      messageIds: frame.shown,
      inline: frame.inline,
      pointed: frame.shown.filter((id) => !frame.inline.includes(id)),
      wake,
      immediate,
      needsReply,
      line: items.length === 0 ? '' : deliveryLine(items.length, relations),
      quieted,
      heldBack,
      workMessage,
      asker: turnStarts && toOrchestrator ? picked : null,
    }
  }

  /** The delivery began a turn for `recipient` (it called `MailTurns.begin`): the rows it delivered were delivered in that turn */
  turnStarted(recipient: string, messageIds: readonly string[], turnSeq: number): void {
    this.run(() => this.records.markTurn(recipient, messageIds, turnSeq))
  }

  /**
   * What a host that died left half done (§7.6.5 of the old plan): a delivery whose attempt was written and whose acceptance was not. It is not sent
   * again on its own, since an inline task the tool took just before the host died would start the same work twice: it is held `uncertain`, for the
   * person to resend or dismiss. News and Centralu's own words go again, and their next frame says it may be a repeat
   */
  reconcileInterrupted(): { recipient: string; resent: number; held: number }[] {
    const byRecipient = new Map<string, string[]>()
    for (const r of this.records.interrupted()) byRecipient.set(r.recipient, [...(byRecipient.get(r.recipient) ?? []), r.messageId])
    return this.run(() => [...byRecipient].map(([recipient, ids]) => ({ recipient, ...this.settleUncertain(recipient, ids) })))
  }

  /** A wake the tool failed after the wait for it ran out: the rows it delivered at `deliveredAt` are undelivered again, and treated as a restart's */
  deliveryFailedLate(recipient: string, ids: readonly string[], deliveredAt: number): { resent: number; held: number } {
    return this.run(() => this.settleUncertain(recipient, this.records.undeliver(recipient, ids, deliveredAt)))
  }

  /**
   * The person says send it: mail held `uncertain` or `failed` goes now, and from the person's window a row held for a session's budget. Mail held for
   * the project's trust or the depth has its own way out. The delivery passes `budget` (a session's Resume), which the drain judges again
   */
  resendHeld(recipient: string, ids: readonly string[], why: readonly ('uncertain' | 'failed' | 'budget')[] = ['uncertain', 'failed']): number {
    return this.run(() => {
      const released = this.heldBy(recipient, ids, why)
      const n = this.records.release(recipient, released, this.now())
      // The delivery hears of it (it goes now), and so does the Inbox (it is no longer held)
      for (const id of released) {
        const m = this.records.message(id)
        if (m) this.changed(m, [recipient, PERSON])
      }
      return n
    })
  }

  /** The delivery held these rows for the person (a guard, the one hold, a quiet wake that could not go): written, and the Inbox is told */
  hold(recipient: string, held: readonly { messageId: string; reason: string }[]): void {
    if (held.length === 0) return
    this.run(() => {
      for (const reason of new Set(held.map((h) => h.reason))) this.records.hold(recipient, held.filter((h) => h.reason === reason).map((h) => h.messageId), reason)
      for (const h of held) {
        const m = this.records.message(h.messageId)
        if (m) this.changed(m, [PERSON])
      }
    })
  }

  /** Something the Inbox shows changed that is no message (the question about sleeping sessions): the listeners hear an empty change for the person */
  announce(rootId = ''): void {
    this.listeners.emit({ messageId: '', rootId, recipients: [PERSON] })
  }

  /**
   * The person says never: held mail is left undelivered, and not held against anyone. `uncertain` and `failed` by default; the person's window may
   * dismiss any hold it shows, and a dismissed answer leaves the question it answers open (D8)
   */
  dismissHeld(recipient: string, ids: readonly string[], why: readonly string[] = ['uncertain', 'failed']): number {
    return this.run(() => {
      const dismissed = this.heldBy(recipient, ids, why)
      for (const id of dismissed) this.records.answerDropped(id)
      const n = this.records.dismiss(recipient, dismissed)
      // Never delivered now, so nothing waits on it: its sender's wait for an answer or a report ends
      for (const id of dismissed) this.records.settle(id, recipient, 'withdrawn', this.now())
      for (const id of dismissed) {
        const m = this.records.message(id)
        if (m) this.changed(m, [PERSON])
      }
      return n
    })
  }

  // ── Trust and the depth hold (§7.4, §7.5) ──

  /**
   * The person dismissed what an untrusted project sent out (or the project was deleted): its `policy` rows are deleted, with their messages when no row
   * is left, the questions answers among them held open again (D8), and the refused records of its delegations go. Each sender is told once (S13)
   */
  dismissProject(projectId: string, label = this.reach.projectLabel(projectId)): { rows: number; senders: string[] } {
    return this.run(() => {
      const now = this.now()
      const held = this.records.heldPolicy().filter((h) => h.senderProject === projectId)
      // One message to several recipients is held in several rows: it is dropped, and counted, once
      const messages = [...new Set(held.map((h) => h.row.messageId))].flatMap((id) => this.records.message(id) ?? [])
      for (const m of messages) if (m.replyTo !== null) this.records.answerDropped(m.id)
      const rows = this.records.deleteHeld(held.map((h) => h.row))
      this.records.deleteRows(this.records.refusedRecords(projectId).map((p) => p.row))
      const dropped = new Map<string, string[]>()
      for (const m of messages) dropped.set(m.sender, [...(dropped.get(m.sender) ?? []), m.id])
      for (const [sender, ids] of dropped) {
        if (parseAddress(sender)?.kind !== 'session') continue
        this.centralu(sender, { kind: 'notice', body: droppedText(ids, label), facts: {}, dedupeKey: `dropped:${sender}:${projectId}:${now}` })
      }
      for (const m of messages) this.changed(m, [PERSON])
      return { rows, senders: [...dropped.keys()] }
    })
  }

  /**
   * The person trusted `projectId` (§7.4): the rows held `policy` for it go, in the order they were sent, the questions they answer are answered, and each
   * caller whose delegations were refused for it gets one notice (S16) and loses the records. Returns the recipients for the delivery to poke
   */
  trustChanged(projectId: string): string[] {
    return this.run(() => {
      const now = this.now()
      const pokes = new Set<string>()
      for (const { row, senderProject } of this.records.heldPolicy()) {
        const m = senderProject === projectId ? this.records.message(row.messageId) : undefined
        if (!m) continue
        // Trusted now, the row may still be held for the depth: then it stays held, its question stays open and its asker is told why (§7.4)
        const why = this.reach.holdFor(m, row.recipient)
        // Let go, an unread row is delivered as the mail it is, also one an older build told of quietly while it held it (§6.3)
        if (why === null) this.records.letGo(row.recipient, [m.id])
        else this.records.hold(row.recipient, [m.id], why)
        const question = m.replyTo === null ? undefined : this.records.message(m.replyTo)
        if (why === null) {
          if (question) this.records.settle(question.id, m.sender, 'answered', now, m.id)
          pokes.add(row.recipient)
        } else if (question) this.answerHeld(question, m, why)
      }
      const refused = this.records.refusedRecords(projectId)
      const byCaller = new Map<string, MailRow[]>()
      for (const p of refused) byCaller.set(p.row.recipient, [...(byCaller.get(p.row.recipient) ?? []), p.message])
      for (const [caller, records] of byCaller) {
        const calls = records.flatMap((m) => (m.facts.refused ? [`${m.facts.refused.tool} to ${m.facts.refused.target} ("${m.facts.refused.firstLine}")`] : []))
        this.centralu(caller, {
          kind: 'notice',
          body: trustedText(this.reach.projectLabel(projectId), calls),
          facts: { trusted: { project: projectId, refused: calls.slice(0, 10) } },
          dedupeKey: `trusted:${caller}:${projectId}:${now}`,
        })
        pokes.add(caller)
      }
      this.records.deleteRows(refused.map((p) => p.row))
      return [...pokes]
    })
  }

  /** The orchestrator's turn on `asker`'s requests ended (§7.6): the requests that turn carried are settled `reported`. Returns how many */
  requestTurnEnded(orchestrator: string, asker: string, turnSeq: number): number {
    return this.run(() => {
      let n = 0
      for (const row of this.records.watchedTo(orchestrator)) {
        const m = row.turnSeq === turnSeq && this.records.message(row.messageId)
        if (m && m.sender === asker && this.isRequest(m, orchestrator)) n += this.records.settle(m.id, orchestrator, 'reported', this.now())
      }
      return n
    })
  }

  /** The person's Resume on a message held `loop` (D13): its rows are let go and never held `loop` again, and the question it answers is answered (D8). Returns the rows */
  resumeDepth(messageId: string): number {
    return this.run(() => {
      const m = this.records.message(messageId)
      const rows = m ? this.records.recipients(messageId).filter((r) => r.held === 'loop') : []
      // Let go as unread mail to deliver, also a row an older build told of quietly while it held it (§6.3), and never held again
      for (const r of rows) {
        this.records.letGo(r.recipient, [messageId])
        this.records.hold(r.recipient, [messageId], 'released')
      }
      if (m?.replyTo && rows.length > 0) this.records.settle(m.replyTo, m.sender, 'answered', this.now(), m.id)
      // The delivery hears of it (it goes now), and so does the Inbox (it is no longer held)
      if (m && rows.length > 0) this.changed(m, [...rows.map((r) => r.recipient), PERSON])
      return rows.length
    })
  }

  /** One line for the person's guidance per project with mail held for its trust or delegations refused (§7.4) */
  heldByProject(): { projectId: string; count: number; refused: number; recipients: string[] }[] {
    const byProject = new Map<string, { count: number; refused: number; recipients: Set<string> }>()
    const entry = (projectId: string) => {
      const kept = byProject.get(projectId) ?? { count: 0, refused: 0, recipients: new Set<string>() }
      byProject.set(projectId, kept)
      return kept
    }
    for (const { row, senderProject } of this.records.heldPolicy()) {
      if (senderProject === null) continue
      const e = entry(senderProject)
      e.count++
      e.recipients.add(row.recipient)
    }
    for (const { message } of this.records.refusedRecords()) {
      const e = message.facts.refused ? entry(message.facts.refused.projectId) : undefined
      if (e) {
        e.refused++
        e.recipients.add(message.facts.refused?.target ?? '')
      }
    }
    return [...byProject].map(([projectId, e]) => ({ projectId, count: e.count, refused: e.refused, recipients: [...e.recipients] })).sort((a, b) => a.projectId.localeCompare(b.projectId))
  }

  // ── Parties that go, parties that take over (§7.7) ──

  /** A session went to the trash or was deleted: its watched rows are `gone`, its own watched messages `withdrawn`, and each sender whose needsReply message it leaves is told once (D25) */
  partyGone(address: string): void {
    this.run(() => {
      const now = this.now()
      const senders = new Set<string>()
      for (const row of this.records.watchedTo(address)) {
        // Mail sent to the orchestrator's role follows the role, not the session that held it (D15): `roleMoved` gives it to the next one
        if (row.via === 'orchestrator') continue
        const m = this.records.message(row.messageId)
        this.records.settle(row.messageId, address, 'gone', now)
        if (m?.needsReply && this.records.markReleased(row.messageId, address, now, 'gone')) senders.add(m.sender)
      }
      for (const row of this.records.watchedFrom(address)) this.records.settle(row.messageId, row.recipient, 'withdrawn', now)
      for (const sender of senders) this.tellUnanswered(sender)
    })
  }

  /** The handoff (§7.7): `from`'s unsettled watched rows and unread mail move to `to`; the successor is told of each. Called inside the children's move */
  handOver(from: string, to: string, scope: HandOverScope): HandedOverMessage[] {
    return this.run(() => {
      const plan = this.handOverPreview(from, to, scope)
      // The heir is told of what comes to it, not of a row it already had
      const fresh = plan.filter((p) => this.records.recipient(p.messageId, to) === undefined)
      this.records.moveRows(from, to, scope)
      this.movedNotice(to, fresh.map((p) => p.messageId))
      return plan
    })
  }

  /** What `handOver` would move, read only: each message by id and the first line of its words, for the handoff note to quote */
  handOverPreview(from: string, to: string, scope: HandOverScope = 'all'): HandedOverMessage[] {
    return this.records.movable(from, to, scope).flatMap((id) => {
      const m = this.records.message(id)
      return m ? [{ messageId: id, firstLine: firstLineOf(m.body, 160), kind: m.kind, unread: this.records.recipient(id, from)?.readAt === null }] : []
    })
  }

  /** The orchestrator's role is `to`'s (D15): rows sent to the role that another session held are delivered afresh, read or not, and the new orchestrator is told of each. Returns how many */
  roleMoved(to: string): number {
    return this.run(() => {
      const ids = this.records.moveRole(to)
      this.movedNotice(to, ids)
      return ids.length
    })
  }

  sweep(): { messages: number } {
    return this.records.sweep(this.now())
  }

  // ── Inside ──

  /** A message stored for its recipients; the change is queued for the listeners. A missing reply target is the sender's `unknown_message` */
  private put(mail: Partial<NewMail> & Pick<NewMail, 'sender' | 'kind' | 'body' | 'origin'>, rows: NewRecipient[]): StoredMail {
    const now = this.now()
    let stored: StoredMail
    try {
      stored = this.records.insert(
        { id: messageIdOf(this.opts.hostId, this.ulids.next(now)), senderProject: this.reach.projectOf(mail.sender), needsReply: false, replyTo: null, causeId: null, depth: 0, urgent: false, facts: {}, dedupeKey: null, legacyThread: null, createdAt: now, ...mail },
        rows,
      )
    } catch (e) {
      if (e instanceof MailTargetMissing) throw refuse('unknown_message', REFUSAL_TEXT.unknown_message(e.replyTo))
      throw e
    }
    if (!stored.duplicate) this.changed(stored, rows.map((r) => r.recipient))
    return stored
  }

  private changed(m: Pick<MailRow, 'id' | 'rootId'>, recipients: readonly string[]): void {
    this.queued.push({ messageId: m.id, rootId: m.rootId, recipients: [...recipients] })
  }

  private row(recipient: string, over: Partial<NewRecipient> & Pick<NewRecipient, 'dueAt'>): NewRecipient {
    return { recipient, recipientProject: this.reach.projectOf(recipient), ...over }
  }

  /** A message from Centralu to `recipient`: not a sender's, so no guard applies. `delivered` writes it already delivered and read */
  private centralu(recipient: string, m: { kind: MailKind; body: string; facts: MailFacts; dedupeKey: string; replyTo?: string; delivered?: boolean }): StoredMail {
    const now = this.now()
    return this.put(
      { sender: CENTRALU, kind: m.kind, body: this.checkText('centralu', m.body), facts: m.facts, dedupeKey: m.dedupeKey, replyTo: m.replyTo ?? null, origin: 'centralu' },
      [this.row(recipient, { dueAt: dueAt(now, false, false), ...(m.delivered ? { deliveredAt: now, readAt: now } : {}) })],
    )
  }

  private checkText(cls: SenderClass, text: unknown): string {
    if (typeof text !== 'string') throw refuse('bad_value', 'a body is text')
    if (text.trim() === '') throw refuse('empty', 'a post says something')
    if (text.length > bodyLimit(cls)) throw refuse('too_long', `a body from ${cls === 'app' ? 'an app' : 'this sender'} is at most ${bodyLimit(cls)} characters`)
    return text
  }

  private refusalText(why: ReturnType<MailReach['mayWrite']> & string, to: string): string {
    const text: Record<string, string | undefined> = {
      gone: REFUSAL_TEXT.gone(to),
      no_mailbox: REFUSAL_TEXT.no_mailbox(),
      elsewhere: REFUSAL_TEXT.elsewhere(to),
      orchestrator_asks: REFUSAL_TEXT.orchestrator_asks(),
      not_allowed: REFUSAL_TEXT.not_allowed(),
    }
    return text[why] ?? why
  }

  /** The message `id` as `reader` may read it (§5.5): one it sent, or one it is a recipient of and is not held from it. Anything else is not there for it */
  private readable(reader: string, id: string): MailRow {
    const m = this.records.message(id)
    const row = m && m.sender !== reader ? this.records.recipient(id, reader) : undefined
    if (!m || (m.sender !== reader && (!row || isHidden(row)))) throw refuse('unknown_message', REFUSAL_TEXT.unknown_message(id))
    return m
  }

  /** Whether `target` is a clarification of a task `owner` gave, and the answer goes to the one who asked (§9.7) */
  private answersClarification(owner: string, target: MailRow, to: readonly string[]): boolean {
    const task = typeof target.facts.clarifies === 'string' ? this.records.message(target.facts.clarifies) : undefined
    return task?.kind === 'task' && task.sender === owner && to.length === 1 && to[0] === target.sender
  }

  /**
   * Whether a message is a request to the orchestrator (§7.6): from a session to the orchestrator, unless it answers a `needsReply` message or a task the
   * orchestrator sent that session, or is a clarification. Only requests are counted by `ask_rate` and raise the person's cards
   */
  private isRequest(m: Pick<MailRow, 'sender' | 'kind' | 'replyTo' | 'facts'>, recipient: string): boolean {
    if ((m.kind !== 'message' && m.kind !== 'task') || m.sender === recipient || !this.reach.isOrchestrator(recipient)) return false
    if (parseAddress(m.sender)?.kind !== 'session' || typeof m.facts.clarifies === 'string') return false
    const target = m.replyTo === null ? undefined : this.records.message(m.replyTo)
    return !(target && target.sender === recipient && (target.needsReply || target.kind === 'task'))
  }

  /** The message that started `sender`'s turn, when a message did (not the person, not the session itself): what a send in that turn is caused by (§8.2 step 6) */
  private causeOf(sender: string): string | null {
    const turn = this.opts.turn?.(sender) ?? null
    return turn !== null && turn.by !== 'person' && turn.by !== 'cli' ? turn.starter : null
  }

  /** The guards of a send, over the store so a restart does not reset them (§7.5) */
  private guards(sender: string, cls: SenderClass, to: readonly string[], text: string, target: MailRow | undefined, requests: readonly boolean[], now: number): void {
    for (const r of to) {
      if ((cls === 'session' || cls === 'app') && this.records.sameBody(sender, r, text, now - REPEAT_WINDOW_MS)) throw refuse('repeat', REFUSAL_TEXT.repeat(this.reach.labelOf(r)))
    }
    const limit = postsPerMinute(cls)
    if (limit !== Infinity && this.records.postsSince(sender, now - MINUTE_MS) >= limit) {
      throw refuse('rate_limited', `at most ${limit} posts a minute from ${cls === 'app' ? 'an app' : 'a session'}: wait a minute`)
    }
    for (const [i, r] of to.entries()) {
      if (target === undefined && cls === 'session' && parseAddress(r)?.kind === 'session' && this.records.newSince(sender, r, now - HOUR_MS) >= PAIR_NEW_PER_HOUR) {
        throw refuse('pair_rate', REFUSAL_TEXT.pair_rate(this.reach.labelOf(r)))
      }
      if (requests[i]) {
        if (this.records.requestsSince(this.reach.askGroupMembers(sender), r, now - HOUR_MS) >= ASKS_PER_HOUR) throw refuse('ask_rate', REFUSAL_TEXT.ask_rate())
      }
    }
  }

  /** The messages a reminder or a notice to a sender is about, for the depth: a follow-up adds none (D9) */
  private aboutFollowUp(cause: MailRow): MailRow[] {
    const ids = cause.kind !== 'notice' ? [] : (cause.facts.of ?? cause.facts.unanswered?.map((u) => u.id) ?? [])
    return ids.flatMap((id) => this.records.message(id) ?? [])
  }

  /** The answer `answer` to `question` is held for the person: the question stays open (it keeps the answer's id) and its asker is told once, quietly (S14) */
  private answerHeld(question: MailRow, answer: MailRow, why: HoldReason): void {
    this.records.answerHeld(question.id, answer.sender, answer.id)
    if (parseAddress(question.sender)?.kind !== 'session') return
    const reason = why === 'policy' ? `${this.reach.projectLabel(answer.senderProject ?? '')} is not trusted` : `it is the ${answer.depth}th hop in a row`
    this.centralu(question.sender, {
      kind: 'notice',
      body: `${this.reach.labelOf(answer.sender)} answered your ${question.id} with ${answer.id}, and the answer is held for the person (${reason}). It reaches you if the person lets it through; until then Centralu does not remind ${this.reach.labelOf(answer.sender)} of it.`,
      facts: { quiet: true, answerHeld: { question: question.id, answer: answer.id } },
      dedupeKey: `answer_held:${question.sender}:${answer.id}:${why}`,
    })
  }

  /** The sender's released and untold rows, gathered in one notice (D25, S3); the row's `told_at` is set so it is listed once. The person is not told */
  private tellUnanswered(sender: string): void {
    const rows = this.records.releasedUntold(sender)
    if (rows.length === 0 || parseAddress(sender)?.kind !== 'session') return
    const unanswered = rows.map((r) => ({ id: r.messageId, recipient: r.recipient, why: r.releasedWhy ?? ('gone' as const) }))
    this.centralu(sender, {
      kind: 'notice',
      body: unansweredText(unanswered.map((u) => ({ ...u, name: this.reach.labelOf(u.recipient) }))),
      facts: { unanswered },
      dedupeKey: `unanswered:${sender}:${hash16(rows.map((r) => `${r.messageId}/${r.recipient}`).sort())}`,
    })
    this.records.markTold(rows, this.now())
  }

  /** Rows came to `to` from another holder (a handoff, the role's move): one quiet notice for the move, so it knows why the messages are there (key `handover:`) */
  private movedNotice(to: string, messageIds: readonly string[]): void {
    if (messageIds.length === 0 || parseAddress(to)?.kind !== 'session') return
    this.centralu(to, {
      kind: 'notice',
      body: messageIds.length === 1 ? 'A message addressed to the previous holder was moved to you.' : `${messageIds.length} messages addressed to the previous holder were moved to you.`,
      facts: { quiet: true, handedOver: true },
      dedupeKey: `handover:${to}:${hash16(messageIds)}`,
    })
  }

  /** A reminder whose messages are all settled (or gone) has nothing to say (§8.2 step 1) */
  private reminderSettled(m: MailRow, recipient: string): boolean {
    return (
      m.kind === 'notice' &&
      m.facts.reminder !== undefined &&
      (m.facts.of ?? []).every((id) => {
        const row = this.records.recipient(id, recipient)
        return row === undefined || row.settled !== null
      })
    )
  }

  /** The task this delivery's report hands on from (§8.2 step 3): the report is of a task the recipient gave while it worked on one still open */
  private handedOnFrom(m: MailRow, recipient: string): string | undefined {
    const task = m.kind === 'report' && m.replyTo !== null ? this.records.message(m.replyTo) : undefined
    const cause = task?.causeId ? this.records.message(task.causeId) : undefined
    return cause?.kind === 'task' && this.records.recipient(cause.id, recipient)?.settled === null ? cause.id : undefined
  }

  /** Mail whose delivery may or may not have gone: news and Centralu's own words go again, the rest is held `uncertain` for the person */
  private settleUncertain(recipient: string, ids: readonly string[]): { resent: number; held: number } {
    const messages = ids.flatMap((id) => this.records.message(id) ?? [])
    const again = messages.filter((m) => m.kind === 'notice' || m.sender === CENTRALU).map((m) => m.id)
    const unsure = messages.filter((m) => !again.includes(m.id)).map((m) => m.id)
    if (again.length > 0) this.records.markMaybeRepeated(recipient, again, this.now())
    if (unsure.length > 0) this.records.markUncertain(recipient, unsure)
    // What goes again is the delivery's to look at; what is held, the Inbox's
    for (const m of messages) this.changed(m, again.includes(m.id) ? [recipient, PERSON] : [PERSON])
    return { resent: again.length, held: unsure.length }
  }

  /** The ids of those of `ids` that `recipient`'s rows hold for one of `why` */
  private heldBy(recipient: string, ids: readonly string[], why: readonly string[]): string[] {
    return ids.filter((id) => why.includes(this.records.recipient(id, recipient)?.held ?? ''))
  }

  // ── What the reader sees ──

  /** Centralu's word for how the sender stands to the receiver (§8.3). Never a name another party wrote */
  private relation(recipient: string, m: MailRow): string {
    const kind = parseAddress(m.sender)?.kind
    if (kind === 'centralu') return 'Centralu'
    if (kind === 'person') return 'the person'
    if (kind === 'app') return 'an app you called'
    if (this.isRequest(m, recipient)) return 'a session asking you for something'
    if (this.reach.parentOf(recipient) === m.sender) return 'your parent session'
    if (this.reach.parentOf(m.sender) === recipient) return 'your child session'
    const target = m.replyTo === null ? undefined : this.records.message(m.replyTo)
    if (target?.kind === 'task' && target.sender === recipient) return 'the session you gave this work to'
    if (this.reach.isOrchestrator(m.sender)) return 'the orchestrator'
    const mine = this.reach.projectOf(recipient)
    return mine !== null && mine === this.reach.projectOf(m.sender) ? 'a session of your project' : 'a session of another project'
  }

  /** A message as `reader` sees it: whole, or a phantom without its words (§5.5), or a request whose words are for its asker's turn only (§7.6) */
  private item(m: MailRow, reader: string, asker: string | null): ReadItem {
    const row = this.records.recipient(m.id, reader) ?? null
    const relation = this.relation(reader, m)
    if (m.sender !== reader && (!row || isHidden(row))) return { message: { ...m, body: '', facts: {} }, row: null, relation, phantom: row ? 'held' : 'not_sent' }
    if (this.isRequest(m, reader) && m.sender !== asker) return { message: { ...m, body: '' }, row, relation, withheld: true }
    return { message: m, row, relation }
  }

  /** The line for an earlier message that is no longer kept (S5) */
  private gone(id: string): ReadItem {
    const stub: MailRow = { id, sender: '', senderProject: null, kind: 'notice', needsReply: false, replyTo: null, rootId: id, causeId: null, depth: 0, urgent: false, body: '', facts: {}, dedupeKey: null, origin: null, legacyThread: null, createdAt: 0 }
    return { message: stub, row: null, relation: '', phantom: 'gone' }
  }

  private frameItem(recipient: string, m: MailRow, relation: string, inline: boolean, maybeRepeated: boolean): MessageFrameItem {
    const about = asObj(m.facts.about).session
    const answered = m.replyTo === null ? undefined : this.records.message(m.replyTo)
    return {
      messageId: m.id,
      kind: m.kind,
      from: m.sender,
      relation,
      ...(m.kind === 'message' ? { needsReply: m.needsReply } : {}),
      ...(answered?.sender === recipient ? { answers: answered.id } : {}),
      ...(typeof m.facts.clarifies === 'string' ? { clarifies: m.facts.clarifies } : {}),
      ...(typeof about === 'string' && parseAddress(about) ? { about } : {}),
      ...(m.facts.outcome ? { outcome: m.facts.outcome } : {}),
      ...(m.facts.error ? { error: m.facts.error } : {}),
      ...(m.facts.reason ? { reason: m.facts.reason } : {}),
      ...(m.facts.paused !== undefined ? { paused: m.facts.paused } : {}),
      ...(m.facts.waitingOn !== undefined && m.facts.waitingOn > 0 ? { waitingOn: m.facts.waitingOn } : {}),
      ...(m.facts.personNote === true ? { personNote: true } : {}),
      ...(maybeRepeated ? { maybeRepeated: true } : {}),
      ...(inline ? { inline: m.body } : {}),
    }
  }
}

/** A row the reader was not told of (held by the one hold or the depth): its message reads as a phantom (§5.5) */
/** The dedupe key of a request that cites the person's message `seq` of its sender's conversation: one use (`UNIQUE(sender, dedupe_key)`) */
const citeKey = (seq: number): string => `cite:${seq}`

const isHidden = (row: RecipientRow): boolean => (HIDDEN_HOLDS as readonly string[]).includes(row.held ?? '')

/** The first 16 hex digits of the sha256 of the parts: the stable part of a Centralu dedupe key (§6.5) */
function hash16(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16)
}

/** The compact line the conversation keeps of a delivery: how many, from whom, in Centralu's words and with no name another party wrote */
function deliveryLine(messages: number, relations: ReadonlySet<string>): string {
  return `✉ ${messages} ${messages === 1 ? 'message' : 'messages'}, from ${[...relations].join(', ')}`
}

const WHY_WORDS: Record<ReleaseWhy, string> = {
  reminders: 'it was reminded twice and has not answered',
  waited: 'it has not answered in 2 hours',
  working: 'it is still working on its own work after 2 hours',
  waiting: 'it is still waiting on another session or on the person after 2 hours',
  stopped: 'the person stopped that session',
  error: 'that session stopped with an error',
  gone: 'that session is gone',
}

/** S3: the notice to a sender whose messages are no longer watched, gathered. `name` is what the sender calls the receiver */
function unansweredText(rows: readonly { id: string; recipient: string; why: ReleaseWhy | null; name: string }[]): string {
  const lines = rows.map((r) => `- ${r.id} to ${r.name} (${r.recipient}): ${r.why ? WHY_WORDS[r.why] : WHY_WORDS.gone}.`)
  const later = rows.some((r) => r.why === 'working' || r.why === 'waiting')
  return [
    `${rows.length} of your messages are no longer watched, and Centralu will not remind their receivers again:`,
    ...lines,
    ...(later ? ['Those still working or waiting may answer later; the answer reaches you as mail.'] : []),
    'For the others, go on without the answers, ask another session, or ask the person. Next time, send needsReply=false when you need no answer.',
  ].join('\n')
}

/** S13: the person dismissed what a sender had waiting for a project to be trusted */
function droppedText(ids: readonly string[], project: string): string {
  const shown = ids.slice(0, 10).join(', ') + (ids.length > 10 ? `, and ${ids.length - 10} more` : '')
  return `The person dismissed ${ids.length} of your messages that were waiting for project ${project} to be trusted (${shown}). They were not delivered and will not be.`
}

/** S16: the project is trusted, and these refused calls may be given again */
function trustedText(project: string, calls: readonly string[]): string {
  return `${project} is trusted now. The calls refused for it can be given again: ${calls.slice(0, 10).join(', ')}${calls.length > 10 ? `, and ${calls.length - 10} more` : ''}`
}

