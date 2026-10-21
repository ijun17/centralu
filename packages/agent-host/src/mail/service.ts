import { errorMessage, oneLineText } from '@cc/protocol'
import { asObj, isObj } from '../json-value.js'
import {
  BLOCKER_KINDS,
  MESSAGE_KINDS,
  THREAD_ORIGINS,
  THREAD_OUTCOMES,
  type BlockerKind,
  type BlockerRow,
  type MailFacts,
  type MailLinks,
  type MailRecords,
  type MessageKind,
  type MessageRow,
  type ParticipantRole,
  type ParticipantRow,
  type ReceiptRow,
  type ThreadOrigin,
  type ThreadOutcome,
  type ThreadPatch,
  type ThreadRow,
  type ThreadState,
} from '../dev-services/store/mail.js'
import { CENTRALU, PERSON, parseAddress, sessionAddress, type Party } from './address.js'
import { buildMailFrame, type MailCalls, type MailFrameItem } from './frame.js'
import { UlidMaker, messageIdFloor, messageIdOf, parseMailId, threadIdOf } from './ids.js'
import {
  MAX_BLOCKERS,
  NEXT_MAX,
  SUBJECT_MAX,
  bodyLimit,
  dueAt,
  flowsDown,
  mayEditTask,
  mayPostKind,
  pickWorkThread,
  postsPerMinute,
  REPEAT_WINDOW_MS,
  wakes,
  refuse,
  refusalReason,
  reopensReview,
  settableStates,
  stateAfterUnblocked,
  type SenderClass,
  type Standing,
} from './rules.js'

/*
 * The mailbox's model (#1347, docs/plans/mailbox.md slice 1): threads that are tasks, the posts in them, who has read
 * what, and the rules that move a thread's state. It stores and answers. It delivers nothing and wakes nobody (slice 2),
 * and nothing in the host posts yet (slice 3 on).
 *
 * **Who is calling is an argument, never a field of the input.** `open(caller, input)`, `post(thread, caller, input)`: a tool
 * that spreads its arguments into the input cannot name `person` or `centralu` as the sender, because an input that has a
 * `from` or a `by` is refused. The caller is whatever the host knows of the call (the signed session address, the app's).
 */

/** Who may write to whom, beyond what the model itself requires. Slice 2 supplies the relations of §9.1; until then everyone in a thread may */
export type MailPolicy = {
  /** A reason in words when `from` may not write to `to` in this thread (null for a thread being opened), else null */
  mayWrite(from: string, to: string, thread: ThreadRow | null): string | null
  /**
   * A reason in words when `to` cannot read mail at all, whoever writes: a session whose seat has no `mail` tool (the wake names a call
   * it cannot make, §9.3). Asked before anything else about the receiver, also for a reply in a thread it is in
   */
  cannotRead?(to: string): string | null
  /** How `to` makes the calls a wake names: the tool itself, or `centralu_run` for a seat that reaches `mail` as a command */
  calls?(to: string): MailCalls
}

export type MailServiceOptions = {
  /** This host's own id (`hub-` and 8 hex digits), read at the first mail and kept (§11.4) */
  hostId: () => string
  now?: () => number
  policy?: MailPolicy
  random?: (bytes: number) => Uint8Array
}

/** What a sender may put in a post. Nothing else is accepted, `facts` least of all */
export type PostInput = {
  kind: MessageKind
  body: string
  urgent?: boolean
  needsOwner?: boolean
  wake?: boolean
  replyTo?: string
  dedupeKey?: string
}

export type OpenInput = {
  kind: MessageKind
  subject: string
  body: string
  /** The party that gave the work and gets its reports; the caller unless it says otherwise (only the person, Centralu, or the assignee taking the work may name another) */
  owner?: string
  assignee?: string | null
  members?: string[]
  origin?: ThreadOrigin
  projectId?: string | null
  parentId?: string | null
  depth?: number
  /** Done threads this one follows up (§3.3) */
  follows?: string[]
  links?: MailLinks
  next?: string | null
  /** `running` only when the assignee itself opens the thread, as an app taking work does (§8.3) */
  state?: 'open' | 'running'
  urgent?: boolean
  needsOwner?: boolean
  wake?: boolean
  /** The caller's key for this opening: opened again under it, the thread that exists is returned */
  dedupeKey?: string
}

export type AssignInput = { assignee: string; body: string; urgent?: boolean; dedupeKey?: string }

export type TaskPatch = {
  state?: ThreadState
  outcome?: ThreadOutcome
  next?: string | null
  links?: MailLinks
  subject?: string
}

export type BlockerInput = { kind: BlockerKind; ref?: string; text?: string }

/** What Centralu may write that a sender may not: `facts`, an `event`, and a post into a thread that is done (events only) */
export type CentraluPost = {
  kind: MessageKind
  body: string
  facts?: MailFacts
  dedupeKey?: string
  urgent?: boolean
  needsOwner?: boolean
  wake?: boolean
  /** Who it is for: participants of the thread; all of them when not given */
  to?: string[]
}

/** A thread changed (and who has new mail in it): what the delivery engine and the windows hear */
export type MailChange = { threadId: string; recipients: string[] }

export type PostResult = {
  message: MessageRow
  thread: ThreadRow
  duplicate: boolean
  /** The same words, kind and sender in this thread within 10 minutes: not posted again, and this is the first one (§7.9) */
  repeated?: boolean
}

/** Work a session gave another through a tool the host already delivered it by (start_agent, ask_project, ...): the host writes it down (§8.1) */
export type DelegationInput = {
  assignee: string
  /** The caller's own words for the task (never a frame or the project's instructions the host adds) */
  task: string
  origin: ThreadOrigin
  projectId?: string | null
}

export type DelegationResult = { thread: ThreadRow; message: MessageRow; /** The task went into the thread this owner already had with this assignee */ continued: boolean }

/** Said when a task is cut to the longest a session may post: the child has the whole of it, in its conversation */
const TASK_CUT = "\n[Centralu: cut here. The full task is in the session's conversation (read_session).]"

/**
 * How a turn of delegated work ended, told by Centralu to the thread's owner (§6, §8.1). The words of `body` are Centralu's own with the
 * session's last response behind them; `facts` is what the wake carries (an outcome word, the kind of error, how many tasks are left
 * running, whether the person wrote into the turn)
 */
export type TurnReport = {
  /** The thread's owner, who is told */
  to: string
  /** The session whose turn ended */
  about: string
  /**
   * The session's last response, which are its own words: they go in the thread as a message of the session's, in front of the report, and
   * are read with the tool under what the session is to the reader. They are never in the words of Centralu's report, which stay words
   * Centralu wrote (#1186). Recorded read and handled for the owner: the report is what wakes it
   */
  answer?: string
  /** One word of Centralu's: finished, failed, limit_reached, network, interrupted, quit, stopped, paused, settled, swapped, took_over */
  outcome: string
  body: string
  error?: string
  paused?: number
  personNote?: boolean
  /**
   * The owner has been told already, by the call that returned the answer or by the old way of telling: the report is recorded as
   * delivered, read and handled for it, and nothing wakes it
   */
  told?: boolean
  /** What the thread becomes: `review` when the work was reported (the owner decides), `running` when it paused on its own background work, `dropped` when the person took it over */
  then: 'review' | 'running' | 'dropped'
}

export type OpenResult = PostResult & {
  /** The participants of the threads this one follows, who may be added to it (§3.3, "offered as its own") */
  offered: string[]
}

export type ReadMessage = Omit<MessageRow, 'facts'> & {
  /** Centralu's facts. Never given to an app (§9.4) */
  facts?: MailFacts
  /** For a message the reader sent: where each recipient has got to */
  receipts?: { recipient: string; delivered: boolean; read: boolean; handled: boolean }[]
}

export type ThreadView = {
  thread: ThreadRow
  participants: ParticipantRow[]
  blockers: BlockerRow[]
  messages: ReadMessage[]
  /** There are messages before the first one returned (`tail`) */
  older?: boolean
}

export type ReadOptions = {
  /** From the start, not from where the reader last read */
  all?: boolean
  /** From after this `seq` (overrides the cursor) */
  after?: number
  /** Do not mark what is returned read (the board and the Inbox list; a peek) */
  peek?: boolean
  /** At most this many messages: the reader is moved on only as far as it got */
  limit?: number
  /**
   * The last this many messages of the thread (or of those before `before`), and, unless they are an earlier page, the whole thread is
   * read: what the Inbox shows of a long thread is its end, where the question waiting for the person is
   */
  tail?: number
  before?: number
}

/** What a delivery to one receiver would send now (§7.5, §7.6) */
/** Why mail is told of without a turn: an inbound policy holds it (§7.7), or the session's budget of mail-started turns is spent (§7.9) */
export type QuietReason = 'policy' | 'budget'

/** Why mail is left out of a delivery and kept for the person: a thread's turns ran away (§7.9) */
export type HoldReason = 'loop'

export type DrainOptions = {
  /** Mail that is told of once more, delivered and still unread (§7.6.6) */
  again?: boolean
  /** Left out, and nothing is written about it */
  skip?: (message: MessageRow, receipt: ReceiptRow) => boolean
  /** Told of, but not a reason for a turn */
  quiet?: (message: MessageRow, receipt: ReceiptRow, thread: ThreadRow) => QuietReason | null | undefined
  /** Left out and held for the person */
  holdBack?: (message: MessageRow, receipt: ReceiptRow, thread: ThreadRow) => HoldReason | null | undefined
}

export type DrainResult = {
  /** The wake frame; empty when there is nothing to say */
  text: string
  /** Every message the text tells of */
  messageIds: string[]
  /** Those whose words are in the text whole (they flow down). Read on acceptance, and never sent again */
  inline: string[]
  /** Those the text only points at: delivered, still unread */
  pointed: string[]
  /** Whether anything in it wakes the receiver (§9.5). If not, it goes in without a turn (Claude: `shouldQuery: false`), or waits for one */
  wake: boolean
  /** Whether anything in it is urgent or the person's: it does not wait out the 30 s between wakes (§7.9) */
  immediate: boolean
  /** Whether anything in it is a question: it goes before the rest when many sessions are woken at once (§7.9) */
  asks: boolean
  /** The line the conversation keeps of the delivery (§9.2): how many, in how many threads, from whom, in Centralu's words */
  line: string
  /** Told of without a turn, and why: held for the person once delivered (Inbox: Release) */
  quieted: { messageId: string; reason: QuietReason }[]
  /** Left out of it and held for the person (Inbox: Resume) */
  heldBack: { messageId: string; reason: HoldReason }[]
  /** The threads the delivery is from, in the order of their first message */
  threads: string[]
  /** The one thread of the receiver's own work a turn this delivery starts belongs to (§6), or null when it carries none or starts no turn */
  workThread: string | null
}

const POST_KEYS = new Set(['kind', 'body', 'urgent', 'needsOwner', 'wake', 'replyTo', 'dedupeKey'])
const OPEN_KEYS = new Set([
  'kind', 'subject', 'body', 'owner', 'assignee', 'members', 'origin', 'projectId', 'parentId', 'depth', 'follows', 'links', 'next', 'state',
  'urgent', 'needsOwner', 'wake', 'dedupeKey',
])
const ASSIGN_KEYS = new Set(['assignee', 'body', 'urgent', 'dedupeKey'])
const PATCH_KEYS = new Set(['state', 'outcome', 'next', 'links', 'subject'])
const BLOCKER_KEYS = new Set(['kind', 'ref', 'text'])
const MAX_LINKS = 20
const MAX_DEDUPE_KEY = 200

export class MailService {
  private readonly ulids: UlidMaker
  private readonly now: () => number
  private readonly policy: MailPolicy
  private cachedHost: string | undefined
  private readonly listeners = new Set<(change: MailChange) => void>()
  /** What changed in the transaction under way: told to the listeners once it has committed, and dropped if it did not */
  private queued: MailChange[] = []

  constructor(
    private readonly records: MailRecords,
    private readonly opts: MailServiceOptions,
  ) {
    this.now = opts.now ?? Date.now
    this.policy = opts.policy ?? { mayWrite: () => null }
    this.ulids = new UlidMaker(opts.random)
  }

  /** This host's own id */
  get host(): string {
    this.cachedHost ??= this.opts.hostId()
    return this.cachedHost
  }

  /** A session's address on this host */
  sessionAddress(sessionId: string): string {
    return sessionAddress(this.host, sessionId)
  }

  /**
   * A session left the host's list (it went to the trash, or was deleted): the work it held moves on (§3.3). A host that never
   * made mail has nothing to move and does not even ask for its id
   */
  sessionGone(sessionId: string): ThreadRow[] {
    if (!this.records.hasThreads()) return []
    return this.partyGone(this.sessionAddress(sessionId))
  }

  /**
   * Hears every change to a thread once it has committed: a post (and who it is for), a state change, a member. The delivery
   * engine wakes its receivers from it (§5). A listener that throws is said on stderr and does not undo the change
   */
  onChange(listener: (change: MailChange) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The transaction of every change, and then what it queued for the listeners */
  private run<T>(fn: () => T): T {
    this.queued = []
    let result: T
    try {
      result = this.records.transaction(fn)
    } catch (e) {
      this.queued = []
      throw e
    }
    const merged = new Map<string, Set<string>>()
    for (const c of this.queued) {
      const set = merged.get(c.threadId) ?? new Set<string>()
      for (const r of c.recipients) set.add(r)
      merged.set(c.threadId, set)
    }
    this.queued = []
    for (const [threadId, recipients] of merged) {
      for (const listener of this.listeners) {
        try {
          listener({ threadId, recipients: [...recipients] })
        } catch (e) {
          console.error(`[mail] a listener failed: ${errorMessage(e)}`)
        }
      }
    }
    return result
  }

  /**
   * The person has something to act on that no post made: mail held for them (a failed delivery, a pause, a policy), one thing dismissed,
   * or the question about sleeping sessions (`threadId` ''). The state is written already; the listeners (the Inbox's news) are told now
   */
  announce(threadId: string): void {
    for (const listener of this.listeners) {
      try {
        listener({ threadId, recipients: [PERSON] })
      } catch (e) {
        console.error(`[mail] a listener failed: ${errorMessage(e)}`)
      }
    }
  }

  /** `announce` for the threads these messages are in */
  announceMessages(messageIds: readonly string[]): void {
    const threads = new Set<string>()
    for (const id of messageIds) {
      const m = this.records.message(id)
      if (m) threads.add(m.threadId)
    }
    for (const threadId of threads) this.announce(threadId)
  }

  private changed(threadId: string, recipients: readonly string[] = []): void {
    this.queued.push({ threadId, recipients: [...recipients] })
  }

  // ── Opening and posting ──

  /** Opens a thread with its first message. Everything in it commits together */
  open(caller: string, input: OpenInput): OpenResult {
    rejectUnknown(input, OPEN_KEYS, 'open')
    const by = this.party(caller)
    const ownerAddress = input.owner ?? caller
    const owner = this.party(ownerAddress)
    const assigneeAddress = input.assignee ?? null
    const assignee = assigneeAddress === null ? null : this.party(assigneeAddress)
    const memberAddresses = input.members ?? []
    const members = memberAddresses.map((m) => this.party(m))
    for (const p of [owner, assignee, ...members]) if (p?.kind === 'centralu') throw refuse('bad_address', 'Centralu cannot be in a thread: it only sends')
    if (!(['assign', 'question', 'note', 'notice'] as readonly string[]).includes(input.kind)) {
      throw refuse('kind_not_allowed', `a thread cannot be opened with a ${input.kind}`)
    }
    if (assigneeAddress !== null && assigneeAddress === ownerAddress) throw refuse('bad_value', 'the owner and the assignee of a thread are two parties')
    // Whoever gives work is a session or the person: words that flow down from the owner (§7.3) are never an app's
    if (owner.kind === 'app') throw refuse('not_allowed', 'an app does not own a thread: it takes work, or reports on work a session gave')
    if (input.kind === 'assign') {
      if (assigneeAddress === null) throw refuse('bad_value', 'assign needs an assignee')
      if (by.kind === 'app') throw refuse('kind_not_allowed', 'an app does not give work')
      if (by.kind !== 'centralu' && by.kind !== 'person' && caller !== ownerAddress) throw refuse('not_allowed', 'only the owner gives work in a thread')
    }
    const addresses = unique([ownerAddress, assigneeAddress ?? undefined, ...memberAddresses])
    const trusted = by.kind === 'centralu' || by.kind === 'person'
    if (!trusted && !addresses.includes(caller)) throw refuse('not_participant', 'a thread is opened by a party that is in it')
    /*
     * Work is given by an `assign` from its owner (or the person, or Centralu), or taken by the assignee itself, as an app
     * does for the session that called it (§8.3). A thread opened any other way cannot name an owner who did not act, nor an
     * assignee they did not choose: the owner's later words would reach the assignee as the words of whoever directs it
     */
    const takingWork = assigneeAddress !== null && assigneeAddress === caller
    if (!trusted && ownerAddress !== caller && !takingWork) {
      throw refuse('not_allowed', 'a thread is opened for another owner only by the person, by Centralu, or by the assignee taking the work')
    }
    if (!trusted && assigneeAddress !== null && input.kind !== 'assign' && !takingWork) {
      throw refuse('not_allowed', 'work is given with assign, by its owner')
    }
    this.checkFlags(by.kind, input)
    const openerStanding: Standing =
      by.kind === 'person' || by.kind === 'centralu' ? by.kind : caller === ownerAddress ? 'owner' : caller === assigneeAddress ? 'assignee' : 'member'
    if (input.kind !== 'assign') {
      const wrong = mayPostKind(by.kind, openerStanding, input.kind)
      if (wrong) throw refuse('kind_not_allowed', wrong)
    }
    if (input.state === 'running' && !(takingWork || trusted)) {
      throw refuse('not_allowed', 'only the assignee, the person or Centralu starts a thread as running')
    }
    const subject = oneLineText(input.subject, SUBJECT_MAX)
    if (!subject) throw refuse('empty', 'a thread needs a subject')
    const body = this.checkBody(by.kind, input.body, false)
    const origin = input.origin ?? (by.kind === 'person' ? 'person' : by.kind === 'app' ? 'app' : 'mail')
    if (!THREAD_ORIGINS.includes(origin)) throw refuse('bad_value', `unknown origin ${String(origin)}`)

    return this.run(() => {
      const now = this.now()
      // Opened again under the same key by the same caller: the thread that exists, not a second one (also at the limit: a retry is no new post)
      if (input.dedupeKey !== undefined) {
        const first = this.duplicateOpening(caller, input.dedupeKey)
        if (first) return { message: first, thread: this.mustThread(first.threadId), duplicate: true, offered: [] }
      }
      this.checkRate(by.kind, caller, now)
      for (const follow of input.follows ?? []) {
        const f = this.records.thread(follow)
        if (!f) throw refuse('bad_follows', `thread ${follow} is not here to follow up`)
        if (f.state !== 'done') throw refuse('bad_follows', `thread ${follow} is not done: post in it instead of opening a follow-up`)
      }
      if (input.parentId && !this.records.thread(input.parentId)) throw refuse('not_found', `parent thread ${input.parentId} is not here`)
      for (const to of addresses.filter((a) => a !== caller)) this.mayWriteOrRefuse(caller, to, null)

      const id = threadIdOf(this.host, this.ulids.next(now))
      const state: ThreadState = assigneeAddress !== null && input.state === 'running' ? 'running' : 'open'
      this.records.insertThread(
        {
          id,
          home: this.host,
          projectId: input.projectId ?? null,
          subject,
          origin,
          depth: nonNegativeInt(input.depth ?? 0, 'depth'),
          parentId: input.parentId ?? null,
          follows: input.follows ?? [],
          state,
          owner: ownerAddress,
          assignee: assigneeAddress,
          next: input.next === undefined || input.next === null ? null : oneLineText(input.next, NEXT_MAX),
          links: input.links ? checkLinks(input.links) : {},
        },
        now,
      )
      this.records.putParticipant(id, ownerAddress, 'owner', now)
      if (assigneeAddress !== null) this.records.putParticipant(id, assigneeAddress, 'assignee', now)
      for (const m of memberAddresses) if (m !== ownerAddress && m !== assigneeAddress) this.records.putParticipant(id, m, 'member', now)
      // The person who opens a thread for someone else is in it; Centralu never is
      if (by.kind === 'person' && !addresses.includes(caller)) this.records.putParticipant(id, PERSON, 'member', now)

      // Stored under its own namespace, so a post in this thread that reuses the key that opened it is a post, not a duplicate
      const message = this.insertPost(id, caller, input.kind, body, {}, { ...input, dedupeKey: input.dedupeKey === undefined ? undefined : OPENING + input.dedupeKey }, now, undefined)
      const offered = unique((input.follows ?? []).flatMap((f) => this.records.participants(f).filter((p) => p.leftAt === null).map((p) => p.address))).filter(
        (a) => a !== caller,
      )
      return { message, thread: this.mustThread(id), duplicate: false, offered }
    })
  }

  /** A post from a sender into a thread. The sender writes the words; Centralu writes the facts, so `facts` is refused */
  post(threadId: string, caller: string, input: PostInput): PostResult {
    rejectUnknown(input, POST_KEYS, 'post')
    return this.run(() => {
      const now = this.now()
      const thread = this.mustThread(threadId)
      const sender = this.party(caller)
      if (sender.kind === 'centralu') throw refuse('not_allowed', 'Centralu posts with postAsCentralu')
      const standing = this.standing(thread, caller)
      if (!standing) throw refuse('not_participant', `${caller} is not in thread ${threadId}`)
      // A retry of a post that was stored gets that post, also when the thread has been closed since: it was not lost
      const existing = this.duplicate(thread.id, caller, input.dedupeKey)
      if (existing) return { message: existing, thread, duplicate: true }
      this.assertWritable(thread)
      this.checkRate(sender.kind, caller, now)
      const wrong = mayPostKind(sender.kind, standing, input.kind)
      if (wrong) throw refuse('kind_not_allowed', wrong)
      this.checkFlags(sender.kind, input)
      const body = this.checkBody(sender.kind, input.body, false)
      if (input.replyTo !== undefined) this.checkReplyTo(thread.id, input.replyTo)
      // The same words again from a session or an app: not posted again, and the sender is told (§7.9)
      if (sender.kind === 'session' || sender.kind === 'app') {
        const last = this.records.lastBy(thread.id, caller)
        if (last && last.kind === input.kind && last.body === input.body && now - last.createdAt <= REPEAT_WINDOW_MS) {
          return { message: last, thread, duplicate: true, repeated: true }
        }
      }

      // A participant that is gone, or whose seat cannot read mail, gets no receipt: the others are written to all the same. Refused
      // only when there is no one left to take it, so the sender learns why
      const reachable: string[] = []
      let refusal: Error | undefined
      for (const to of this.recipients(thread.id, caller)) {
        try {
          this.mayWriteOrRefuse(caller, to, thread)
          reachable.push(to)
        } catch (e) {
          if (!(e instanceof Error) || refusalReason(e) === undefined) throw e
          refusal ??= e
        }
      }
      if (refusal !== undefined && reachable.length === 0) throw refusal
      // The person writes into any thread, and from then on is in it (the Inbox's reply box, §10.1); a role they have stays
      if (sender.kind === 'person') this.records.putParticipantIfAbsent(thread.id, PERSON, 'member', now)
      const message = this.insertPost(thread.id, caller, input.kind, body, {}, input, now, input.replyTo, reachable)
      let after = thread
      if (thread.state === 'review' && reopensReview(standing, input.kind)) {
        after = this.moveState(thread, { state: 'running' }, now, { change: 'state', from: 'review', to: 'running', by: caller }, 'The owner sent more: the thread is running again.')
      }
      return { message, thread: after, duplicate: false }
    })
  }

  /** What only Centralu does: write `facts`, post an `event`, and add an event to a thread that is done (§3.3) */
  postAsCentralu(threadId: string, input: CentraluPost): PostResult {
    return this.run(() => {
      const now = this.now()
      const thread = this.mustThread(threadId)
      if (!(MESSAGE_KINDS as readonly string[]).includes(input.kind)) throw refuse('kind_not_allowed', `unknown kind ${String(input.kind)}`)
      if (input.kind === 'assign') throw refuse('kind_not_allowed', 'work is given with assign, not posted')
      const existing = this.duplicate(thread.id, CENTRALU, input.dedupeKey)
      if (existing) return { message: existing, thread, duplicate: true }
      if (thread.state === 'done') {
        if (input.kind !== 'event') throw doneRefusal(thread)
      } else this.assertWritable(thread)
      const body = this.checkBody('centralu', input.body, input.kind === 'event')
      // It is for the thread's own participants: a receipt for anyone else would wake a party for a thread it may not read
      if (input.to !== undefined) {
        const inThread = new Set(this.recipients(thread.id, CENTRALU))
        for (const to of input.to) if (!inThread.has(to)) throw refuse('not_participant', `${to} is not in thread ${threadId}`)
      }
      const message = this.insertPost(thread.id, CENTRALU, input.kind, body, input.facts ?? {}, input, now, undefined, input.to)
      return { message, thread, duplicate: false }
    })
  }

  /** The owner (or the person, or Centralu) gives the thread to someone: a reassignment (§3.2, "opens a thread or reassigns one") */
  assign(threadId: string, caller: string, input: AssignInput): PostResult {
    rejectUnknown(input, ASSIGN_KEYS, 'assign')
    return this.run(() => {
      const now = this.now()
      const thread = this.mustThread(threadId)
      const by = this.party(caller)
      const assignee = this.party(input.assignee)
      if (assignee.kind === 'centralu') throw refuse('bad_address', 'Centralu cannot be given work')
      if (by.kind === 'app') throw refuse('kind_not_allowed', 'an app does not give work')
      const standing = this.standing(thread, caller)
      if (standing !== 'owner' && standing !== 'person' && standing !== 'centralu') throw refuse('not_allowed', 'only the owner gives work in a thread')
      const existing = this.duplicate(thread.id, caller, input.dedupeKey)
      if (existing) return { message: existing, thread, duplicate: true }
      this.assertWritable(thread)
      this.checkRate(by.kind, caller, now)
      if (input.assignee === thread.owner) throw refuse('bad_value', 'the owner and the assignee of a thread are two parties')
      const body = this.checkBody(by.kind, input.body, false)
      this.mayWriteOrRefuse(caller, input.assignee, thread)

      const previous = thread.assignee
      let moved = thread
      if (previous === input.assignee) {
        // The same assignee given more to do: a thread in review runs again, one that is running keeps running
        if (thread.state === 'review') {
          moved = this.moveState(thread, { state: 'running', stateSince: now }, now, { change: 'state', from: 'review', to: 'running', by: caller }, 'The owner sent more: the thread is running again.')
        }
      } else {
        if (previous && previous !== thread.owner) this.records.putParticipant(thread.id, previous, 'member', now)
        this.records.putParticipant(thread.id, input.assignee, 'assignee', now)
        // The thread is `open` again for the new assignee; a standing blocker keeps it blocked
        const to: ThreadState = thread.state === 'blocked' ? 'blocked' : 'open'
        moved = this.moveState(
          thread,
          { assignee: input.assignee, state: to, ...(to !== thread.state ? { stateSince: now } : {}) },
          now,
          { change: 'assignee', from: previous, to: input.assignee, by: caller },
          'The thread was given to a new assignee.',
        )
      }
      const message = this.insertPost(thread.id, caller, 'assign', body, {}, input, now, undefined)
      return { message, thread: moved, duplicate: false }
    })
  }

  /** Adds a participant: someone the adder may write to anyway (§9.1) */
  addMember(threadId: string, by: string, address: string): ThreadRow {
    return this.run(() => {
      const now = this.now()
      const thread = this.mustThread(threadId)
      this.party(by)
      const added = this.party(address)
      if (added.kind === 'centralu') throw refuse('bad_address', 'Centralu cannot be in a thread: it only sends')
      const standing = this.standing(thread, by)
      if (standing !== 'owner' && standing !== 'assignee' && standing !== 'person' && standing !== 'centralu') {
        throw refuse('not_allowed', 'a thread gains a member from its owner, its assignee or the person')
      }
      this.assertWritable(thread)
      this.mayWriteOrRefuse(by, address, thread)
      const role: ParticipantRole = address === thread.owner ? 'owner' : address === thread.assignee ? 'assignee' : 'member'
      const was = this.records.participants(thread.id).find((p) => p.address === address && p.leftAt === null)
      this.records.putParticipant(thread.id, address, role, now)
      if (!was) this.insertEvent(thread.id, 'A party joined the thread.', { change: 'joined', party: address, by }, now)
      return this.mustThread(thread.id)
    })
  }

  // ── Reading ──

  /**
   * A thread as one of its parties sees it: the task fields, the people in it, what stands in its way and its messages
   * after where the reader left off (marked read, unless it only peeks). An app never gets `facts` (§9.4)
   */
  read(threadId: string, reader: string, opts: ReadOptions = {}): ThreadView {
    const party = this.party(reader)
    const thread = this.mustThread(threadId)
    const standing = this.standing(thread, reader)
    if (!standing) throw refuse('not_participant', `${reader} is not in thread ${threadId}`)
    const position = this.records.readPosition(thread.id, reader)
    const after = opts.after ?? (opts.all ? 0 : position)
    const tailed = opts.tail !== undefined
    const messages = tailed ? this.records.messagesTail(thread.id, opts.tail ?? 0, opts.before) : this.records.messagesAfter(thread.id, after, opts.limit)
    const view: ReadMessage[] = messages.map((m) => {
      const { facts, ...rest } = m
      const out: ReadMessage = party.kind === 'app' ? rest : { ...rest, facts }
      if (m.sender === reader) {
        out.receipts = this.records.receiptsOf(m.id).map((r) => ({
          recipient: r.recipient,
          delivered: r.deliveredAt !== null,
          read: r.readAt !== null,
          handled: r.handledAt !== null,
        }))
      }
      return out
    })
    const last = messages.at(-1)?.seq
    if (tailed) {
      // The end of the thread was opened (not an earlier page): it is read to its end, and the earlier part stays there to be asked for
      if (!opts.peek && opts.before === undefined && last !== undefined && party.kind !== 'centralu') {
        this.records.markThreadRead(reader, thread.id, this.now())
        this.records.setReadPosition(thread.id, reader, Math.max(position, last))
      }
      const first = messages[0]?.seq
      return {
        thread,
        participants: this.records.participants(thread.id),
        blockers: this.records.blockers(thread.id),
        messages: view,
        older: first !== undefined && this.records.hasMessagesBefore(thread.id, first),
      }
    }
    if (!opts.peek && last !== undefined && party.kind !== 'centralu') {
      // Only what was returned is read, and the place moves only when it joins on to where the reader was: reading from
      // further on (an app's `after`) leaves a gap, and the gap stays unread
      this.records.markRead(reader, messages.map((m) => m.id), this.now())
      if (after <= position) this.records.setReadPosition(thread.id, reader, last)
    }
    return { thread, participants: this.records.participants(thread.id), blockers: this.records.blockers(thread.id), messages: view }
  }

  /** The reader's acknowledgement (§7.6): its receipts up to `upTo` (all by default) are handled, and read with them */
  handled(threadId: string, reader: string, upTo?: number): number {
    this.party(reader)
    const thread = this.mustThread(threadId)
    if (!this.standing(thread, reader)) throw refuse('not_participant', `${reader} is not in thread ${threadId}`)
    return this.records.markHandled(thread.id, reader, upTo ?? Number.MAX_SAFE_INTEGER, this.now())
  }

  /** Whether `address` may change the task of the thread (its owner, its assignee, the person): asked before anything is posted for a change that would be refused */
  mayEditTask(threadId: string, address: string): boolean {
    const thread = this.mustThread(threadId)
    const standing = this.standing(thread, address)
    return standing !== null && mayEditTask(standing)
  }

  /** The threads that follow this one, and the ones it follows: a follow-up is shown both ways (§3.3) */
  followUps(threadId: string): ThreadRow[] {
    return this.records.threadsFollowing(threadId)
  }

  // ── Changing the task ──

  /** The task's own fields (§3.3). A move of state leaves an `event`; the thread is `done` for good once closed */
  update(threadId: string, by: string, patch: TaskPatch): ThreadRow {
    for (const key of Object.keys(patch)) {
      if (key === 'assignee') throw refuse('field_not_allowed', 'the assignee changes with assign')
      if (!PATCH_KEYS.has(key)) throw refuse('field_not_allowed', `${key} is not a task field`)
    }
    return this.run(() => {
      const now = this.now()
      const thread = this.mustThread(threadId)
      this.party(by)
      const standing = this.standing(thread, by)
      if (!standing) throw refuse('not_participant', `${by} is not in thread ${threadId}`)
      if (!mayEditTask(standing)) throw refuse('not_allowed', 'a member of a thread posts in it; the task is not theirs to change')
      this.assertWritable(thread)

      const fields: ThreadPatch = {}
      if (patch.subject !== undefined) {
        const subject = oneLineText(patch.subject, SUBJECT_MAX)
        if (!subject) throw refuse('empty', 'a thread needs a subject')
        if (standing === 'assignee') throw refuse('not_allowed', 'the subject is the owner’s to change')
        fields.subject = subject
      }
      if (patch.next !== undefined) fields.next = patch.next === null ? null : oneLineText(patch.next, NEXT_MAX)
      if (patch.links !== undefined) fields.links = { ...thread.links, ...checkLinks(patch.links) }

      let stateEvent: { text: string; facts: MailFacts } | undefined
      let closedAs: ThreadOutcome | undefined
      if (patch.state !== undefined && patch.state !== thread.state) {
        if (!settableStates(standing).includes(patch.state)) throw refuse('not_allowed', `the ${standing} of a thread cannot set it ${patch.state}`)
        const standingBlockers = this.records.blockers(thread.id).filter((b) => b.resolvedAt === null)
        if (patch.state === 'blocked' && standingBlockers.length === 0) throw refuse('no_blocker', 'a thread is blocked by something: add a blocker')
        if (patch.state !== 'blocked' && patch.state !== 'done' && standingBlockers.length > 0) {
          throw refuse('blockers_stand', `${standingBlockers.length} blocker(s) stand: resolve them and the thread goes on`)
        }
        fields.state = patch.state
        fields.stateSince = now
        if (patch.state === 'done') {
          const outcome = patch.outcome ?? 'finished'
          if (!THREAD_OUTCOMES.includes(outcome)) throw refuse('bad_value', `unknown outcome ${String(outcome)}`)
          fields.outcome = outcome
          fields.doneAt = now
          closedAs = outcome
        }
        stateEvent = {
          text: `State: ${thread.state} to ${patch.state}.`,
          facts: { change: 'state', from: thread.state, to: patch.state, by, ...(closedAs ? { outcome: closedAs } : {}) },
        }
      } else if (patch.outcome !== undefined) {
        throw refuse('bad_value', 'an outcome goes with done')
      }

      if (Object.keys(fields).length === 0) return thread
      const after = this.records.updateThread(thread.id, fields, now, true)
      this.changed(thread.id)
      if (stateEvent) this.insertEvent(thread.id, stateEvent.text, stateEvent.facts, now)
      if (closedAs) {
        // Closing is an answer to what the party was sent: its receipts in the thread are handled (§9.3)
        this.records.markHandled(thread.id, by, Number.MAX_SAFE_INTEGER, now)
        // And a thread that waits for this one hears how it ended (§3.3)
        this.releaseWaiters(thread.id, closedAs, now)
      }
      return after
    })
  }

  /** Adds a blocker; the thread is blocked while one stands (§3.3). At most 5 stand at once */
  addBlocker(threadId: string, by: string, input: BlockerInput): BlockerRow {
    rejectUnknown(input, BLOCKER_KEYS, 'blocker')
    return this.run(() => {
      const now = this.now()
      const thread = this.mustThread(threadId)
      this.party(by)
      const standing = this.standing(thread, by)
      if (!standing) throw refuse('not_participant', `${by} is not in thread ${threadId}`)
      if (!mayEditTask(standing)) throw refuse('not_allowed', 'a member of a thread cannot block it')
      this.assertWritable(thread)
      if (!BLOCKER_KINDS.includes(input.kind)) throw refuse('bad_value', `unknown blocker kind ${String(input.kind)}`)
      const existing = this.records.blockers(thread.id)
      if (existing.filter((b) => b.resolvedAt === null).length >= MAX_BLOCKERS) {
        throw refuse('too_many_blockers', `a thread has at most ${MAX_BLOCKERS} blockers standing`)
      }
      const text = oneLineText(input.text ?? '', NEXT_MAX)
      const ref = input.ref === undefined ? null : oneLineText(input.ref, 200)
      if (input.kind === 'text' && !text) throw refuse('empty', 'a text blocker says what it is')
      if (input.kind !== 'text' && !ref) throw refuse('empty', `a ${input.kind} blocker names its ${input.kind === 'thread' ? 'thread' : 'GitHub ref'}`)
      // The thread a thread blocker waits for: one of this host's own that is not here was never made or is gone, and cannot
      // be waited for. (A thread of another host cannot be checked from here.) One that has ended already finished is not waited for
      let ended: ThreadRow | undefined
      if (input.kind === 'thread') {
        const target = ref === null ? null : parseMailId(ref)
        if (ref === null || target?.kind !== 'thread' || ref === thread.id) throw refuse('bad_value', 'a thread blocker names another thread by its id')
        if (target.host === this.host) {
          ended = this.records.thread(ref)
          if (!ended) throw refuse('not_found', `Thread not found: ${ref}`)
          if (ended.state === 'done' && ended.outcome === 'finished') throw refuse('bad_value', `thread ${ref} is already finished: there is nothing to wait for`)
        }
      }
      const n = existing.reduce((max, b) => Math.max(max, b.n), 0) + 1
      const blocker: Omit<BlockerRow, 'resolvedAt'> = { threadId: thread.id, n, kind: input.kind, ref, text }
      this.records.insertBlocker(blocker)
      if (thread.state !== 'blocked') {
        this.moveState(
          thread,
          { state: 'blocked', stateSince: now },
          now,
          { change: 'state', from: thread.state, to: 'blocked', by, blocker: n },
          `State: ${thread.state} to blocked.`,
        )
      } else {
        this.records.updateThread(thread.id, {}, now, true)
        this.insertEvent(thread.id, 'A blocker was added.', { change: 'blocker_added', blocker: n, by }, now)
      }
      if (ended?.state === 'done') this.targetEnded(thread.id, n, ended.id, ended.outcome ?? 'unknown', now)
      return { ...blocker, resolvedAt: null }
    })
  }

  /** Resolves a blocker. The last one resolving restores the state the thread had before it was blocked (§3.3) */
  resolveBlocker(threadId: string, by: string, n: number): ThreadRow {
    return this.run(() => {
      const thread = this.mustThread(threadId)
      this.party(by)
      const standing = this.standing(thread, by)
      if (!standing) throw refuse('not_participant', `${by} is not in thread ${threadId}`)
      if (!mayEditTask(standing)) throw refuse('not_allowed', 'a member of a thread cannot unblock it')
      this.assertWritable(thread)
      return this.resolveInner(thread, n, by)
    })
  }

  /** The person keeps a thread past retention, or lets it go again (§4.4) */
  pin(threadId: string, by: string, pinned: boolean): ThreadRow {
    return this.run(() => {
      const thread = this.mustThread(threadId)
      if (this.party(by).kind !== 'person') throw refuse('not_allowed', 'only the person pins a thread')
      return this.records.updateThread(thread.id, { pinnedAt: pinned ? this.now() : null }, this.now(), false)
    })
  }

  /**
   * A session or app that has gone (trashed or deleted) leaves the work it held (§3.3): a thread it was assigned is
   * `open` with no assignee, a thread it owned is the person's. Each leaves an `event`. Done threads are not touched.
   * Called by the manager when a session goes to the session archive, wired in slice 2 before the `mail` tool can open a thread that names a session
   */
  partyGone(address: string): ThreadRow[] {
    this.party(address)
    return this.run(() => {
      const now = this.now()
      const moved: ThreadRow[] = []
      for (const t of this.records.threadsOfParty(address, 'assignee', ['open', 'running', 'review', 'blocked'])) {
        this.records.leaveParticipant(t.id, address, now)
        // A blocker still stands: the thread stays blocked, with nobody on it
        const to: ThreadState = t.state === 'blocked' ? 'blocked' : 'open'
        moved.push(
          this.moveState(
            t,
            { assignee: null, state: to, ...(to !== t.state ? { stateSince: now } : {}) },
            now,
            { change: 'assignee_gone', party: address, from: t.state, to },
            'The assignee is gone: the thread is open with no assignee.',
          ),
        )
      }
      for (const t of this.records.threadsOfParty(address, 'owner', ['open', 'running', 'review', 'blocked'])) {
        this.records.leaveParticipant(t.id, address, now)
        this.records.putParticipant(t.id, PERSON, 'owner', now)
        // The person becomes the owner; were they also the assignee, the thread is nobody's to do
        const alsoAssignee = t.assignee === PERSON
        const to: ThreadState = alsoAssignee && t.state !== 'blocked' ? 'open' : t.state === 'unknown' ? 'open' : t.state
        moved.push(
          this.moveState(
            t,
            { owner: PERSON, ...(alsoAssignee ? { assignee: null, state: to, ...(to !== t.state ? { stateSince: now } : {}) } : {}) },
            now,
            { change: 'owner_gone', party: address },
            'The owner is gone: the person owns the thread.',
          ),
        )
      }
      return moved
    })
  }

  /**
   * A turn of delegated work ended (§6): Centralu's `report` in the thread, for its owner, and the thread's state moves with it: `review`
   * when the work was reported, `running` when it paused on the session's own background work, and `done` (`dropped`, taken over) when the
   * person took the session over. A thread that is done, or whose owner is no longer in it, takes no report: the caller says so and the
   * old way of telling goes on
   */
  reportTurn(threadId: string, input: TurnReport): PostResult {
    return this.run(() => {
      const now = this.now()
      const thread = this.mustThread(threadId)
      this.assertWritable(thread)
      if (!this.recipients(thread.id, CENTRALU).includes(input.to)) throw refuse('not_participant', `${input.to} is not in thread ${threadId}`)
      const body = this.checkBody('centralu', input.body, false)
      const facts: MailFacts = {
        outcome: input.outcome,
        about: { session: input.about },
        ...(input.error ? { error: input.error } : {}),
        ...(input.paused ? { paused: input.paused } : {}),
        ...(input.personNote ? { personNote: true } : {}),
        ...(input.then === 'dropped' ? { takenOver: true } : {}),
      }
      // The session's own words, as its message: only the assignee's, so a reader reads them as the session's and not as Centralu's
      if (input.answer && input.answer.trim() !== '' && thread.assignee === input.about) {
        const own = this.insertPost(thread.id, input.about, 'report', this.checkBody('session', input.answer, false), { relayed: true }, {}, now, undefined, [input.to])
        this.records.markDelivered(input.to, [own.id], [own.id], now)
        this.records.markHandledIds(input.to, [own.id], now)
      }
      const message = this.insertPost(thread.id, CENTRALU, 'report', body, facts, {}, now, undefined, [input.to])
      if (input.told) {
        this.records.markDelivered(input.to, [message.id], [message.id], now)
        this.records.markReportsHandled(thread.id, input.to, now)
      }
      let after = thread
      const to: ThreadState = input.then === 'dropped' ? 'done' : input.then
      if (to !== thread.state && thread.state !== 'blocked') {
        after = this.moveState(
          thread,
          { state: to, stateSince: now, ...(to === 'done' ? { outcome: 'dropped' as const, doneAt: now } : {}) },
          now,
          { change: 'state', from: thread.state, to, by: CENTRALU, ...(to === 'done' ? { outcome: 'dropped' } : {}) },
          `State: ${thread.state} to ${to}.`,
        )
        if (to === 'done') this.releaseWaiters(thread.id, 'dropped', now)
      }
      return { message, thread: after, duplicate: false }
    })
  }

  /** The old way of telling delivered a report the mailbox holds for `to`: delivered, read and handled, so nothing wakes the owner for it (§8.1) */
  reportTold(threadId: string, to: string, messageId: string): void {
    this.run(() => {
      const now = this.now()
      this.records.markDelivered(to, [messageId], [messageId], now)
      this.records.markReportsHandled(threadId, to, now)
    })
    this.announce(threadId)
  }

  /**
   * A call returned the answer a report told of (§8.1): the caller read it, so the reports of this thread waiting for `owner` are read and
   * handled, and no wake follows for news the call already gave. The threads of the pair that a delegation tool opened; other mail is left
   */
  reportsAnswered(owner: string, assignee: string): void {
    const thread = this.records.latestBetween(owner, assignee)
    if (!thread) return
    const n = this.run(() => this.records.markReportsHandled(thread.id, owner, this.now()))
    if (n > 0) this.announce(thread.id)
  }

  // ── The wake ──

  /**
   * What a delivery to `recipient` would send now, and which messages it covers (§7.5). It reads the receipts as they are:
   * what was read or handled since is not in it, nor what is in a thread that has since been done, nor what the policy
   * no longer lets the sender write, nor what was already delivered, is held, or is not yet due. Nothing to say gives an
   * empty text, and nothing is sent.
   *
   * `inline` are the messages whose words are in the text whole: the receiver has them, and they are never sent again
   * (§7.6.5: an `assign` the CLI took just before a crash would start the same work twice). `pointed` are those the text only
   * tells of. With `again`, mail that was delivered but is still unread is pointed at once more (§7.6.6), never inline
   */
  drain(recipient: string, opts: DrainOptions = {}): DrainResult {
    this.party(recipient)
    type Candidate = {
      receipt: ReceiptRow
      message: MessageRow
      thread: ThreadRow
      sender: SenderClass | undefined
      down: boolean
      pointerOnly: boolean
      quietFor: QuietReason | null | undefined
    }
    const candidates: Candidate[] = []
    const heldBack: { messageId: string; reason: HoldReason }[] = []
    for (const { receipt, message, thread } of this.records.pendingFor(recipient, this.now(), opts.again === true)) {
      // A thread that is done takes no more mail, but what was posted before it closed is still owed: the closing report is how the owner
      // hears (§3.3). Anything else a done thread has waiting (an assign it will never run) is dropped
      if (thread.state === 'unknown' || (thread.state === 'done' && message.kind !== 'report') || message.kind === 'event' || message.sender === recipient) continue
      if (this.policy.mayWrite(message.sender, recipient, thread) !== null || this.policy.cannotRead?.(recipient)) continue
      if (opts.skip?.(message, receipt)) continue
      const holdBack = opts.holdBack?.(message, receipt, thread)
      if (holdBack) {
        heldBack.push({ messageId: message.id, reason: holdBack })
        continue
      }
      const sender = parseAddress(message.sender)?.kind
      const down = flowsDown(sender === 'person', sender === 'session' && message.sender === thread.owner, recipient === thread.assignee, message.kind)
      candidates.push({
        receipt,
        message,
        thread,
        sender,
        down,
        // A body that flows down and was delivered is not sent as the words again: if it is still unread it was only pointed at
        // (cut to fit, or read by nobody), and `again` points at it once more. Read on acceptance, a whole one is not pending at all
        pointerOnly: down && receipt.deliveredAt !== null,
        // Told of without a turn: an inbound policy that holds it (§7.7), or a budget that is spent (§7.9); never the person's words
        quietFor: sender === 'person' ? null : opts.quiet?.(message, receipt, thread),
      })
    }

    /*
     * One turn, one thread (§5, §6): a delivery that starts a turn carries at most one thread that is the receiver's work (it is
     * the assignee or a member there, and that thread's owner gets the turn's report), the person's words first, then a question waiting, else
     * the oldest due; the others wait for the next turn. Mail of threads the receiver owns (reports and news about work it gave) all rides together. A delivery that starts no
     * turn (all of it told of, or news that does not wake) is not bound by this
     */
    const wakesIt = (c: Candidate) => !c.quietFor && wakes(c.sender ?? 'session', c.message)
    const isWork = (c: Candidate) => c.thread.owner !== recipient
    // Which one: the person's words, urgent mail and what has waited past its hold, then a question, else the oldest due (§5)
    const work = candidates.filter((c) => wakesIt(c) && isWork(c))
    const workThread = pickWorkThread(
      work.map((c) => ({ threadId: c.thread.id, decides: c.message.urgent || c.sender === 'person', question: c.message.kind === 'question', dueAt: c.receipt.dueAt })),
      this.now(),
    )
    const turnStarts = candidates.some(wakesIt)
    const kept = turnStarts ? candidates.filter((c) => !isWork(c) || c.thread.id === workThread) : candidates

    const items: MailFrameItem[] = []
    let wake = false
    let immediate = false
    let asks = false
    const relations = new Set<string>()
    const threads = new Set<string>()
    const quieted: { messageId: string; reason: QuietReason }[] = []
    for (const { receipt, message, thread, sender, down, pointerOnly, quietFor } of kept) {
      if (quietFor) quieted.push({ messageId: message.id, reason: quietFor })
      else if (wakes(sender ?? 'session', message)) wake = true
      if (message.urgent || sender === 'person') immediate = true
      if (message.kind === 'question') asks = true
      relations.add(relationWord(recipient, message.sender, thread))
      threads.add(thread.id)
      const about = aboutOf(message.facts)
      const outcome = typeof message.facts.outcome === 'string' ? message.facts.outcome : undefined
      const error = typeof message.facts.error === 'string' ? message.facts.error : undefined
      const paused = typeof message.facts.paused === 'number' ? message.facts.paused : undefined
      items.push({
        messageId: message.id,
        threadId: thread.id,
        kind: message.kind,
        from: message.sender,
        relation: relationWord(recipient, message.sender, thread),
        ...(about ? { about } : {}),
        ...(outcome ? { outcome } : {}),
        ...(error ? { error } : {}),
        ...(paused !== undefined ? { paused } : {}),
        ...(message.facts.personNote === true ? { personNote: true } : {}),
        ...(receipt.lastError === 'maybe_repeated' ? { maybeRepeated: true } : {}),
        ...(down && !pointerOnly ? { inline: message.body } : {}),
      })
    }
    const frame = buildMailFrame(items, undefined, this.policy.calls?.(recipient))
    return { text: frame.text, messageIds: frame.shown, inline: frame.inline, pointed: frame.shown.filter((id) => !frame.inline.includes(id)), wake, immediate, asks, line: items.length === 0 ? '' : deliveryLine(items.length, threads.size, relations), quieted, heldBack, threads: [...threads], workThread: turnStarts ? workThread : null }
  }

  /**
   * What a host that died left half done (§7.6.5): a delivery whose attempt was written and whose acceptance was not. The next
   * host does not send it again on its own, because it cannot tell whether the tool took it, and an `assign` taken just before
   * the host died would start the same work twice. So it is held `uncertain`, said in the thread (an `event` the sender reads)
   * and, by the delivery, in the receiver's conversation, for the person to resend or dismiss. The exceptions go again by
   * themselves, and their next frame says it may be a repeat: news that starts no work (a notice) and Centralu's own words,
   * which only restate what the host knows
   */
  reconcileInterrupted(): { recipient: string; resent: number; held: number }[] {
    const left = this.records.attemptedUnconfirmed()
    if (left.length === 0) return []
    const out = this.run(() => {
      const now = this.now()
      const byRecipient = new Map<string, MessageRow[]>()
      for (const r of left) {
        const m = this.records.message(r.messageId)
        if (m) byRecipient.set(r.recipient, [...(byRecipient.get(r.recipient) ?? []), m])
      }
      const result: { recipient: string; resent: number; held: number }[] = []
      for (const [recipient, messages] of byRecipient) {
        result.push({ recipient, ...this.settleUncertain(recipient, messages, 'restart', now) })
      }
      return result
    })
    // What is held `uncertain` waits for the person's Resend or Dismiss: the Inbox is told
    this.announceMessages(left.map((r) => r.messageId))
    return out
  }

  /**
   * A wake the tool failed after the wait for it ran out (§7.6.5, the same uncertainty as a restart's): the tool had been counted as
   * having taken it, and a failure told this late (a session stopped or closed, a turn that took the input among others ended in an
   * error) does not prove it never ran it. The receipts that wake delivered (matched by `deliveredAt`) are unread and undelivered
   * again, in the same transaction, and treated as a restart's: held `uncertain` and said in the thread, or, for news that starts no
   * work, sent again with the note that it may be a repeat. Mail handled, held or delivered again since is left alone
   */
  deliveryFailedLate(recipient: string, messageIds: readonly string[], deliveredAt: number): { resent: number; held: number } {
    const out = this.run(() => {
      const ids = this.records.undeliver(recipient, messageIds, deliveredAt)
      const messages = ids.flatMap((id) => this.records.message(id) ?? [])
      return this.settleUncertain(recipient, messages, 'late', this.now())
    })
    this.announceMessages(messageIds)
    return out
  }

  /** Mail whose delivery may or may not have gone: news and Centralu's own words go again, the rest is held for the person */
  private settleUncertain(recipient: string, messages: readonly MessageRow[], cause: 'restart' | 'late', now: number): { resent: number; held: number } {
    const again = messages.filter((m) => m.kind === 'notice' || m.sender === CENTRALU)
    const unsure = messages.filter((m) => !again.includes(m))
    if (again.length > 0) {
      this.records.markMaybeRepeated(recipient, again.map((m) => m.id), now)
      this.changed(again[0]?.threadId ?? '', [recipient])
    }
    if (unsure.length > 0) {
      this.records.markUncertain(recipient, unsure.map((m) => m.id))
      const said =
        cause === 'restart'
          ? 'A delivery may not have arrived when Centralu restarted. It was not sent again.'
          : 'A delivery may have reached the session although its tool then reported a failure. It was not sent again.'
      for (const threadId of new Set(unsure.map((m) => m.threadId))) {
        const n = unsure.filter((m) => m.threadId === threadId).length
        this.insertEvent(threadId, said, { change: 'delivery_uncertain', cause, recipient, messages: n }, now)
      }
    }
    return { resent: again.length, held: unsure.length }
  }

  /** The person says send it (or sent it again after a failure): mail held for a reason that needs them goes now (§7.6.5, Inbox: Resend / Retry) */
  resendHeld(recipient: string, messageIds: readonly string[]): number {
    return this.run(() => {
      const n = this.records.releaseHeld(recipient, messageIds, null, this.now())
      for (const id of messageIds) {
        const m = this.records.message(id)
        if (m) this.changed(m.threadId, [recipient])
      }
      return n
    })
  }

  /** The person says never: the mail is left undelivered, and not held against anyone (Inbox: Dismiss) */
  dismissHeld(recipient: string, messageIds: readonly string[]): number {
    const n = this.run(() => this.records.releaseHeld(recipient, messageIds, 'dismissed', this.now()))
    this.announceMessages(messageIds)
    return n
  }

  // ── Retention ──

  /**
   * Retention (§4.4), and the blockers that named a thread it removed: they count as resolved (§3.3), which may unblock the
   * thread that waited on it. Safe to run any time, and again
   */
  sweep(): { messages: number; threads: number; unblocked: number } {
    const swept = this.records.sweep(this.now())
    let unblocked = 0
    // A thread of another host is not missing, it is elsewhere (slice 4): only this host's own are taken as swept. The
    // host id is read only when there is something to tell apart, so an idle sweep writes nothing
    const missing = this.records.blockersOnMissingThreads()
    for (const b of missing.length === 0 ? [] : missing.filter((x) => parseMailId(x.ref ?? '')?.host === this.host)) {
      this.run(() => {
        const thread = this.records.thread(b.threadId)
        if (thread && thread.state !== 'done' && thread.state !== 'unknown') {
          this.resolveInner(thread, b.n, CENTRALU)
          unblocked++
        } else this.records.resolveBlocker(b.threadId, b.n, this.now())
      })
    }
    return { ...swept, unblocked }
  }

  // ── Inside ──

  /** A thread that is done takes no more, and one in a state a newer build wrote is read-only here (docs/stored-shapes.md) */
  private assertWritable(thread: ThreadRow): void {
    if (thread.state === 'done') throw doneRefusal(thread)
    if (thread.state === 'unknown') throw refuse('not_allowed', `thread ${thread.id} is in a state a newer Centralu wrote: it can be read here, not changed`)
  }

  private resolveInner(thread: ThreadRow, n: number, by: string): ThreadRow {
    const now = this.now()
    if (!this.records.resolveBlocker(thread.id, n, now)) throw refuse('no_blocker', `thread ${thread.id} has no standing blocker ${n}`)
    const left = this.records.blockers(thread.id).filter((b) => b.resolvedAt === null)
    if (left.length > 0 || thread.state !== 'blocked') {
      const after = this.records.updateThread(thread.id, {}, now, true)
      this.insertEvent(thread.id, 'A blocker was resolved.', { change: 'blocker_resolved', blocker: n, by }, now)
      return after
    }
    const to = this.stateAfterUnblock(thread)
    return this.moveState(thread, { state: to, stateSince: now }, now, { change: 'state', from: 'blocked', to, by, resolved: n }, `The last blocker is resolved: ${to}.`)
  }

  /**
   * What a thread goes back to when its last blocker is resolved: the state it had before it was blocked (the `from` of the
   * event that blocked it). Review is review for anyone. An app that holds the work has it in hand wherever it stood
   * (a queue thread is `running`). A session goes on if a turn of the thread is going, and is open otherwise: it was
   * waiting, and nothing says it is running now
   */
  private stateAfterUnblock(thread: ThreadRow): ThreadState {
    const before = this.records.stateBeforeBlocked(thread.id)
    if (before === 'review') return 'review'
    if (before !== undefined && parseAddress(thread.assignee ?? '')?.kind === 'app') return before
    return stateAfterUnblocked(this.records.hasOpenTurn(thread.id))
  }

  /**
   * A thread ended, and others wait for it (§3.3, as the ledger's `pr` blocker did): finished resolves the blocker; failed,
   * stopped or dropped leaves it standing, with an `event` in the waiting thread that names the outcome
   */
  private releaseWaiters(targetId: string, outcome: ThreadOutcome, now: number): void {
    for (const b of this.records.blockersWaitingFor(targetId)) {
      const waiting = this.records.thread(b.threadId)
      if (!waiting || waiting.state === 'done' || waiting.state === 'unknown') continue
      this.targetEnded(waiting.id, b.n, targetId, outcome, now)
    }
  }

  private targetEnded(waitingId: string, n: number, targetId: string, outcome: ThreadOutcome | 'unknown', now: number): void {
    const waiting = this.mustThread(waitingId)
    if (outcome === 'finished') {
      this.resolveInner(waiting, n, CENTRALU)
    } else {
      this.insertEvent(waitingId, `The thread this one waits for ended: ${outcome}.`, { change: 'blocker_target_ended', blocker: n, target: targetId, outcome }, now)
    }
  }

  /** A change to the task's own fields, with its `event`: the history of a task is the thread itself */
  private moveState(thread: ThreadRow, fields: ThreadPatch, now: number, facts: MailFacts, text: string): ThreadRow {
    const after = this.records.updateThread(thread.id, fields, now, true)
    this.insertEvent(thread.id, text, facts, now)
    return after
  }

  /** An `event`: Centralu's, with no receipt, read with the thread (§3.2) */
  private insertEvent(threadId: string, text: string, facts: MailFacts, now: number): MessageRow {
    this.changed(threadId)
    return this.records.insertMessage({
      id: messageIdOf(this.host, this.ulids.next(now)),
      threadId,
      sender: CENTRALU,
      kind: 'event',
      urgent: false,
      needsOwner: false,
      wake: null,
      replyTo: null,
      body: text,
      facts,
      dedupeKey: null,
      createdAt: now,
    })
  }

  /**
   * A session gave another one a task by a tool whose delivery the host already made (§8.1, §4.2): the host writes it down, in step
   * with the old path, which stays the way the task reaches the child. So the `assign` is recorded delivered and read for the
   * child: nothing wakes it. The thread is the caller's own (it is the owner, the child the assignee) and `running`. A caller's
   * later instruction to the same child goes into the thread they already have as a `note`; into one that is `done` it opens a new
   * thread that follows it. No relation or rate check is made, because the delegation's own checks (consent, trust, ceilings) came
   * first, and this is the host's act, not an agent's post: an agent reaches the mailbox only through `open` and `post`
   */
  recordDelegation(caller: string, input: DelegationInput): DelegationResult {
    const owner = this.party(caller)
    const assignee = this.party(input.assignee)
    if (owner.kind !== 'session' || assignee.kind !== 'session') throw refuse('bad_address', 'a delegation is between two sessions of this host')
    if (caller === input.assignee) throw refuse('bad_value', 'the owner and the assignee of a thread are two parties')
    if (!THREAD_ORIGINS.includes(input.origin)) throw refuse('bad_value', `unknown origin ${String(input.origin)}`)
    const limit = bodyLimit('session')
    const task = input.task.trim()
    const body = task.length > limit ? task.slice(0, limit - TASK_CUT.length) + TASK_CUT : task
    if (body === '') throw refuse('empty', 'a task says something')
    return this.run(() => {
      const now = this.now()
      const last = this.records.latestBetween(caller, input.assignee)
      let thread: ThreadRow
      let message: MessageRow
      if (last && last.state !== 'done') {
        thread = last
        message = this.insertPost(thread.id, caller, 'note', body, {}, {}, now, undefined, [input.assignee])
        // The child has it in hand again: the move the old path would have made when its turn started
        if (thread.state === 'open' || thread.state === 'review') {
          thread = this.records.updateThread(thread.id, { state: 'running', stateSince: now }, now, true)
          this.insertEvent(thread.id, `State: ${last.state} to running.`, { change: 'state', from: last.state, to: 'running', by: CENTRALU }, now)
        }
      } else {
        const subject = oneLineText(body.split(/\r\n|[\n\r\u0085\u2028\u2029]/)[0] ?? '', SUBJECT_MAX) || 'A task'
        const id = threadIdOf(this.host, this.ulids.next(now))
        this.records.insertThread(
          {
            id,
            home: this.host,
            projectId: input.projectId ?? null,
            subject,
            origin: input.origin,
            depth: 0,
            parentId: null,
            follows: last ? [last.id] : [],
            state: 'running',
            owner: caller,
            assignee: input.assignee,
            next: null,
            links: {},
          },
          now,
        )
        this.records.putParticipant(id, caller, 'owner', now)
        this.records.putParticipant(id, input.assignee, 'assignee', now)
        message = this.insertPost(id, caller, 'assign', body, {}, {}, now, undefined, [input.assignee])
        thread = this.mustThread(id)
      }
      // The old path delivered it already: delivered, and read with it
      this.records.markDelivered(input.assignee, [message.id], [message.id], now)
      return { thread, message, continued: last !== undefined && last.state !== 'done' }
    })
  }

  /** Stores a message and one receipt for each recipient. A reply counts as having handled what the sender was sent and has read */
  private insertPost(
    threadId: string,
    sender: string,
    kind: MessageKind,
    body: string,
    facts: MailFacts,
    flags: { urgent?: boolean; needsOwner?: boolean; wake?: boolean; dedupeKey?: string },
    now: number,
    replyTo: string | undefined,
    to?: string[],
  ): MessageRow {
    const urgent = flags.urgent === true
    const message = this.records.insertMessage({
      id: messageIdOf(this.host, this.ulids.next(now)),
      threadId,
      sender,
      kind,
      urgent,
      needsOwner: flags.needsOwner === true,
      wake: flags.wake === undefined ? null : flags.wake ? 'yes' : 'no',
      replyTo: replyTo ?? null,
      body,
      facts,
      dedupeKey: flags.dedupeKey ?? null,
      createdAt: now,
    })
    if (kind !== 'event') {
      const recipients = to ?? this.recipients(threadId, sender)
      this.changed(threadId, recipients)
      for (const r of unique(recipients)) {
        if (r === sender) continue
        this.records.insertReceipt(message.id, r, dueAt(now, urgent, sender === PERSON))
      }
      if (sender !== CENTRALU && kind !== 'notice' && kind !== 'assign') {
        this.records.markHandled(threadId, sender, message.seq - 1, now, true)
      }
    }
    return message
  }

  /** The thread's active participants other than the sender: who a post is for. Centralu is never one */
  private recipients(threadId: string, sender: string): string[] {
    return this.records
      .participants(threadId)
      .filter((p) => p.leftAt === null && p.address !== sender && p.address !== CENTRALU)
      .map((p) => p.address)
  }

  private duplicate(threadId: string, sender: string, key: string | undefined): MessageRow | undefined {
    if (key === undefined) return undefined
    checkDedupeKey(key)
    if (key.startsWith(OPENING)) throw refuse('bad_value', `a dedupe key does not start with ${OPENING}: it is the opening's`)
    return this.records.messageByDedupeKey(threadId, sender, key)
  }

  private duplicateOpening(sender: string, key: string): MessageRow | undefined {
    checkDedupeKey(key)
    return this.records.openingMessageByDedupeKey(sender, OPENING + key)
  }

  private checkReplyTo(threadId: string, replyTo: string): void {
    const to = this.records.message(replyTo)
    if (!to || to.threadId !== threadId) throw refuse('bad_value', `${replyTo} is not a message of this thread`)
  }

  /** The flags a sender may set: `urgent` for sessions and the person, `needsOwner` and `wake` for an app (§3.2) */
  private checkFlags(sender: SenderClass, flags: { urgent?: boolean; needsOwner?: boolean; wake?: boolean }): void {
    if (flags.urgent === true && sender !== 'session' && sender !== 'person') {
      throw refuse('field_not_allowed', 'only a session or the person marks mail urgent')
    }
    if ((flags.needsOwner !== undefined || flags.wake !== undefined) && sender !== 'app') {
      throw refuse('field_not_allowed', 'needsOwner and wake are an app’s requests')
    }
  }

  private checkBody(sender: SenderClass, body: unknown, mayBeEmpty: boolean): string {
    if (typeof body !== 'string') throw refuse('bad_value', 'a body is text')
    if (!mayBeEmpty && body.trim() === '') throw refuse('empty', 'a post says something')
    if (body.length > bodyLimit(sender)) throw refuse('too_long', `a body from ${sender === 'app' ? 'an app' : 'this sender'} is at most ${bodyLimit(sender)} characters`)
    return body
  }

  /** A session posts at most 30 a minute and an app 10, counted in the store so that a restart does not reset it (§7.9) */
  private checkRate(sender: SenderClass, caller: string, now: number): void {
    const limit = postsPerMinute(sender)
    if (limit === Infinity) return
    if (this.records.postsSince(caller, this.host, messageIdFloor(this.host, now - 60_000)) >= limit) {
      throw refuse('rate_limited', `at most ${limit} posts a minute from ${sender === 'app' ? 'an app' : 'a session'}: wait a minute`)
    }
  }

  private mayWriteOrRefuse(from: string, to: string, thread: ThreadRow | null): void {
    const cannot = this.policy.cannotRead?.(to) ?? null
    if (cannot !== null) throw refuse('no_mailbox', cannot, { to })
    const why = this.policy.mayWrite(from, to, thread)
    if (why !== null) throw refuse('policy', why, { from, to })
  }

  /** An address that parses and lives on this host. A party on another host is slice 4 */
  private party(address: string): Party {
    const party = typeof address === 'string' ? parseAddress(address) : null
    if (!party) throw refuse('bad_address', `Not a mail address: ${JSON.stringify(address)}`)
    if ((party.kind === 'session' || party.kind === 'app') && party.host !== this.host) {
      throw refuse('not_local', `${address} is on another host: mail across machines is not built yet`)
    }
    return party
  }

  private mustThread(id: string): ThreadRow {
    const thread = this.records.thread(id)
    if (!thread) throw refuse('not_found', `Thread not found: ${id}`)
    return thread
  }

  /** What `address` is in the thread, or null when it is not in it */
  private standing(thread: ThreadRow, address: string): Standing | null {
    const party = parseAddress(address)
    if (!party) return null
    if (party.kind === 'centralu') return 'centralu'
    if (party.kind === 'person') return 'person'
    const active = this.records.participants(thread.id).find((p) => p.address === address && p.leftAt === null)
    if (!active) return null
    if (thread.owner === address) return 'owner'
    if (thread.assignee === address) return 'assignee'
    return 'member'
  }
}

function doneRefusal(thread: ThreadRow) {
  return refuse('thread_done', `this thread is done; open a follow-up (mail send with follows: ${thread.id})`, { thread: thread.id })
}

/** An input that names its sender is refused: the caller is an argument of the call, so a spread of tool input cannot forge it */
function rejectUnknown(input: object, allowed: ReadonlySet<string>, what: string): void {
  for (const key of Object.keys(input)) {
    if (key === 'facts') throw refuse('field_not_allowed', 'facts are written by Centralu only: a sender cannot set them')
    if (key === 'from' || key === 'by') throw refuse('field_not_allowed', `${key} is not a field of ${what}: the caller is the call's own argument`)
    if (!allowed.has(key)) throw refuse('field_not_allowed', `${key} is not a field of ${what}`)
  }
}

function checkDedupeKey(key: string): void {
  if (!key || key.length > MAX_DEDUPE_KEY) throw refuse('bad_value', `a dedupe key is 1 to ${MAX_DEDUPE_KEY} characters`)
}

/** The key a thread was opened under is stored with this in front, and a post's key may not start with it */
const OPENING = 'open:'

function unique<T>(list: readonly (T | undefined)[]): T[] {
  return [...new Set(list.filter((x): x is T => x !== undefined))]
}

function nonNegativeInt(value: number, what: string): number {
  if (!Number.isInteger(value) || value < 0) throw refuse('bad_value', `${what} is a whole number, 0 or more`)
  return value
}

/** `links` as GitHub numbers: `issue` and `pr`, each a list of at most 20 positive whole numbers. No other field is taken from a sender */
function checkLinks(links: MailLinks): MailLinks {
  if (!isObj(links)) throw refuse('bad_value', 'links is an object with issue and pr')
  for (const key of Object.keys(links)) {
    if (key !== 'issue' && key !== 'pr') throw refuse('field_not_allowed', `links has issue and pr, not ${key}`)
  }
  const out: MailLinks = { ...links }
  for (const key of ['issue', 'pr'] as const) {
    const list = links[key]
    if (list === undefined) continue
    if (!Array.isArray(list) || list.length > MAX_LINKS || !list.every((n) => Number.isInteger(n) && n > 0)) {
      throw refuse('bad_value', `links.${key} is a list of at most ${MAX_LINKS} GitHub numbers`)
    }
    out[key] = [...new Set(list)]
  }
  return out
}

/** The session a report is about, from Centralu's facts, when it parses as an address */
function aboutOf(facts: MailFacts): string | undefined {
  const session = asObj(facts.about).session
  return typeof session === 'string' && parseAddress(session) ? session : undefined
}

/** The compact line of a delivery (§9.2): drawn from Centralu's record, never a bubble of anyone's, and with no name another party wrote */
function deliveryLine(messages: number, threads: number, relations: ReadonlySet<string>): string {
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`
  return `✉ ${n(messages, 'message', 'messages')} in ${n(threads, 'thread', 'threads')}, from ${[...relations].join(', ')}`
}

/** Centralu's word for how the sender stands to the receiver in this thread (§7.3). Never a name another party wrote */
export function relationWord(recipient: string, sender: string, thread: ThreadRow): string {
  const party = parseAddress(sender)
  if (party?.kind === 'centralu') return 'Centralu'
  if (party?.kind === 'person') return 'the person'
  if (party?.kind === 'app') return recipient === thread.owner ? 'an app you called' : 'an app in this thread'
  if (sender === thread.owner) return 'the session that gave you this work'
  if (sender === thread.assignee && recipient === thread.owner) return 'the session you gave this work to'
  return 'another session in this thread'
}
