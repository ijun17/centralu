import { errorMessage, oneLineText, type MailHeldRow, type MailMessage, type MailParty, type MailThreadRow, type MailThreadView } from '@cc/protocol'
import type { MessageRow } from '../dev-services/store/mail.js'
import type { MailboxRecords, MailRow, RecipientRow } from '../dev-services/store/mailbox.js'
import { PERSON, parseAddress } from './address.js'
import type { MailDelivery } from './delivery.js'
import type { MessageService } from './messages.js'
import { refuse } from './rules.js'

/** What the person's side needs to know of a session to name it: nothing the mailbox keeps */
export type PersonHost = {
  session(sessionId: string): { name: string; state: string } | undefined
  /** The last messages of an old thread, read-only: the history of a message moved from it (§6.3, `Store.legacyChain`) */
  legacyChain(threadId: string): MessageRow[]
  /** A project's name as the person knows it (`MailReach.projectLabel`) */
  projectLabel(projectId: string): string
  /** Whether the project is not trusted (`MailReach.untrusted`, §7.2) */
  untrusted(projectId: string): boolean
  /** The turn going in the session, from the turn records (`MailTurns.current`, while the session is in a turn): its work message, else its starter */
  turnOn(sessionId: string): { work: string | null; startedAt: number } | undefined
  /**
   * A chain the person closed was the session's work: stop its turn on it when `stopped` (with the background work that turn started), and tell it
   * `text` without a wake (`SessionManager.mailWorkClosed`)
   */
  closed(c: { sessionId: string; stopped: boolean; text: string; since?: number }): void
}

/** How the person closes a chain: Mark done is `finished`, Drop is `dropped` */
export type CloseOutcome = 'finished' | 'failed' | 'stopped' | 'dropped'

/** How many messages one `mail.thread` returns; `more` says there are further ones */
const THREAD_PAGE = 100
/** How many chains the list shows, and how many of the person's newest messages it reads to find them */
const LIST_CHAINS = 100
const LIST_SCAN = 1_000
/** A chain is read whole for the window up to this many messages: its newest ones */
const CHAIN_CAP = 1_000
const PREVIEW_CHARS = 140
const SUBJECT_CHARS = 80
/** Holds the window shows for the person to act on (`mail.held`), and the ones its Release and Dismiss may change */
const PERSON_HOLDS = ['uncertain', 'failed', 'loop', 'budget', 'policy'] as const

/** A message as the window reads it: a moved one with the thread kind it had, a new one in the window's thread words */
type Shown = { m: MailRow; seq: number }

/**
 * The person's side of the mailbox (#1347, docs/plans/mailbox.md §12, M3a-person) over the message tables. The window of this build draws threads;
 * here a thread is a chain of replies, named by its root message's id, so the window shows what the message service holds and writes through it: the
 * person's words are theirs by who is asking (§7.1), and go out at once through the same service a session's send does.
 *
 * Parties come back as Centralu names them (the session's name in the sidebar, an app's id), never as a name they gave themselves.
 */
export class MailPerson {
  constructor(
    private readonly service: MessageService,
    private readonly records: MailboxRecords,
    private readonly delivery: Pick<MailDelivery, 'resumeSession' | 'resumeRoot' | 'answerCrowd' | 'crowdWaiting' | 'poke'>,
    private readonly host: PersonHost,
  ) {}

  list(): { threads: MailThreadRow[]; held: MailHeldRow[]; waiting: number } {
    const heldRows = this.records.heldRows()
    const heldBy = new Map<string, number>()
    const held: MailHeldRow[] = []
    for (const r of heldRows) {
      const m = this.records.message(r.messageId)
      if (!m || r.held === null) continue
      heldBy.set(m.rootId, (heldBy.get(m.rootId) ?? 0) + 1)
      held.push({
        messageId: m.id,
        threadId: m.rootId,
        subject: this.subjectOf(m.rootId),
        sender: this.party(m.sender),
        recipient: this.party(r.recipient),
        kind: windowKind(m),
        reason: r.held,
        preview: oneLineText(m.body, PREVIEW_CHARS),
        since: m.createdAt,
      })
    }
    const roots: string[] = []
    for (const m of this.records.feedOf(PERSON, { limit: LIST_SCAN })) {
      if (!roots.includes(m.rootId)) roots.push(m.rootId)
      if (roots.length >= LIST_CHAINS) break
    }
    const threads = roots
      .map((root) => this.row(root, heldBy.get(root) ?? 0))
      .flatMap((r) => r ?? [])
      .sort((a, b) => Number(b.unread > 0) - Number(a.unread > 0) || b.updatedAt - a.updatedAt)
    return { threads, held, waiting: this.delivery.crowdWaiting() }
  }

  /** A chain with its messages, which the person reads: what is returned is read for them. An old thread's id names the chain moved from it */
  thread(threadId: string, opts: { after?: number | undefined; all?: boolean | undefined; tail?: number | undefined; before?: number | undefined } = {}): MailThreadView {
    // An old thread's id opens the newest chain moved from it
    const root = this.rootsOf(threadId)[0]
    if (root === undefined) throw refuse('unknown_message', `There is no mail ${threadId} kept.`)
    const all = this.shown(root)
    let page: Shown[]
    if (opts.after !== undefined) page = all.filter((s) => s.seq > (opts.after ?? 0)).slice(0, opts.all ? undefined : THREAD_PAGE)
    else if (opts.tail !== undefined || !opts.all) {
      const upTo = opts.before === undefined ? all : all.filter((s) => s.seq < (opts.before ?? 0))
      page = upTo.slice(-Math.min(opts.tail ?? THREAD_PAGE, THREAD_PAGE))
    } else page = all
    // Read for the person: every window's list hears it
    if (this.records.markRead(PERSON, page.flatMap((s) => (this.records.recipient(s.m.id, PERSON)?.readAt === null ? [s.m.id] : [])), Date.now()) > 0) this.service.announce()
    const first = page[0]?.seq
    const last = page.at(-1)?.seq
    const legacy = this.legacyOf(all[0]?.m)
    const fromStart = first === undefined || first === all[0]?.seq
    const messages = [...(fromStart ? legacy : []).map((m, i) => legacyMessage(m, i - legacy.length + 1, (a) => this.party(a))), ...page.map((s) => this.message(s))]
    return {
      thread: this.row(root, this.heldIn(root)) ?? this.emptyRow(root),
      parties: this.partiesOf(all.map((s) => s.m)),
      blockers: [],
      messages,
      more: last !== undefined && all.some((s) => s.seq > last),
      older: first !== undefined && all.some((s) => s.seq < first),
      follows: [],
    }
  }

  /**
   * The person writes in a chain (every chain an old thread's id names): an answer to the newest question to them that waits for their answer, else to
   * the newest message sent to them, to its sender; else a word more to the ones the person's own newest message went to. A sender that is gone, and a
   * message hidden from the person, are passed over. A question waits for an answer (D3); an answer or a note does not
   */
  reply(threadId: string, text: string, kind: 'note' | 'answer' | 'question' = 'note'): MailThreadView {
    const chain = this.rootsOf(threadId)
      .flatMap((root) => this.shown(root).map((s) => s.m))
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    // Only what was sent to the person is theirs to answer: a message held for them to act on is not
    const toPerson = chain.filter((m) => {
      const row = this.records.recipient(m.id, PERSON)
      return m.sender !== PERSON && parseAddress(m.sender)?.kind !== 'centralu' && row !== undefined && !hiddenFromPerson(row) && this.here(m.sender)
    })
    const open = toPerson.findLast((m) => {
      const row = this.records.recipient(m.id, PERSON)
      return m.needsReply && row !== undefined && row.answerId === null && (row.settled === null || row.settled === 'legacy')
    })
    const theirs = open ?? toPerson.at(-1)
    const mine = chain.findLast((m) => m.sender === PERSON && this.records.recipients(m.id).some((r) => this.here(r.recipient)))
    const target = theirs ?? mine
    if (!target) throw refuse('unknown_message', `There is no message in ${threadId} to answer.`)
    const to = target === theirs ? [target.sender] : this.records.recipients(target.id).flatMap((r) => (this.here(r.recipient) ? [r.recipient] : []))
    const sent = this.service.send(PERSON, { to, text, replyTo: target.id, needsReply: kind === 'question' })
    const at = this.shown(target.rootId).find((s) => s.m.id === sent.message.id)?.seq ?? 1
    return this.thread(target.rootId, { after: at - 1 })
  }

  /** Whether mail to `address` can still reach it: a session this host keeps (trashed or deleted ones are gone), or any other party */
  private here(address: string): boolean {
    const party = parseAddress(address)
    return party?.kind !== 'session' || this.host.session(party.sessionId) !== undefined
  }

  /**
   * The person's Mark done (`finished`) or Drop (`dropped`), on the whole chain and on every chain an old thread's id names: nothing in it waits for them
   * any more, their own questions in it wait for no answer, and the tasks they gave in it are closed, so no report of them opens it again. A session
   * whose turn is on the chain (the turn records say so) is stopped, and it and every session the person's open task in it went to are told once, in
   * Centralu's words (3.10). Nothing is withdrawn: what the person sent is still delivered
   */
  close(threadId: string, outcome: CloseOutcome = 'finished'): MailThreadRow {
    const roots = this.rootsOf(threadId)
    const root = roots[0]
    if (root === undefined) throw refuse('unknown_message', `There is no mail ${threadId} kept.`)
    const now = Date.now()
    // Every chain an old thread's id names: the window showed them as one thread
    for (const r of roots) {
      const chain = this.chainOf(r)
      const working = this.workers(chain)
      // The sessions whose work it was: one in a turn on it, and each one a task of the person's in it went to that has not reported
      const helpers = new Set(working.map((w) => w.sessionId))
      for (const m of chain) {
        if (m.sender !== PERSON || m.kind !== 'task') continue
        for (const row of this.records.recipients(m.id)) {
          const party = parseAddress(row.recipient)
          if (party?.kind === 'session' && row.settled === null && this.here(row.recipient)) helpers.add(party.sessionId)
        }
      }
      // What the person reads of it: a row held out of their sight is not theirs to close
      this.records.closeFor(
        PERSON,
        this.shown(r).map((s) => s.m.id),
        now,
      )
      for (const m of chain) {
        if (m.sender === PERSON && (m.needsReply || m.kind === 'task')) for (const row of this.records.recipients(m.id)) this.records.settle(m.id, row.recipient, 'done', now)
      }
      this.records.markClosed(r, outcome, now)
      for (const sessionId of helpers) {
        const turn = working.find((w) => w.sessionId === sessionId)
        this.host.closed({ sessionId, stopped: turn !== undefined, text: closedWords(r, outcome, turn !== undefined), ...(turn ? { since: turn.startedAt } : {}) })
      }
      // The window that has the chain open reads it again
      this.service.announce(r)
    }
    return this.row(root, this.heldIn(root)) ?? this.emptyRow(root)
  }

  /**
   * The person's Release (Send again, Retry) or Dismiss of held rows. A row held for a session's budget goes as the mail it is and is not held again. A
   * row held for its project's trust goes when the person trusts the project (§7.4): its Release says so. A dismissed answer leaves its question open (D8)
   */
  held(action: 'release' | 'dismiss', recipient: string, messageIds: string[]): { changed: number } {
    if (action === 'dismiss') return { changed: this.service.dismissHeld(recipient, messageIds, PERSON_HOLDS) }
    const projects = new Set(messageIds.flatMap((id) => (this.records.recipient(id, recipient)?.held === 'policy' ? (this.records.message(id)?.senderProject ?? []) : [])))
    // Refused whole before anything changes: a Release that let some rows go and refused the rest would leave the window guessing which
    const still = [...projects].find((p) => this.host.untrusted(p))
    if (still !== undefined) throw refuse('untrusted_project', `${this.host.projectLabel(still)} is not trusted: what its sessions send out of it waits until you trust the project, and then goes in order.`)
    // A project trusted since (its trust's release did not reach these rows): what it holds goes now, in order
    const policy = messageIds.filter((id) => this.records.recipient(id, recipient)?.held === 'policy')
    for (const p of projects) this.trusted(p)
    // What the trust let go counts as released here too
    const letGo = policy.filter((id) => this.records.recipient(id, recipient)?.held !== 'policy').length
    return { changed: letGo + this.service.resendHeld(recipient, messageIds, ['uncertain', 'failed', 'budget']) }
  }

  /** Resume on a session's paused mail, or on a chain's (an old thread's id names the chains moved from it) */
  resume(target: { sessionId?: string | undefined; threadId?: string | undefined }): void {
    if (target.sessionId !== undefined) this.delivery.resumeSession(target.sessionId)
    else if (target.threadId !== undefined) for (const root of this.rootsOf(target.threadId)) this.delivery.resumeRoot(root)
  }

  /** The person trusted a project (§7.4): what its sessions sent that was held for it goes, in order, and the callers refused are told */
  trusted(projectId: string): void {
    for (const address of this.service.trustChanged(projectId)) {
      const party = parseAddress(address)
      if (party?.kind === 'session') this.delivery.poke(party.sessionId)
    }
    this.service.announce()
  }

  /** A project was deleted: the mail held for its trust is dropped and its senders are told, naming it as it was named (§7.4) */
  projectDeleted(projectId: string, name: string): void {
    this.service.dismissProject(projectId, name)
    this.service.announce()
  }

  /** The project's name now, for `projectDeleted` once it is gone */
  projectName(projectId: string): string {
    return this.host.projectLabel(projectId)
  }

  /**
   * The answer is taken at once: waking a crowd resumes the sessions two at a time and takes as long as that takes, longer than a
   * window waits for an answer. The list shows who is still waiting as it goes
   */
  wake(wake: boolean): void {
    this.delivery.answerCrowd(wake).catch((e: unknown) => console.error(`[mail] waking the sessions failed: ${errorMessage(e)}`))
  }

  // ── Chains ──

  /** Every message of the chain, readable by the person or not: what a turn's work may be */
  private chainOf(root: string): MailRow[] {
    return this.records.numbered(root, CHAIN_CAP).map(({ m }) => m)
  }

  /** The sessions of the chain whose turn going now is on it: the turn records name a message of the chain as that turn's work (or its starter) */
  private workers(chain: readonly MailRow[]): { sessionId: string; address: string; startedAt: number }[] {
    const ids = new Set(chain.map((m) => m.id))
    const sessions = new Map<string, string>()
    for (const m of chain) {
      for (const address of [m.sender, ...this.records.recipients(m.id).map((r) => r.recipient)]) {
        const party = parseAddress(address)
        if (party?.kind === 'session') sessions.set(party.sessionId, address)
      }
    }
    return [...sessions].flatMap(([sessionId, address]) => {
      const turn = this.host.turnOn(sessionId)
      return turn && turn.work !== null && ids.has(turn.work) ? [{ sessionId, address, startedAt: turn.startedAt }] : []
    })
  }

  /** Every chain an id names: a message's root, or each chain moved from an old thread, newest first */
  private rootsOf(id: string): string[] {
    const m = this.records.message(id)
    return m ? [m.rootId] : this.records.movedFrom(id)
  }

  /**
   * The chain's messages the person may read, in the order they were stored, each numbered for the window by its own row number: a message that comes,
   * goes or stops being readable leaves the others' numbers as they were, so the window's `after` misses nothing
   */
  private shown(root: string): Shown[] {
    return this.records
      .numbered(root, CHAIN_CAP)
      .map(({ m, n }) => ({ m, seq: n }))
      .filter((s) => this.readable(s.m))
  }

  /** The person reads what they sent, what was sent to them, and what is held for them to act on (§5.5, §7.4) */
  private readable(m: MailRow): boolean {
    if (m.sender === PERSON) return true
    return this.records.recipients(m.id).some((r) => (r.recipient === PERSON && !hiddenFromPerson(r)) || isPersonHold(r.held))
  }

  /** An old thread's messages before the first one moved from it: the chain's history, read-only (§6.3) */
  private legacyOf(first: MailRow | undefined): MessageRow[] {
    if (!first?.legacyThread) return []
    const moved = new Set(this.records.byRoot(first.rootId, { limit: CHAIN_CAP }).map((m) => m.id))
    const earlier: MessageRow[] = []
    for (const m of this.host.legacyChain(first.legacyThread)) {
      if (m.id === first.id || moved.has(m.id)) break
      earlier.push(m)
    }
    return earlier
  }

  private heldIn(root: string): number {
    return this.records.heldRows().filter((r) => this.records.message(r.messageId)?.rootId === root).length
  }

  private subjectOf(root: string): string {
    const first = this.shown(root)[0]?.m ?? this.records.message(root)
    return first ? oneLineText(first.body, SUBJECT_CHARS) : root
  }

  /**
   * A chain as the window's list row. Done when the person closed it (`facts.closed` on its root, or an older close: a row to them settled `done`) and
   * nothing in it waits for them or for an answer to them, with how they closed it. Otherwise running while a session's turn is on it or a task the person gave in it is
   * not reported, in review once such a task is reported, and open for the rest; the person may always write in a chain that is not done. The session
   * named on it is the one whose turn is on it, else the first one the person's first message went to
   */
  private row(root: string, held: number): MailThreadRow | null {
    const all = this.shown(root).map((s) => s.m)
    const first = all[0]
    const last = all.at(-1)
    if (!first || !last) return null
    const toPerson = all.flatMap((m) => this.records.recipient(m.id, PERSON) ?? [])
    const tasks = all.filter((m) => m.sender === PERSON && m.kind === 'task').flatMap((m) => this.records.recipients(m.id).filter((r) => parseAddress(r.recipient)?.kind === 'session'))
    const waits =
      toPerson.some((r) => r.settled === null) ||
      all.some((m) => m.sender === PERSON && (m.needsReply || m.kind === 'task') && this.records.recipients(m.id).some((r) => r.settled === null))
    // Closed by the person: a row to them or a task of theirs settled `done`, or the close recorded on the root (a task to a session gone since)
    const closedAs = this.records.message(root)?.facts.closed?.outcome
    const done = (closedAs !== undefined || toPerson.some((r) => r.settled === 'done') || tasks.some((r) => r.settled === 'done')) && !waits
    const working = done ? [] : this.workers(this.chainOf(root))
    const state = done ? 'done' : working.length > 0 || tasks.some((r) => r.settled === null) ? 'running' : tasks.some((r) => r.settled === 'reported') ? 'review' : 'open'
    const assignee = working[0]?.address ?? (first.sender === PERSON ? this.records.recipients(first.id)[0]?.recipient : undefined)
    return {
      id: root,
      subject: oneLineText(first.body, SUBJECT_CHARS),
      state,
      outcome: done ? (closedAs ?? 'finished') : null,
      next: null,
      projectId: first.senderProject,
      owner: this.party(first.sender),
      assignee: assignee === undefined ? null : this.party(assignee),
      unread: toPerson.filter((r) => r.readAt === null && !hiddenFromPerson(r)).length,
      held,
      blocked: 0,
      working: working.length > 0,
      createdAt: first.createdAt,
      updatedAt: last.createdAt,
      last: { sender: this.party(last.sender), kind: windowKind(last), preview: oneLineText(last.body, PREVIEW_CHARS), at: last.createdAt },
    }
  }

  /** A chain whose every message the person may not read (held for them, then let go): a row with nothing in it */
  private emptyRow(root: string): MailThreadRow {
    const m = this.records.message(root)
    const at = m?.createdAt ?? 0
    return { id: root, subject: m ? oneLineText(m.body, SUBJECT_CHARS) : root, state: 'open', outcome: null, next: null, projectId: null, owner: this.party(m?.sender ?? PERSON), assignee: null, unread: 0, held: 0, blocked: 0, working: false, createdAt: at, updatedAt: at, last: null }
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

  private partiesOf(chain: readonly MailRow[]): MailThreadView['parties'] {
    const addresses = new Set<string>()
    for (const m of chain) {
      addresses.add(m.sender)
      for (const r of this.records.recipients(m.id)) addresses.add(r.recipient)
    }
    return [...addresses].filter((a) => parseAddress(a)?.kind === 'session' || parseAddress(a)?.kind === 'app').map((a) => ({ party: this.party(a), role: 'member' }))
  }

  private message({ m, seq }: Shown): MailMessage {
    return {
      id: m.id,
      seq,
      sender: this.party(m.sender),
      kind: windowKind(m),
      urgent: m.urgent,
      body: m.body,
      facts: { ...m.facts },
      createdAt: m.createdAt,
      ...(m.sender === PERSON
        ? { receipts: this.records.recipients(m.id).map((r) => ({ recipient: this.party(r.recipient), delivered: r.deliveredAt !== null, read: r.readAt !== null, handled: r.settled !== null })) }
        : {}),
    }
  }
}

/** What a session whose work the person closed is told, in main's words (3.10): what the person did, whether its turn was stopped, and not to go on */
function closedWords(root: string, outcome: CloseOutcome, stopped: boolean): string {
  const what = outcome === 'dropped' ? 'dropped' : outcome === 'finished' ? 'marked done' : 'closed'
  return `The person ${what} thread ${root}${stopped ? '; its work was stopped' : ''}. Do not continue it.`
}

/** The thread word the window shows for a message: a moved one's own (`legacyKind`), else what the message is in the thread words */
function windowKind(m: MailRow): string {
  if (typeof m.facts.legacyKind === 'string') return m.facts.legacyKind
  if (m.kind === 'task') return 'assign'
  if (m.kind === 'message') return m.needsReply ? 'question' : m.replyTo === null ? 'note' : 'answer'
  return m.kind
}

/** An old thread's message, numbered before the chain's first (0, -1, …): history the window shows above it */
function legacyMessage(m: MessageRow, seq: number, party: (address: string) => MailParty): MailMessage {
  return { id: m.id, seq, sender: party(m.sender), kind: m.kind, urgent: m.urgent, body: m.body, facts: { ...m.facts }, createdAt: m.createdAt }
}

function isPersonHold(held: string | null): boolean {
  return PERSON_HOLDS.some((h) => h === held)
}

/** A row to the person kept from them: held out (§5.5), withdrawn by its sender, or dismissed */
function hiddenFromPerson(r: RecipientRow): boolean {
  return r.held === 'policy' || r.held === 'loop' || r.held === 'dismissed' || r.settled === 'withdrawn' || r.settled === 'gone'
}
