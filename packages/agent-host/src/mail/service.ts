import { oneLineText } from '@cc/protocol'
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
  type ThreadOrigin,
  type ThreadOutcome,
  type ThreadPatch,
  type ThreadRow,
  type ThreadState,
} from '../dev-services/store/mail.js'
import { CENTRALU, PERSON, parseAddress, type Party } from './address.js'
import { buildMailFrame, type MailFrameItem } from './frame.js'
import { UlidMaker, messageIdOf, parseMailId, threadIdOf } from './ids.js'
import {
  MAX_BLOCKERS,
  NEXT_MAX,
  SUBJECT_MAX,
  bodyLimit,
  dueAt,
  flowsDown,
  mayEditTask,
  mayPostKind,
  refuse,
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

export type PostResult = { message: MessageRow; thread: ThreadRow; duplicate: boolean }

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

export type ThreadView = { thread: ThreadRow; participants: ParticipantRow[]; blockers: BlockerRow[]; messages: ReadMessage[] }

export type ReadOptions = {
  /** From the start, not from where the reader last read */
  all?: boolean
  /** From after this `seq` (overrides the cursor) */
  after?: number
  /** Do not mark what is returned read (the board and the Inbox list; a peek) */
  peek?: boolean
}

/** What a delivery to one receiver would send now (§7.5, §7.6) */
export type DrainResult = {
  /** The wake frame; empty when there is nothing to say */
  text: string
  /** Every message the text tells of */
  messageIds: string[]
  /** Those whose words are in the text whole (they flow down). Read on acceptance, and never sent again */
  inline: string[]
  /** Those the text only points at: delivered, still unread */
  pointed: string[]
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

    return this.records.transaction(() => {
      const now = this.now()
      // Opened again under the same key by the same caller: the thread that exists, not a second one
      if (input.dedupeKey !== undefined) {
        const first = this.duplicateOpening(caller, input.dedupeKey)
        if (first) return { message: first, thread: this.mustThread(first.threadId), duplicate: true, offered: [] }
      }
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

      const message = this.insertPost(id, caller, input.kind, body, {}, input, now, undefined)
      const offered = unique((input.follows ?? []).flatMap((f) => this.records.participants(f).filter((p) => p.leftAt === null).map((p) => p.address))).filter(
        (a) => a !== caller,
      )
      return { message, thread: this.mustThread(id), duplicate: false, offered }
    })
  }

  /** A post from a sender into a thread. The sender writes the words; Centralu writes the facts, so `facts` is refused */
  post(threadId: string, caller: string, input: PostInput): PostResult {
    rejectUnknown(input, POST_KEYS, 'post')
    return this.records.transaction(() => {
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
      const wrong = mayPostKind(sender.kind, standing, input.kind)
      if (wrong) throw refuse('kind_not_allowed', wrong)
      this.checkFlags(sender.kind, input)
      const body = this.checkBody(sender.kind, input.body, false)
      if (input.replyTo !== undefined) this.checkReplyTo(thread.id, input.replyTo)

      for (const to of this.recipients(thread.id, caller)) this.mayWriteOrRefuse(caller, to, thread)
      // The person writes into any thread, and from then on is in it (the Inbox's reply box, §10.1); a role they have stays
      if (sender.kind === 'person') this.records.putParticipantIfAbsent(thread.id, PERSON, 'member', now)
      const message = this.insertPost(thread.id, caller, input.kind, body, {}, input, now, input.replyTo)
      let after = thread
      if (thread.state === 'review' && reopensReview(standing, input.kind)) {
        after = this.moveState(thread, { state: 'running' }, now, { change: 'state', from: 'review', to: 'running', by: caller }, 'The owner sent more: the thread is running again.')
      }
      return { message, thread: after, duplicate: false }
    })
  }

  /** What only Centralu does: write `facts`, post an `event`, and add an event to a thread that is done (§3.3) */
  postAsCentralu(threadId: string, input: CentraluPost): PostResult {
    return this.records.transaction(() => {
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
    return this.records.transaction(() => {
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
    return this.records.transaction(() => {
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
    const messages = this.records.messagesAfter(thread.id, after)
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
    return this.records.transaction(() => {
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
    return this.records.transaction(() => {
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
    return this.records.transaction(() => {
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
    return this.records.transaction(() => {
      const thread = this.mustThread(threadId)
      if (this.party(by).kind !== 'person') throw refuse('not_allowed', 'only the person pins a thread')
      return this.records.updateThread(thread.id, { pinnedAt: pinned ? this.now() : null }, this.now(), false)
    })
  }

  /**
   * A session or app that has gone (trashed or deleted) leaves the work it held (§3.3): a thread it was assigned is
   * `open` with no assignee, a thread it owned is the person's. Each leaves an `event`. Done threads are not touched.
   * Called by the manager when a session goes to the trash, wired in slice 2 before the `mail` tool can open a thread that names a session
   */
  partyGone(address: string): ThreadRow[] {
    this.party(address)
    return this.records.transaction(() => {
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
  drain(recipient: string, opts: { again?: boolean } = {}): DrainResult {
    this.party(recipient)
    const items: MailFrameItem[] = []
    for (const { receipt, message, thread } of this.records.pendingFor(recipient, this.now(), opts.again === true)) {
      if (thread.state === 'done' || thread.state === 'unknown' || message.kind === 'event' || message.sender === recipient) continue
      if (this.policy.mayWrite(message.sender, recipient, thread) !== null) continue
      const sender = parseAddress(message.sender)?.kind
      const down = flowsDown(sender === 'person', sender === 'session' && message.sender === thread.owner, recipient === thread.assignee, message.kind)
      if (down && receipt.deliveredAt !== null) continue
      const about = aboutOf(message.facts)
      const outcome = typeof message.facts.outcome === 'string' ? message.facts.outcome : undefined
      items.push({
        messageId: message.id,
        threadId: thread.id,
        kind: message.kind,
        from: message.sender,
        relation: relationWord(recipient, message.sender, thread),
        ...(about ? { about } : {}),
        ...(outcome ? { outcome } : {}),
        ...(down ? { inline: message.body } : {}),
      })
    }
    const frame = buildMailFrame(items)
    return { text: frame.text, messageIds: frame.shown, inline: frame.inline, pointed: frame.shown.filter((id) => !frame.inline.includes(id)) }
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
      this.records.transaction(() => {
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
    return this.records.messageByDedupeKey(threadId, sender, key)
  }

  private duplicateOpening(sender: string, key: string): MessageRow | undefined {
    checkDedupeKey(key)
    return this.records.openingMessageByDedupeKey(sender, key)
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

  private mayWriteOrRefuse(from: string, to: string, thread: ThreadRow | null): void {
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

/** Centralu's word for how the sender stands to the receiver in this thread (§7.3). Never a name another party wrote */
function relationWord(recipient: string, sender: string, thread: ThreadRow): string {
  const party = parseAddress(sender)
  if (party?.kind === 'centralu') return 'Centralu'
  if (party?.kind === 'person') return 'the person'
  if (party?.kind === 'app') return recipient === thread.owner ? 'an app you called' : 'an app in this thread'
  if (sender === thread.owner) return 'the session that gave you this work'
  if (sender === thread.assignee && recipient === thread.owner) return 'the session you gave this work to'
  return 'another session in this thread'
}
