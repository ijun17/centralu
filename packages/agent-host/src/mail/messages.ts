import { durationText } from '../timing.js'
import { createListeners } from '@cc/common'
import { errorMessage, oneLineText, type MailChoices } from '@cc/protocol'
import { asObj } from '../json-value.js'
import {
  HIDDEN_HOLDS,
  LINK_HOLD,
  MailTargetMissing,
  type MailFacts,
  type MailKind,
  type MailRow,
  type MailboxRecords,
  type NewMail,
  type NewRecipient,
  type RecipientRow,
  type StoredMail,
} from '../dev-services/store/mailbox.js'
import { CENTRALU, PERSON, isPerson, parseAddress, senderKind, sessionAddress } from './address.js'
import { buildMessageFrame, mailLine, reminderText, type ListedMail, type MessageCalls, type MessageFrameItem } from './frame.js'
import { UlidMaker, messageIdOf } from './ids.js'
import type { TurnReport } from './turn-report.js'
import { answerAtRest, type LastResponse } from './last-response.js'
import type { MailReach } from './reach.js'
import { HeldMail } from './held-mail.js'
import { Handoffs } from './handoff.js'
import { sendGuards } from './send-guards.js'
import { StopNotices, type StopNoticeOptions } from './stop-notices.js'
import {
  MAX_RECIPIENTS,
  replyAnswers,
  hash16,
  MINUTE_MS,
  READ_CHAIN,
  READ_CHARS,
  READ_ITEMS,
  REMINDER,
  REFUSAL_TEXT,
  bodyLimit,
  cutTask,
  dueAt,
  flowsDownTo,
  forPersonOf,
  isQuietNote,
  pickWork,
  quietAnswer,
  refuse,
  tooLongText,
  wakesMessage,
  type SenderClass,
} from './rules.js'
import type { TurnNow, TurnRead } from './turns.js'

/*
 * The message service (#1684, docs/plans/mailbox.md §16 M2): mail without threads. It stores and answers over `MailboxRecords` and asks `MailReach`
 * who may write to whom and what is held. It delivers nothing and wakes nobody, never calls `MailTurns` or the manager (what it needs of a session's
 * turn comes through the `turn` option).
 *
 * **Who is calling is an argument, never a field of the input**, as `MailService`: a tool that spreads its arguments cannot name `person` or `centralu`.
 */

/** Why a row is left out of a delivery and kept for the person: the one hold (§7.4). Mail is never held for how much of it there is (#2014) */
export type HoldReason = 'policy'

/** What a send names: resolved addresses (the tool resolves names), the text, and the flags a sender may set */
export type SendInput = {
  /** 1 to 10 addresses. Empty with `replyTo`: the sender of the message answered */
  to: readonly string[]
  text: string
  /** Whether it waits for a reply, given only when decided elsewhere (a peer across a link, the person's window); else `waitsForReply` decides */
  needsReply?: boolean
  /** The sender needs no answer (the tool's `kind: "note"`) */
  note?: true
  replyTo?: string
  /** A reply the sender marked as the answer to the task it replies to (the tool's `kind: "answer"`): only such a reply settles a task (`replyAnswers`) */
  answer?: boolean
  urgent?: boolean
  /** Per recipient: `assistant` when the sender named the role (D15) */
  via?: readonly (string | null)[]
  /** A request to the Assistant cites the person's newest message in the sender's conversation as their word for it (docs/plans/cited-requests.md) */
  cite?: boolean
  /** The id another host picked for a message it sends here (#2067 review, `MailAcross`); a new one of this host's when absent */
  id?: string
  /** A session's question to the person only: the answers it offers to pick from (#1630) */
  choices?: MailChoices
  /** The person's answer is one of the choices of the question it answers, pressed in the window (`mail.reply` with `answers`); recorded in `facts.picked` (#1630) */
  picked?: true
  /** The subject a `send` gives the chain it starts (#2229): kept on the chain's first message only, so a reply never renames it */
  subject?: string
  /** The sender marked it as a question (`facts.question`, #2348): kept only on a message that needs a reply */
  question?: true
}
/**
 * Whether a session's message waits for a reply (D3, #2357), the one rule: a reply, or a message to the giver of the task its turn is for (a
 * clarification, `MessageService.clarifies`), only when marked a question (`kind: "question"` or choices); any other new message unless it is a note
 */
export function waitsForReply(m: { question: boolean; note: boolean; reply: boolean; clarifies: boolean }): boolean {
  return m.reply || m.clarifies ? m.question : !m.note
}

/**
 * `answered`: the message the send replies to. `answers`: whether it answers it (`replyAnswers`).
 * `asWork`: an answer to a clarification, stored as a task (§9.7). `cited`: the person's message a request to the Assistant cites, checked.
 * `notCited`: why a citation the request asked for did not pass the check, so the Assistant reads the request as the session's own words
 */
export type SendResult = {
  message: MailRow
  held: { recipient: string; why: HoldReason }[]
  answered: string | null
  answers: boolean
  quiet: boolean
  asWork: boolean
  cited?: { seq: number; at: number }
  notCited?: string
}

/** How old the person's message a request cites may be (owner, 2026-11-03) */
export const CITE_MS = 30 * 60_000

export type DelegationOrigin = 'start_agent' | 'agent_session' | 'send_to_session' | 'create_session' | 'ask_project' | 'script'
/**
 * `note`: a send that asks for nothing back (`send_to_session` without `reportBack`, #2258): a message that needs no reply, given as the task would be.
 * `across`: work a hub gave over its link (#1948 step 6), written under the id the hub picked; `forPerson`, that hub said its Assistant gave it, so it acts for
 * the person here as the Assistant's own does (`forPersonOf`). Only a hub's `host.mail` on its own link sets it (`MailAcross.fromHub`). `depth`: work from
 * another computer's session, which the session here counts that agent depth for while it works on it (`MailInput.depth`, #838)
 */
export type TaskInput = { text: string; origin: DelegationOrigin | 'person' | 'mail'; delivered: boolean; replyTo?: string; fromScript?: { credential: string }; note?: true; across?: { id: string; forPerson?: true }; depth?: number }

/** A session's turn, as `MailTurns.current` gives it (§8.2 step 6) */
export type { TurnNow }

export type ReportWritten = { message: MailRow; duplicate: boolean; first: boolean } | { settledAlready: true }

/** `withheld`: a request to the Assistant whose words are shown only in the turn it starts (§7.6); the body is left out */
export type ReadItem = { message: MailRow; row: RecipientRow | null; relation: string; phantom?: 'not_sent' | 'gone' | 'held'; withheld?: true; forPerson?: 'task' | 'note' }
export type ReadView = { items: ReadItem[]; older: string | null; marked: number }
export type InboxView = {
  needReply: ReadItem[]
  unread: ReadItem[]
  waiting: { row: RecipientRow; message: MailRow }[]
  /** `loop`: a row an earlier build held for its turns, which waits for the person's Resume; `link`: mail across held while its link is down (`LINK_HOLD`) */
  held: { row: RecipientRow; message: MailRow; why: HoldReason | 'loop' | typeof LINK_HOLD }[]
}
/** Work given a session on another computer, as it crosses (`MailAcross.sendTask`) and its copy here keeps it */
export type TaskAcross = { origin: DelegationOrigin; note?: true; forPerson?: true; depth?: number }

export type DrainOptions = {
  /** Mail that is told of once more, delivered and still unread */
  again?: boolean
  /** Left out, and nothing is written about it */
  skip?: (message: MailRow, row: RecipientRow) => boolean
  /**
   * The mail joins the recipient's running turn (docs/plans/mailbox.md §10.6.2), tasks included (§10.6.3): a request to the Assistant, or a reminder
   * for its asker, is left for a turn of its own (one turn keeps one asker, turn-owned-by-no-one.md §4.2)
   */
  joining?: boolean
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
  /** The messages the line stands for, each with its chain (#2333): the ones the frame names, so the window can fold the line open to them, and the line counts them (`mailLine`) */
  listed: ListedMail[]
  heldBack: { messageId: string; reason: HoldReason }[]
  /** The task (or, for the Assistant, the first request of its asker) a turn this delivery starts is the work of, or null */
  workMessage: string | null
  /** For the Assistant, the session whose requests this delivery carries */
  asker: string | null
}

/** `arrived`: the message itself is new, not a change to one already stored (what the person's OS notification is raised for, #1630) */
export type MailChange = { messageId: string; rootId: string; recipients: string[]; arrived?: true }

/**
 * The choices of a question to the person (#1630), as stored: only a session's, only on a question, only to the person alone, 2 to 6 of them,
 * each one short line and no two the same. Anything else is refused, so a choice never reaches another session as a field it might take for Centralu's
 */
function checkedChoices(c: MailChoices, cls: SenderClass, to: readonly string[], question: boolean): MailChoices {
  if (cls !== 'session' || !question || to.length !== 1 || to[0] !== PERSON) throw refuse('field_not_allowed', 'choices go only with a question to the person (kind: "question", to: "person")')
  const choices = c.map((label) => oneLineText(label, CHOICE_CHARS))
  if (choices.length < 2 || choices.length > 6 || choices.includes('') || new Set(choices).size < choices.length) throw refuse('bad_value', 'a question offers 2 to 6 choices, none empty and no two the same')
  return choices
}
const CHOICE_CHARS = 80
/** How long a chain's subject is, stored (`mail.subject`) or made from its words (`MailPerson`) */
export const SUBJECT_CHARS = 80

export class MessageService {
  private readonly now: () => number
  private readonly ulids: UlidMaker
  private readonly listeners = createListeners<MailChange>((e) => console.error(`[mail] a listener failed: ${errorMessage(e)}`))
  private queued: MailChange[] = []
  private running = false
  /** Who hears that a session stopped or went (mailbox.md §10.6.1) */
  readonly stops: StopNotices
  /** Mail held for the person: the delivery's holds and the person's acts on them, trusting or dismissing a project (§7.4) */
  readonly holds: HeldMail
  /** A party that goes and one that takes over (§7.7): a handoff, the Assistant's role, and on a machine a hub's handoff */
  readonly handoffs: Handoffs

  constructor(
    private readonly records: MailboxRecords,
    private readonly reach: MailReach,
    private readonly opts: {
      hostId: string
      now?: () => number
      ids?: UlidMaker
      /** `MailTurns.current`: the session's turn now (§8.2 step 6) */
      turn?: (sessionAddress: string) => TurnNow | null
      /** How a wake names its calls to this session; the tool itself when absent (`buildMessageFrame`) */
      calls?: (sessionAddress: string) => MessageCalls
      /** The newest message the person typed in this session (`MessageRecords.newestPersonMessage`); none cites anything when absent */
      personSaid?: (sessionId: string) => { seq: number; ts: number } | null
      /** A question the session at that address asked was settled with no answer to it (`questionSettled`): the report it held is owed now (#2348) */
      questionSettled?: (sessionAddress: string) => void
      /** The live session that took over from a gone one by a handoff, by address, which a refusal to write to the gone one names; null when none */
      heirOf?: (sessionAddress: string) => string | null
    } & StopNoticeOptions,
  ) {
    this.now = opts.now ?? Date.now
    this.ulids = opts.ids ?? new UlidMaker()
    this.stops = new StopNotices({ ...opts, records, reach, now: this.now, run: (fn) => this.run(fn), notice: (to, n) => this.centralu(to, n) })
    this.holds = new HeldMail({ records, reach, now: this.now, run: (fn) => this.run(fn), notice: (to, n) => this.centralu(to, n), changed: (msg, to) => this.changed(msg, to) })
    this.handoffs = new Handoffs({
      records, reach, now: this.now, run: (fn) => this.run(fn), put: (m, rows) => this.put(m, rows), row: (to, over) => this.row(to, over),
      notice: (to, n) => this.notice(to, n), centralu: (to, n) => this.centralu(to, n), labelOf: (a) => this.labelOf(a), shownId: (a) => this.shownId(a), across: (a) => this.across(a),
    })
  }

  sessionAddress(sessionId: string): string {
    return sessionAddress(this.opts.hostId, sessionId)
  }

  /** A session's name, or its shown id while the host gives none (`MailReach.labelOf`) */
  labelOf(address: string): string {
    return this.reach.labelOf(address)
  }

  /** The id a tool prints for an address (`MailReach.shownId`) */
  shownId(address: string): string {
    return this.reach.shownId(address)
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
      merged.set(c.messageId, kept ? { ...kept, ...c, recipients: [...new Set([...kept.recipients, ...c.recipients])], ...(kept.arrived ? { arrived: true } : {}) } : c)
    }
    this.queued = []
    for (const c of merged.values()) this.listeners.emit(c)
    return result
  }

  // ── Writing ──

  /**
   * A session's or the person's message (D1 to D8). Guards: the post rate, `repeat`, `ask_rate` and the number of recipients. It records the
   * cause and a clarification's task, holds what the one hold holds, delivers an answer that needs nothing quietly, and settles
   * (or, when the answer is held, marks) the sender's own row on the message it answers. An answer to a clarification is stored as a task (§9.7)
   */
  send(sender: string, input: SendInput): SendResult {
    const from = parseAddress(sender)
    if (!from || from.kind === 'centralu') throw refuse('not_allowed', 'Centralu sends with notice and report')
    // A hub's person, as this machine names them, writes as the person (#1987)
    const cls: SenderClass = isPerson(sender) ? 'person' : from.kind
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
    // A clarification (§9.7) is no request
    const [only] = to
    const clarifies = cls === 'session' && only !== undefined && to.length === 1 ? this.clarifies(sender, only) : undefined
    // The owner's answer to one is work again: a task from the owner to the one who asked
    const asWork = target !== undefined && this.answersClarification(sender, target, to)
    const kind: MailKind = asWork ? 'task' : 'message'
    const needsReply =
      kind === 'message' && (input.needsReply ?? waitsForReply({ question: input.question === true, note: input.note === true, reply: target !== undefined, clarifies: clarifies !== undefined }))

    const requests = to.map((r) => this.isRequest({ sender, kind: 'message', replyTo: target?.id ?? null, facts: { clarifies } }, r))
    const choices = input.choices && checkedChoices(input.choices, cls, to, needsReply)
    for (const r of to) {
      const party = parseAddress(r)
      if (!party) throw refuse('bad_address', `Not a mail address: ${JSON.stringify(r)}`)
      if (r === sender) throw refuse('bad_value', 'a message is for someone else')
      const why = this.reach.mayWrite(sender, r)
      if (why !== null) throw refuse(why, this.refusalText(why, r))
    }

    // Before the transaction: a guard that refuses tells the person in a write of its own, which the refusal must not undo
    const now = this.now()
    sendGuards({ records: this.records, reach: this.reach, notice: (r, n) => this.notice(r, n) }, { sender, cls, to, text, requests }, now)
    return this.run(() => {
      // The person's message a request cites, checked here, in the send's transaction: evidence for the Assistant's judgement (docs/plans/cited-requests.md §3)
      const word = input.cite === true && requests.includes(true) && from.kind === 'session' ? this.personWord(sender, from.sessionId, now) : null
      const cited = word !== null && typeof word === 'object' ? word : undefined

      const urgent = input.urgent === true
      const senderProject = this.reach.projectOf(sender)
      // The hold judges what the message is to the one hold, whatever it is stored as
      const holds = to.map((r) => this.reach.holdFor({ kind: 'message', senderProject }, r))
      const quiet =
        kind === 'message' && target !== undefined && to.length === 1 && to[0] === target.sender &&
        quietAnswer({ kind, sender, needsReply, urgent }, target, { parent: this.reach.parentOf(target.sender), owesTask: this.records.newestTask(sender, target.sender) !== undefined, request: requests[0] === true })
      const facts: MailFacts = {
        ...(clarifies !== undefined ? { clarifies } : {}),
        ...(quiet ? { quiet: true } : {}),
        ...(cited ? { cites: cited } : {}),
        ...(input.picked && cls === 'person' ? { picked: true } : {}),
        ...(input.question && needsReply ? { question: true } : {}),
      }

      const stored = this.put(
        // The citation's one use: `UNIQUE(sender, dedupe_key)` (`personWord` looked first, in this transaction)
        { ...(input.id ? { id: input.id } : {}), sender, kind, body: text, needsReply, replyTo: target?.id ?? null, causeId, depth: 0, urgent, facts, choices: choices ?? null, subject: (!target && input.subject && oneLineText(input.subject, SUBJECT_CHARS)) || null, origin: cls === 'person' ? 'person' : cls === 'app' ? 'app' : 'mail', ...(cited ? { dedupeKey: citeKey(cited.seq) } : {}) },
        to.map((r, i) => this.row(r, { dueAt: dueAt(now, urgent, cls === 'person'), via: input.to.length > 0 ? (input.via?.[input.to.indexOf(r)] ?? null) : null, held: holds[i] ?? null })),
      )
      const held = to.flatMap((recipient, i) => (holds[i] ? [{ recipient, why: holds[i] }] : []))
      // What is held waits for the person: the Inbox lists it (§7.4), so it hears of it
      if (held.length > 0) this.changed(stored, [PERSON])

      // The sender's own row on what it answers (`replyAnswers`): settled, or while the answer is held, marked so it stays open until the person lets the
      // answer through (D8, `HeldMail.trustChanged`). A task so answered gets no last response
      const answers = target !== undefined && replyAnswers(target, { needsReply, answer: input.answer === true })
      if (target && answers && this.records.recipient(target.id, sender)) {
        if (held.length === 0) this.records.settle(target.id, sender, 'answered', now, stored.id)
        else this.answerHeld(target, stored)
      }
      return { message: stored, held, answered: target?.id ?? null, answers, quiet, asWork, ...(cited ? { cited } : {}), ...(typeof word === 'string' ? { notCited: word } : {}) }
    })
  }

  /** A new message id of this host's, for a message another host writes first (#2067 review, `MailAcross.send`) */
  mintId(): string {
    return messageIdOf(this.opts.hostId, this.ulids.next(this.now()))
  }

  /**
   * The sender's copy of a message another host took (#2067 item 2, docs/plans/linked-mail.md §6): written only once that
   * host answered with the message's id, under the same id, so a reply there and here names one message. Its one row is
   * the foreign recipient's, delivered at hand-over, so this host's delivery never tries it; the recipient's host pushes
   * what becomes of it (`MailboxRecords.mergeAcross`). No guard runs here: they ran where the message was written. An
   * answer settles the sender's own row on what it answers, as `send` does (`replyAnswers`; a reply across marks no task's answer).
   *
   * `held`: written while its link is down (docs/plans/linked-mail.md §12), its row undelivered until `heldWent`, so the copy keeps all that goes then;
   * what it answers is settled only then
   */
  sentAcross(
    sender: string,
    input: { id: string; to: string; text: string; needsReply: boolean; urgent?: boolean; replyTo?: string; question?: true; subject?: string; choices?: MailChoices; task?: TaskAcross; held?: true },
  ): MailRow {
    return this.run(() => {
      const now = this.now()
      const target = input.replyTo === undefined ? undefined : this.records.message(input.replyTo)
      // Work given across a link (#1948 step 6) is a task here as there: the report the machine sends back answers this copy, and settles it
      const work = input.task ? { kind: input.task.note ? ('message' as const) : ('task' as const), origin: input.task.origin, causeId: this.causeOf(sender) } : { kind: 'message' as const, origin: 'mail' as const }
      const facts: MailFacts = { ...(input.question && input.needsReply ? { question: true } : {}), ...(input.task?.forPerson ? { hubAssistant: true } : {}), ...(input.task?.depth ? { agentDepth: input.task.depth } : {}) }
      const stored = this.put(
        { id: input.id, sender, body: input.text, needsReply: input.needsReply, urgent: input.urgent === true, replyTo: target?.id ?? null, createdAt: now, ...work, facts, subject: input.subject ?? null, choices: input.choices ?? null },
        [this.row(input.to, input.held ? { dueAt: now, held: LINK_HOLD } : { dueAt: now, deliveredAt: now })],
      )
      if (!input.held) this.settleAnswered(sender, stored)
      return stored
    })
  }

  /** Mail across held for its link (`sentAcross` with `held`) went: its row delivered, the hold let go, and what it answers settled as a send's is */
  heldWent(m: MailRow, to: string): void {
    this.run(() => {
      const now = this.now()
      this.records.markDelivered(to, [m.id], now, null)
      this.records.hold(to, [m.id], null)
      this.settleAnswered(m.sender, m)
    })
  }

  /** The sender's own row on the message `m` replies to, settled when `m` answers it (`replyAnswers`) */
  private settleAnswered(sender: string, m: MailRow): void {
    const target = m.replyTo === null ? undefined : this.records.message(m.replyTo)
    if (target && replyAnswers(target, m) && this.records.recipient(target.id, sender)) this.records.settle(target.id, sender, 'answered', this.now(), m.id)
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
    if (age > CITE_MS) return `the person's last message here is ${durationText(age)} old, and a citation may be ${durationText(CITE_MS)} at most`
    if (this.records.hasDedupe(sender, citeKey(said.seq))) return "the person's last message here was cited by an earlier request already"
    return { seq: said.seq, at: said.ts }
  }

  /**
   * Work a delegation tool gave: a task from `sender` to `recipient`, whose turn Centralu reports (D2, D7). Written delivered when the old path delivered its words.
   * A `note` is a message that needs no reply: no report and no last response answers it; one from `agent_session` (a session's `mail` to one it started) is quiet
   */
  task(sender: string, recipient: string, input: TaskInput): MailRow {
    const from = parseAddress(sender)
    if (!from || from.kind === 'centralu') throw refuse('not_allowed', 'Centralu sends with notice and report')
    // The delegation tool has started the child already: a long text is cut as the old record cut it, never refused (Q-M2-13)
    const text = cutTask(input.text, bodyLimit(from.kind))
    if (text === '') throw refuse('empty', 'a task says something')
    return this.run(() => {
      const now = this.now()
      return this.put(
        {
          sender, kind: input.note ? 'message' : 'task', body: text, replyTo: input.replyTo ?? null, causeId: this.causeOf(sender), origin: input.origin,
          facts: {
            ...(input.fromScript ? { fromScript: input.fromScript } : input.across?.forPerson ? { hubAssistant: true } : {}),
            ...(input.depth ? { agentDepth: input.depth } : {}),
            ...(isQuietNote(input) ? { quiet: true } : {}),
          },
          ...(input.across ? { id: input.across.id } : {}),
        },
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
   * `reported`, and only it: each task is a request of its own, answered in its own thread (docs/plans/mailbox.md §10.6.3); a pause
   * (`paused`, `waiting`) settles nothing, wakes its owner the first time and is quiet after. The same pause again is the stored report, `duplicate`
   */
  report(taskId: string, input: TurnReport): ReportWritten {
    return this.run(() => {
      const task = this.records.message(taskId)
      // A task, or for the Assistant's request turn the request it was for (§9.2): Centralu reports either to its sender
      const row = task && (task.kind === 'task' || task.kind === 'message') ? this.records.recipients(taskId).find((r) => task.kind === 'task' || this.isRequest(task, r.recipient)) : undefined
      if (!task || !row) throw refuse('unknown_message', REFUSAL_TEXT.unknown_message(taskId))
      // A request's turn is reported whatever its row says: a moved request is settled `legacy`, and its asker is told all the same (§6.3)
      if (row.settled !== null && task.kind === 'task') return { settledAlready: true }
      const now = this.now()
      const pause = input.outcome === 'paused' || input.outcome === 'waiting'
      const first = !pause || !this.records.reportsOn(taskId).some((r) => r.facts.outcome === 'paused' || r.facts.outcome === 'waiting')
      // Only the same sender's tasks to the same session, still open: a report another computer sent names no task of anyone else's, nor one
      // withdrawn or answered already (#2348). A crossed row never settles a copy `reported` (`AcrossReceipts`), so a copy is open until this report
      const covers = pause
        ? []
        : [...new Set(input.covers ?? [])].filter((id) => {
            const m = id === taskId ? undefined : this.records.message(id)
            return m?.kind === 'task' && m.sender === task.sender && this.records.recipient(id, row.recipient)?.settled === null
          })
      const facts: MailFacts = {
        outcome: input.outcome,
        about: { session: row.recipient },
        ...(input.error ? { error: input.error } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.paused ? { paused: input.paused } : {}),
        ...(input.waitingOn ? { waitingOn: input.waitingOn } : {}),
        ...(input.personSince ? { personSince: true } : {}),
        ...(input.after ? { after: true } : {}),
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
        this.records.settle(taskId, row.recipient, 'reported', now)
        // Each covered row names the report as its answer: what `reportsOn` finds it by
        for (const id of covers) this.records.settle(id, row.recipient, 'reported', now, stored.id)
      }
      return { message: stored, duplicate: stored.duplicate, first }
    })
  }

  /** A session at rest answers its open tasks with its last response (§10.6.3, `answerAtRest`): returns the tasks answered */
  lastResponse(recipient: string, last: LastResponse): string[] {
    const party = parseAddress(recipient)
    const personAt = party?.kind === 'session' ? this.opts.personSaid?.(party.sessionId)?.ts : undefined
    return this.run(() => answerAtRest(this.records, recipient, last, (id, input) => this.report(id, input), personAt))
  }

  /**
   * A notice from Centralu (D2, D21): quiet when `facts.quiet`. Undefined when its `dedupeKey` was used already. `delivered`: the caller puts it into the
   * receiver at once, so it is written delivered and read (as `refused`)
   */
  notice(recipient: string, input: { body: string; facts: MailFacts; dedupeKey: string; delivered?: boolean }): MailRow | undefined {
    const stored = this.run(() => this.centralu(recipient, { kind: 'notice', ...input }))
    return stored.duplicate ? undefined : stored
  }

  /**
   * The unanswered reminder (S2, docs/plans/mailbox.md §10): one notice to `recipient` naming `rows`, which wait for its answer, inline in the wake.
   * Each row counts it once it is delivered (`MailboxRecords.markDelivered`). `quiet`: posted without waking, for the next wake to carry. Undefined
   * when this reminder of these rows was written already
   */
  remind(recipient: string, rows: readonly RecipientRow[], quiet: boolean): MailRow | undefined {
    const now = this.now()
    const named = rows.flatMap((r) => {
      const m = this.records.message(r.messageId)
      return m ? [{ row: r, item: { id: m.id, from: this.reach.shownId(m.sender, recipient), waitedMs: now - (r.deliveredAt ?? now), last: r.reminded + 1 >= REMINDER.perRow } }] : []
    })
    if (named.length === 0) return undefined
    return this.notice(recipient, {
      body: reminderText(named.map((n) => n.item), this.opts.calls?.(recipient)),
      facts: { reminder: named.some((n) => n.item.last) ? 2 : 1, of: named.map((n) => n.item.id), reason: 'reminder', ...(quiet ? { quiet: true } : {}) },
      dedupeKey: `reminder:${recipient}:${hash16(named.map((n) => `${n.row.messageId}/${n.row.reminded}`).sort())}`,
    })
  }

  /**
   * `mail done` (D8): as a recipient, no answer is needed; as the sender, the message is withdrawn for every unsettled recipient. A task's receiver
   * settles nothing: `task` says the tool claims it for the running turn (`MailDelivery.claim`, #2493)
   */
  done(by: string, id: string): { settled: number; how: 'done' | 'withdrawn' | 'none' | 'unwatched' | 'task' } {
    return this.run(() => {
      const m = this.records.message(id)
      if (!m) throw refuse('unknown_message', REFUSAL_TEXT.unknown_message(id))
      const mine = m.sender === by
      const row = mine ? undefined : this.records.recipient(id, by)
      if (!mine && !row) throw refuse('not_yours', REFUSAL_TEXT.not_yours(id))
      // A request is marked done in the turn it is in, where its words are shown (§7.6)
      if (!mine && this.isRequest(m, by) && !this.inOpenTurn(m, row, this.opts.turn?.(by) ?? null)) throw refuse('not_allowed', REFUSAL_TEXT.withheld(id))
      // A task is settled by its report, not by its receiver saying it needs nothing: that would take the report from its owner. Its receiver's
      // `handled` says the turn it is in does it (`task`): that turn's report answers it (`MailDelivery.claim`, #2493)
      if (!mine && m.kind === 'task') return { settled: 0, how: row?.settled === null ? 'task' : 'none' }
      if (!m.needsReply && m.kind !== 'task') return { settled: 0, how: 'unwatched' }
      if (mine) {
        const n = this.records.settle(id, 'all', 'withdrawn', this.now())
        return { settled: n, how: n > 0 ? 'withdrawn' : 'none' }
      }
      if (row?.settled !== null) return { settled: 0, how: 'none' }
      const settled = this.records.settle(id, by, 'done', this.now())
      if (settled > 0) this.questionSettled(id)
      return { settled, how: 'done' }
    })
  }

  /** Whether `reader` may read the session at `session` with read_session, and whether its lines are marked untrusted (`StopNoticeOptions.readsAs`); null when not */
  readsSession(reader: string, session: string): { untrusted: boolean } | null {
    return this.opts.readsAs?.(reader, session) ?? null
  }

  /**
   * A question a session asked (`facts.question`) was settled with no answer that goes to it: marked handled here, or on the side it crossed to
   * (`MailAcross`). The report it held for that giver is owed now (#2348, `answerAtRest`): the session's last response gives it once it is at rest.
   * An answer needs none of this: it goes to the session, and the turn it starts answers. Told once the write that settled it is done
   */
  questionSettled(messageId: string): void {
    const m = this.records.message(messageId)
    if (m?.kind !== 'message' || !m.facts.question || senderKind(m.sender) !== 'session') return
    const tell = this.opts.questionSettled
    if (tell) queueMicrotask(() => tell(m.sender))
  }

  // ── Reading ──

  /**
   * `mail read` (§8.4): with no id the reader's unread mail, oldest first, at most 10 messages and about 20,000 characters, never half a message, marked
   * read; with an id that message and its chain back, at most 9 ancestors oldest first, phantoms for what the reader may not read (§5.5), and the
   * message itself marked read. `before` is the older half of a chain. A request to the Assistant is read only in the turn it was delivered in (§7.6)
   */
  read(reader: string, opts: { id?: string; before?: string } = {}): ReadView {
    return this.run(() => {
      const now = this.now()
      const turn = this.opts.turn?.(reader) ?? null
      if (opts.id === undefined && opts.before === undefined) {
        const items: ReadItem[] = []
        let chars = 0
        for (const { message } of this.records.unreadFor(reader)) {
          const item = this.item(message, reader, turn)
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
      const items = [...(missing ? [this.gone(oldest.replyTo ?? '')] : []), ...chain.reverse().map((m) => this.item(m, reader, turn)), ...(opts.id === undefined ? [] : [this.item(base, reader, turn)])]
      const read = opts.id === undefined ? undefined : items.at(-1)
      const marked = read && !read.phantom && !read.withheld && read.row ? this.records.markRead(reader, [base.id], now) : 0
      return { items, older: !missing && chain.length === READ_CHAIN && oldest.replyTo !== null ? oldest.id : null, marked }
    })
  }

  /** What the reader's `inbox` lists (S6): what waits for its answer, what is unread, what it asked and is not answered, and its mail held for the person */
  inbox(reader: string): InboxView {
    const turn = this.opts.turn?.(reader) ?? null
    const messageOf = (row: RecipientRow) => this.records.message(row.messageId)
    const needReply = this.records
      .unansweredTo(reader)
      .flatMap((row) => {
        const m = messageOf(row)
        return m?.kind === 'message' && !isHidden(row) ? [m] : []
      })
      .map((m) => this.item(m, reader, turn))
    const listed = new Set(needReply.map((i) => i.message.id))
    const unread = this.records
      .unreadFor(reader)
      .filter((p) => !listed.has(p.message.id))
      .map((p) => this.item(p.message, reader, turn))
    const waiting = this.records.watchedFrom(reader).flatMap((row) => {
      const message = messageOf(row)
      return message?.kind === 'message' && message.needsReply && row.held !== LINK_HOLD ? [{ row, message }] : []
    })
    const held = [
      ...this.records.heldRows().flatMap((row) => {
        const message = messageOf(row)
        return message?.sender === reader && isHidden(row) ? [{ row, message, why: row.held === 'loop' ? ('loop' as const) : ('policy' as const) }] : []
      }),
      ...this.records.heldForLink(reader).map((p) => ({ ...p, why: LINK_HOLD })),
    ]
    return { needReply, unread, waiting, held }
  }

  /**
   * Whether mail that wakes `recipient` waits for it, due or not yet (the debounce makes a message wait a moment before it is due): a turn of its own is
   * coming, which a note of the host's should follow. Reads only; mail that is held out or settled is not waiting
   */
  wakingFor(recipient: string): boolean {
    return this.records.pendingFor(recipient, Number.MAX_SAFE_INTEGER).some((p) => wakesMessage(p.message))
  }

  watchedTo(recipient: string): RecipientRow[] {
    return this.records.watchedTo(recipient)
  }

  // ── The wake ──

  /**
   * What a delivery to `recipient` would send now, and which messages it covers (§8.2). It reads the rows as they are: what was read since is not in it,
   * nor a reminder whose messages are settled, nor mail whose sender may no longer write. The one hold holds a row (`heldBack`, which the
   * delivery writes); a task is the work of the turn it starts, one to a wake, and for the Assistant one asker's requests; everything else rides along
   */
  drain(recipient: string, opts: DrainOptions = {}): DrainResult {
    const now = this.now()
    const toAssistant = this.reach.isAssistant(recipient)
    const parent = this.reach.parentOf(recipient)
    type Candidate = { row: RecipientRow; message: MailRow; down: boolean; request: boolean }
    const candidates: Candidate[] = []
    const heldBack: DrainResult['heldBack'] = []
    for (const { row, message } of this.records.pendingFor(recipient, now, opts.again === true)) {
      const request = this.isRequest(message, recipient)
      if (message.sender === recipient || this.reach.mayWrite(message.sender, recipient) !== null || opts.skip?.(message, row)) continue
      // A request to the Assistant never joins its running turn: one asker a turn (docs/plans/turn-owned-by-no-one.md §4.2)
      if (opts.joining && toAssistant && this.askerOf(message, recipient) !== undefined) continue
      // A task given again waits for a turn of its own: joining another, it would be given again once more (#2493)
      if (opts.joining && message.kind === 'task' && row.givenAgainAt !== null) continue
      if (this.reminderSettled(message, recipient)) {
        this.records.markRead(recipient, [message.id], now)
        continue
      }
      // A row an older build's person released goes as it is: never held again (§6.3)
      const releasedBefore = row.held === 'released' && message.facts.releasedTo?.includes(recipient) === true
      const why = releasedBefore ? null : this.reach.holdFor(message, recipient)
      if (why) {
        heldBack.push({ messageId: message.id, reason: why })
        continue
      }
      const sender = senderKind(message.sender)
      candidates.push({
        row,
        message,
        request,
        down: flowsDownTo({ fromPerson: sender === 'person', fromSession: sender === 'session', kind: message.kind, toAssistant, fromParent: parent === message.sender, watch: sender === 'centralu' && (message.facts.watch !== undefined || message.facts.reminder !== undefined), forPerson: this.forPerson(message) !== undefined }),
      })
    }

    // One turn, one task (D17): a delivery that starts a turn carries at most one task, or for the Assistant one asker's requests
    const wakesIt = (c: Candidate) => wakesMessage(c.message)
    const isWork = (c: Candidate) => (toAssistant ? c.request : c.message.kind === 'task')
    const groupOf = (c: Candidate) => (toAssistant ? c.message.sender : c.message.id)
    const picked = pickWork(
      candidates
        .filter((c) => wakesIt(c) && isWork(c))
        .map((c) => ({ key: groupOf(c), decides: c.message.urgent || isPerson(c.message.sender), needsReply: toAssistant && c.message.needsReply, dueAt: c.row.dueAt })),
      now,
    )
    const turnStarts = candidates.some(wakesIt)
    const handedOn = turnStarts && picked === null ? candidates.map((c) => (wakesIt(c) ? this.handedOnFrom(c.message, recipient) : undefined)).find((id) => id !== undefined) : undefined
    const kept = turnStarts ? candidates.filter((c) => !isWork(c) || groupOf(c) === picked) : candidates
    // Mail joining a turn starts none: it is no one's work, so the running turn is reported as before (docs/plans/mailbox.md §10.6.2)
    const workMessage = !turnStarts || opts.joining ? null : handedOn ?? (toAssistant ? (kept.find((c) => c.request)?.message.id ?? null) : picked)

    const items: MessageFrameItem[] = []
    const given: ListedMail[] = []
    let wake = false
    let immediate = false
    let needsReply = false
    for (const { row, message, down } of kept) {
      if (wakesMessage(message)) wake = true
      if (message.urgent || isPerson(message.sender)) immediate = true
      if (message.kind === 'message' && message.needsReply) needsReply = true
      const relation = this.relation(recipient, message)
      given.push({ threadId: message.rootId, messageId: message.id, relation })
      const item = this.frameItem(recipient, message, relation, down && row.deliveredAt === null, row)
      items.push(opts.joining && message.kind === 'task' ? { ...item, joined: true } : item)
    }
    const frame = buildMessageFrame(items, this.opts.calls?.(recipient))
    // What this delivery gives: the messages the frame names (one folded over its budget waits for the next), which the line counts and opens to
    const listed = given.filter((l) => frame.shown.includes(l.messageId))
    return {
      text: frame.text,
      messageIds: frame.shown,
      inline: frame.inline,
      pointed: frame.shown.filter((id) => !frame.inline.includes(id)),
      wake,
      immediate,
      needsReply,
      line: mailLine(listed).line,
      listed,
      heldBack,
      workMessage,
      asker: turnStarts && toAssistant ? picked : null,
    }
  }

  /** Something the Inbox shows changed that is no message (the question about sleeping sessions): the listeners hear an empty change for the person */
  announce(rootId = ''): void {
    this.listeners.emit({ messageId: '', rootId, recipients: [PERSON] })
  }

  // ── The Assistant's requests (§7.6) ──

  /** The Assistant's turn on `asker`'s requests ended (§7.6): the requests that turn carried are settled `reported`. Returns how many */
  requestTurnEnded(assistant: string, asker: string, turnSeq: number): number {
    return this.run(() => {
      let n = 0
      for (const row of this.records.watchedTo(assistant)) {
        const m = row.turnSeq === turnSeq && this.records.message(row.messageId)
        if (m && m.sender === asker && this.isRequest(m, assistant)) n += this.records.settle(m.id, assistant, 'reported', this.now())
      }
      return n
    })
  }

  /**
   * The sessions whose requests are in `assistant`'s turn `turn` (docs/plans/turn-owned-by-no-one.md §4.2), oldest first, each with its oldest request there, read
   * from the rows the turn was given (`inOpenTurn`), settled or not: a request delivered into the turn makes the whole turn its asker's, and a
   * restart or a swap keeps it, since the store holds the rows. A reminder for an asker (`facts.asker`) counts as its request
   */
  requestsIn(assistant: string, turn: TurnRead): { asker: string; messageId: string }[] {
    if (!this.reach.isAssistant(assistant)) return []
    const work = turn.messageId === null ? undefined : this.records.message(turn.messageId)
    const given = [...(work ? [{ message: work, row: this.records.recipient(work.id, assistant) }] : []), ...this.records.inTurn(assistant, turn.turnSeq)]
    const found = new Map<string, string>()
    for (const { message: m, row } of given) {
      if (!this.inOpenTurn(m, row, turn)) continue
      const asker = this.askerOf(m, assistant)
      if (asker !== undefined && !found.has(asker)) found.set(asker, m.id)
    }
    return [...found].map(([asker, messageId]) => ({ asker, messageId }))
  }

  /** The session a message to the Assistant asks for: a request's sender, or the asker a reminder names (`facts.asker`) */
  private askerOf(m: MailRow, assistant: string): string | undefined {
    const asker = this.isRequest(m, assistant) ? m.sender : m.kind === 'notice' && m.sender === CENTRALU ? m.facts.asker : undefined
    return asker !== undefined && parseAddress(asker)?.kind === 'session' ? asker : undefined
  }

  // ── Upkeep ──

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
        { id: messageIdOf(this.opts.hostId, this.ulids.next(now)), senderProject: this.reach.projectOf(mail.sender), needsReply: false, replyTo: null, causeId: null, depth: 0, urgent: false, facts: {}, choices: null, subject: null, dedupeKey: null, legacyThread: null, createdAt: now, ...mail },
        rows,
      )
    } catch (e) {
      if (e instanceof MailTargetMissing) throw refuse('unknown_message', REFUSAL_TEXT.unknown_message(e.replyTo))
      throw e
    }
    if (!stored.duplicate) this.queued.push({ messageId: stored.id, rootId: stored.rootId, recipients: rows.map((r) => r.recipient), arrived: true })
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
    if (text.length > bodyLimit(cls)) throw refuse('too_long', tooLongText(cls))
    return text
  }

  /** A gone session's refusal, naming the session that took over from it by a handoff when there is one (a reply to its question, say): write to that one */
  private goneText(to: string): string {
    const heir = this.opts.heirOf?.(to) ?? null
    return `${REFUSAL_TEXT.gone(this.reach.shownId(to))}${heir ? ` ${JSON.stringify(this.reach.labelOf(heir))} (${this.reach.shownId(heir)}) took over from it by a handoff: write to that session.` : ''}`
  }

  private refusalText(why: ReturnType<MailReach['mayWrite']> & string, to: string): string {
    const text: Record<string, string | undefined> = {
      gone: this.goneText(to),
      no_mailbox: REFUSAL_TEXT.no_mailbox(),
      elsewhere: REFUSAL_TEXT.elsewhere(this.reach.shownId(to)),
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

  /**
   * The task a session's message to `to` is about when `to` gave it that task, the one its turn is for (a clarification, §9.7), or undefined. `to`
   * is an address, or `{ host }` for `parent` across a link: a session of the computer that started the sender (`MailAcross.parentHost`), which
   * alone knows which session that is. The one condition for a clarification, on this host and across (#2357)
   */
  clarifies(sender: string, to: string | { host: string }): string | undefined {
    if (senderKind(sender) !== 'session') return undefined
    const causeId = this.causeOf(sender)
    const cause = causeId === null ? undefined : this.records.message(causeId)
    if (cause?.kind !== 'task') return undefined
    const giver = parseAddress(cause.sender)
    const gave = typeof to === 'string' ? cause.sender === to : giver?.kind === 'session' && giver.host === to.host
    return gave ? cause.id : undefined
  }

  /** Whether `target` is a clarification of a task `owner` gave, and the answer goes to the one who asked (§9.7) */
  private answersClarification(owner: string, target: MailRow, to: readonly string[]): boolean {
    const task = typeof target.facts.clarifies === 'string' ? this.records.message(target.facts.clarifies) : undefined
    return task?.kind === 'task' && task.sender === owner && to.length === 1 && to[0] === target.sender
  }

  /**
   * Whether a message is a request to the Assistant (§7.6): from a session to the Assistant, unless it answers a `needsReply` message or a task the
   * assistant sent that session, or is a clarification. Only requests are counted by `ask_rate`
   */
  private isRequest(m: Pick<MailRow, 'sender' | 'kind' | 'replyTo' | 'facts'>, recipient: string): boolean {
    if ((m.kind !== 'message' && m.kind !== 'task') || m.sender === recipient || !this.reach.isAssistant(recipient)) return false
    if (senderKind(m.sender) !== 'session' || typeof m.facts.clarifies === 'string') return false
    const target = m.replyTo === null ? undefined : this.records.message(m.replyTo)
    return !(target && target.sender === recipient && (target.needsReply || target.kind === 'task'))
  }

  /**
   * Whether a message was given in the recipient's open turn (§4.2): its row names the turn, or it is the work message of a turn the delivery began,
   * whose rows are marked once the tool took them. Not another row held from the recipient: what it was not woken for has not joined the turn
   */
  private inOpenTurn(m: Pick<MailRow, 'id'>, row: RecipientRow | undefined, turn: TurnRead | null): boolean {
    if (!turn || !row) return false
    // The work message is the turn's whatever became of its row: a delivery a dying host left half done is held `uncertain` at the next start, and the turn the keeper kept is still that request's
    if (turn.by === 'mail' && turn.messageId === m.id) return true
    return row.turnSeq === turn.turnSeq && (row.held === null || row.held === 'released')
  }

  /** The message that started `sender`'s turn, when a message did (not the person, not the session itself): what a send in that turn is caused by (§8.2 step 6) */
  private causeOf(sender: string): string | null {
    const turn = this.opts.turn?.(sender) ?? null
    return turn !== null && turn.by !== 'person' && turn.by !== 'cli' ? turn.starter : null
  }

  /** The answer `answer` to `question` is held for the person: the question stays open (it keeps the answer's id) and its asker is told once, quietly (S14) */
  private answerHeld(question: MailRow, answer: MailRow): void {
    this.records.answerHeld(question.id, answer.sender, answer.id)
    if (parseAddress(question.sender)?.kind !== 'session') return
    const reason = `${this.reach.projectLabel(answer.senderProject ?? '')} is not trusted`
    this.centralu(question.sender, {
      kind: 'notice',
      body: `${this.reach.labelOf(answer.sender)} answered your ${question.id} with ${answer.id}, and the answer is held for the person (${reason}). It reaches you if the person lets it through; until then Centralu does not remind ${this.reach.labelOf(answer.sender)} of it.`,
      facts: { quiet: true, answerHeld: { question: question.id, answer: answer.id } },
      dedupeKey: `answer_held:${question.sender}:${answer.id}:policy`,
    })
  }

  /** A reminder whose messages are all settled, released, answered by a held answer or moved away has nothing to say (§8.2 step 1) */
  private reminderSettled(m: MailRow, recipient: string): boolean {
    return (
      m.kind === 'notice' &&
      m.facts.reminder !== undefined &&
      (m.facts.of ?? []).every((id) => {
        const row = this.records.recipient(id, recipient)
        return row === undefined || row.settled !== null || row.releasedAt !== null || row.answerId !== null
      })
    )
  }

  /** The task this delivery's report hands on from (§8.2 step 3): the report is of a task the recipient gave while it worked on one still open */
  private handedOnFrom(m: MailRow, recipient: string): string | undefined {
    const task = m.kind === 'report' && m.replyTo !== null ? this.records.message(m.replyTo) : undefined
    const cause = task?.causeId ? this.records.message(task.causeId) : undefined
    return cause?.kind === 'task' && this.records.recipient(cause.id, recipient)?.settled === null ? cause.id : undefined
  }

  // ── What the reader sees ──

  /** Centralu's word for how the sender stands to the receiver (§8.3). Never a name another party wrote */
  private relation(recipient: string, m: MailRow): string {
    const kind = senderKind(m.sender)
    if (kind === 'centralu') return 'Centralu'
    if (kind === 'person') return 'the person'
    if (kind === 'app') return 'an app you called'
    if (this.isRequest(m, recipient)) return 'a session asking you for something'
    if (this.reach.parentOf(recipient) === m.sender) return 'your parent session'
    if (this.reach.parentOf(m.sender) === recipient) return 'your child session'
    const target = m.replyTo === null ? undefined : this.records.message(m.replyTo)
    if (target?.kind === 'task' && target.sender === recipient) return 'the session you gave this work to'
    if (this.reach.isAssistant(m.sender)) return 'the Assistant'
    const mine = this.reach.projectOf(recipient)
    // A sender gone from here (an heir's archived predecessor) by the project stamped when it wrote; a sender across a link has none
    return mine !== null && mine === (this.reach.projectOf(m.sender) ?? m.senderProject) ? 'a session of your project' : 'a session of another project'
  }

  /** A message as `reader` sees it: whole, or a phantom without its words (§5.5), or a request whose words are for the turn it is in only (§7.6) */
  private item(m: MailRow, reader: string, turn: TurnNow | null): ReadItem {
    const row = this.records.recipient(m.id, reader) ?? null
    const relation = this.relation(reader, m)
    if (m.sender !== reader && (!row || isHidden(row))) return { message: { ...m, body: '', facts: {} }, row: null, relation, phantom: row ? 'held' : 'not_sent' }
    if (this.isRequest(m, reader) && !this.inOpenTurn(m, row ?? undefined, turn)) return { message: { ...m, body: '' }, row, relation, withheld: true }
    const forPerson = this.forPerson(m)
    return { message: m, row, relation, ...(forPerson ? { forPerson } : {}) }
  }

  /** Whether an address is a session on another computer: another host's, or on a hub a linked machine's (`<machine>.<id>`, as `MailAcross` routes it) */
  private across(address: string): boolean {
    const p = parseAddress(address)
    return p?.kind === 'session' && (p.host !== this.opts.hostId || p.sessionId.includes('.'))
  }

  /** The Assistant's `send_to_session` words, which act for the person (`forPersonOf`) */
  private forPerson(m: MailRow): 'task' | 'note' | undefined {
    return forPersonOf(m, this.reach.isAssistant(m.sender) || m.facts.hubAssistant === true)
  }

  /** The line for an earlier message that is no longer kept (S5) */
  private gone(id: string): ReadItem {
    const stub: MailRow = { id, sender: '', senderProject: null, kind: 'notice', needsReply: false, replyTo: null, rootId: id, causeId: null, depth: 0, urgent: false, body: '', facts: {}, choices: null, subject: null, dedupeKey: null, origin: null, legacyThread: null, createdAt: 0 }
    return { message: stub, row: null, relation: '', phantom: 'gone' }
  }

  private frameItem(recipient: string, m: MailRow, relation: string, inline: boolean, row: Pick<RecipientRow, 'lastError' | 'givenAgainAt'>): MessageFrameItem {
    const about = asObj(m.facts.about).session
    const answered = m.replyTo === null ? undefined : this.records.message(m.replyTo)
    return {
      messageId: m.id,
      kind: m.kind,
      from: this.reach.shownId(m.sender),
      relation,
      ...(m.kind === 'message' ? { needsReply: m.needsReply } : {}),
      ...(answered?.sender === recipient ? { answers: answered.id } : {}),
      ...(typeof m.facts.clarifies === 'string' ? { clarifies: m.facts.clarifies } : {}),
      ...(typeof about === 'string' && parseAddress(about) ? { about: this.reach.shownId(about) } : {}),
      // The stored word `finished` is the host's knowledge that a turn ended, not that the work is done (#1902): the model reads it as that
      ...(m.facts.outcome ? { outcome: m.facts.outcome === 'finished' ? 'turn_ended' : m.facts.outcome } : {}),
      ...(m.facts.error ? { error: m.facts.error } : {}),
      ...(m.facts.reason ? { reason: m.facts.reason } : {}),
      ...(m.facts.paused !== undefined ? { paused: m.facts.paused } : {}),
      ...(m.facts.waitingOn !== undefined && m.facts.waitingOn > 0 ? { waitingOn: m.facts.waitingOn } : {}),
      ...(m.facts.personNote === true ? { personNote: true } : {}),
      ...(this.forPerson(m) ? { forPerson: this.forPerson(m) } : {}),
      ...(row.lastError === 'maybe_repeated' ? { maybeRepeated: true } : {}),
      ...(row.givenAgainAt !== null ? { givenAgain: true } : {}),
      ...(inline ? { inline: m.body } : {}),
    }
  }
}

/** The dedupe key of a request that cites the person's message `seq` of its sender's conversation: one use (`UNIQUE(sender, dedupe_key)`) */
const citeKey = (seq: number): string => `cite:${seq}`

/** A row the reader was not told of (held by the one hold, or `loop` by an earlier build): its message reads as a phantom (§5.5) */
const isHidden = (row: RecipientRow): boolean => (HIDDEN_HOLDS as readonly string[]).includes(row.held ?? '')

