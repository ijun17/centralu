import { errorMessage, oneLineText, type MailHeldRow, type NormalizedEvent, type MailMessage, type MailParty, type MailThreadRow, type MailThreadView } from '@cc/protocol'
import type { MessageRow } from '../dev-services/store/mail-types.js'
import type { MailboxRecords, MailRow, RecipientRow } from '../dev-services/store/mailbox.js'
import { PERSON, parseAddress } from './address.js'
import type { MailDelivery } from './delivery.js'
import { SUBJECT_CHARS, type MailChange, type MessageService } from './messages.js'
import { REFUSAL_TEXT, refuse } from './rules.js'

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
  turnOn(sessionId: string): { work: string | null } | undefined
  /** Whether the session takes a notice into its running process now, without a wake (a live process of a tool that takes quiet input; `MailSessionsView.tellsMailNow`) */
  tellsNow(sessionId: string): boolean
  /** Puts the notice into that process (`tellsNow` said it takes it): the session reads it where it is, in its turn if it is in one. Nothing is stopped */
  tell(sessionId: string, text: string): Promise<void>
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
/** Holds the window shows for the person to act on (`mail.held`), and the ones its Release and Dismiss may change */
const PERSON_HOLDS = ['uncertain', 'failed', 'loop', 'budget', 'policy'] as const

/** A message as the window reads it: a moved one with the thread kind it had, a new one in the window's thread words */
type Shown = { m: MailRow; seq: number }

/**
 * A chain's subject: the one its sender gave (#2229), else its first message's words, or for work a script started, whose words are not the
 * person's, that script's (#1468)
 */
function subjectLine(m: Pick<MailRow, 'body' | 'facts' | 'subject'>): string {
  const script = m.facts.fromScript?.credential
  return m.subject ?? oneLineText(script === undefined ? m.body : `The script "${script}": ${m.body}`, SUBJECT_CHARS)
}

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
    private readonly delivery: Pick<MailDelivery, 'answerCrowd' | 'crowdWaiting' | 'poke'>,
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
      canReply: this.replyTarget([root]) !== undefined,
    }
  }

  /**
   * The person writes in a chain (every chain an old thread's id names): an answer to the newest question to them that waits for their answer, else to
   * the newest message sent to them, to its sender; else a word more to the ones the person's own newest message went to. A sender that is gone, and a
   * message hidden from the person, are passed over. A question waits for an answer (D3); an answer or a note does not
   */
  reply(threadId: string, text: string, kind: 'note' | 'answer' | 'question' = 'note', answers?: string): MailThreadView {
    const roots = this.rootsOf(threadId)
    const found = answers === undefined ? this.replyTarget(roots) : this.pickTarget(roots, answers, text)
    if (!found) throw refuse('unknown_message', `There is no message in ${threadId} to answer.`)
    const { target, to } = found
    const sent = this.service.send(PERSON, { to, text, replyTo: target.id, needsReply: kind === 'question', ...(answers === undefined ? {} : { picked: true }) })
    const at = this.shown(target.rootId).find((s) => s.m.id === sent.message.id)?.seq ?? 1
    return this.thread(target.rootId, { after: at - 1 })
  }

  /**
   * The message the person's word in these chains answers, and whom it goes to: the one `reply` writes to, and so what the window's reply box (`canReply`) is
   * offered for. Undefined when the chains hold nothing of the person's to answer: only mail between sessions held for them, or to sessions that are gone
   */
  private replyTarget(roots: readonly string[]): { target: MailRow; to: string[] } | undefined {
    const chain = roots
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
    if (!target) return undefined
    const to = target === theirs ? [target.sender] : this.records.recipients(target.id).flatMap((r) => (this.here(r.recipient) ? [r.recipient] : []))
    return { target, to }
  }

  /**
   * The question a pick answers (#1630): the one the window names, which must be a question in these chains sent to the person by a session that is still
   * here, whose choices include `text`, and not answered already (a question is answered once, whichever window gives the answer first)
   */
  private pickTarget(roots: readonly string[], id: string, text: string): { target: MailRow; to: string[] } | undefined {
    const target = roots.flatMap((root) => this.shown(root).map((s) => s.m)).find((m) => m.id === id)
    const row = target && this.records.recipient(target.id, PERSON)
    if (!target || !row || hiddenFromPerson(row) || !this.here(target.sender)) return undefined
    if (!target.choices?.includes(text)) throw refuse('bad_value', `${id} does not offer that choice.`)
    if (row.answerId !== null || (row.settled !== null && row.settled !== 'legacy')) throw refuse('answered', REFUSAL_TEXT.answered(id))
    return { target, to: [target.sender] }
  }

  /** Whether mail to `address` can still reach it: a session this host keeps (trashed or deleted ones are gone), or any other party */
  private here(address: string): boolean {
    const party = parseAddress(address)
    return party?.kind !== 'session' || this.host.session(party.sessionId) !== undefined
  }

  /**
   * The person's Mark done (`finished`) or Drop (`dropped`), at once, on the whole chain and on every chain an old thread's id names (plan C12): nothing
   * in it waits for them any more, and what they asked in it is withdrawn (their tasks and the questions they put that are still open, settled `withdrawn`:
   * undelivered ones are never delivered, and no report of them is written). Nothing is stopped: the turn may carry other requests, and the
   * person's Stop is the way to stop one. The session whose turn is on the chain, and each one that was asked something there and was delivered it, is told
   * once, in a notice from Centralu that wakes nobody (`closedWords`), so it can stop that work itself; it reads it in the turn it is in when its tool takes
   * input there, else with its next mail. What it sends in the chain after that is mail to the person like any: it reaches them in the same chain, which
   * is listed again as open and unread
   */
  close(threadId: string, outcome: CloseOutcome = 'finished'): MailThreadRow {
    const roots = this.rootsOf(threadId)
    const root = roots[0]
    if (root === undefined) throw refuse('unknown_message', `There is no mail ${threadId} kept.`)
    const now = Date.now()
    /** The sessions to tell, once each across every chain the id names, with the person's requests withdrawn that they had and where each chain ended */
    const tell = new Map<string, { address: string; root: string; ids: string[]; ends: string[] }>()
    // One unit of work, so a failure part-way leaves no chain half closed (requests withdrawn, the chain not marked); the sessions are told after it commits
    this.records.transaction(() => {
      // Every chain an id names: the window showed them as one thread
      for (const r of roots) {
        const chain = this.chainOf(r)
        // What the person asked in it that is open, by the session that has it
        const asked: { id: string; recipient: string; seen: boolean }[] = []
        // A request in doubt (in delivery, or delivered and unsure) may be in the session already, so the session is told of it

        for (const m of chain) {
          if (m.sender !== PERSON || !(m.needsReply || m.kind === 'task')) continue
          for (const row of this.records.recipients(m.id)) if (row.settled === null) asked.push({ id: m.id, recipient: row.recipient, seen: row.deliveredAt !== null || row.attemptAt !== null || row.held === 'uncertain' })
        }
        const working = this.workers(chain)
        // What the person reads of it: a row held out of their sight is not theirs to close
        this.records.closeFor(
          PERSON,
          this.shown(r).map((s) => s.m.id),
          now,
        )
        // Withdrawn, not done: a request not delivered yet goes nowhere. A row an older build settled `legacy` is marked done, as it was
        const withdrawn = asked.filter((a) => this.records.settle(a.id, a.recipient, 'withdrawn', now) > 0)
        for (const m of chain) {
          if (m.sender === PERSON && (m.needsReply || m.kind === 'task')) for (const row of this.records.recipients(m.id)) this.records.settle(m.id, row.recipient, 'done', now)
        }
        this.records.markClosed(r, outcome, now)
        // The sessions to tell: the ones working on it, and the ones that were delivered a request of the person's that is withdrawn now (or have it in delivery: it may arrive after this)
        const end = chain.at(-1)?.id ?? r
        const add = (sessionId: string, address: string, id?: string) => {
          const kept = tell.get(sessionId) ?? { address, root: r, ids: [], ends: [] }
          if (id !== undefined && !kept.ids.includes(id)) kept.ids.push(id)
          if (!kept.ends.includes(end)) kept.ends.push(end)
          tell.set(sessionId, kept)
        }
        for (const w of working) add(w.sessionId, w.address)
        for (const a of withdrawn) {
          const party = parseAddress(a.recipient)
          if (party?.kind !== 'session' || !a.seen || !this.here(a.recipient)) continue
          add(party.sessionId, a.recipient, a.id)
        }
      }
    })
    // The windows that have the chain open read it again
    for (const r of roots) this.service.announce(r)
    for (const [sessionId, t] of tell) this.tellClosed(outcome, sessionId, t)
    return this.row(root, this.heldIn(root)) ?? this.emptyRow(root)
  }

  /**
   * One notice to a session about the chain it worked on being closed: its key names the session and the last message of each chain, so a second close of
   * the same chain tells nothing again, and one after the chain went on (a reply, a new request) does. In the process now when it takes it there, else as
   * mail. A process that fails to take it leaves the notice as undelivered mail, which goes again with the session's next mail
   */
  private tellClosed(outcome: CloseOutcome, sessionId: string, t: { address: string; root: string; ids: string[]; ends: string[] }): void {
    const text = closedWords(t.root, outcome, t.ids)
    const now = this.host.tellsNow(sessionId)
    const stored = this.service.notice(t.address, {
      body: text,
      facts: { quiet: true, chainClosed: { root: t.root, outcome, withdrawn: t.ids.slice(0, 10) } },
      dedupeKey: `closed:${t.address}:${t.ends.join(',')}`,
      delivered: now,
    })
    if (!stored || !now) return
    const at = this.records.recipient(stored.id, t.address)?.deliveredAt
    this.host.tell(sessionId, text).catch(() => {
      if (at != null) this.service.deliveryFailedLate(t.address, [stored.id], at)
    })
  }

  /**
   * The person's Release (Send again, Retry) or Dismiss of held rows. A row an earlier build held for a session's budget goes as the mail it is. A
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

  /**
   * Resume on what an earlier build paused (#2014: nothing pauses mail now): a session's rows held `budget`, or a chain's held `loop` (an old thread's id
   * names the chains moved from it). They go as the mail they are, and a previous build still serving during a swap does not hold them again
   */
  resume(target: { sessionId?: string | undefined; threadId?: string | undefined }): void {
    const rows = this.records.heldRows()
    if (target.sessionId !== undefined) {
      const recipient = this.service.sessionAddress(target.sessionId)
      const ids = rows.flatMap((r) => (r.recipient === recipient && r.held === 'budget' ? [r.messageId] : []))
      if (ids.length > 0) this.service.resendHeld(recipient, ids, ['budget'])
    } else if (target.threadId !== undefined) {
      const roots = new Set(this.rootsOf(target.threadId))
      const ids = new Set(rows.flatMap((r) => (r.held === 'loop' && roots.has(this.records.message(r.messageId)?.rootId ?? '') ? [r.messageId] : [])))
      for (const id of ids) this.service.resumeHeld(id)
    }
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
  private workers(chain: readonly MailRow[]): { sessionId: string; address: string }[] {
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
      return turn && turn.work !== null && ids.has(turn.work) ? [{ sessionId, address }] : []
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
    return first ? subjectLine(first) : root
  }

  /**
   * A chain as the window's list row. Done when the person closed it (`facts.closed` on its root, or an older close: a row to them settled `done`) and
   * nothing in it waits for them or for an answer to them, with how they closed it. Otherwise running while a session's turn is on it or a task the person gave in it is
   * neither reported nor released by a stop, in review once such a task is reported, and open for the rest; the person may always write in a chain that is not done. The session
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
    // A task a stop released is not being worked on: the session can no longer answer it until the person sends it a message (§10.6.1)
    const state = done ? 'done' : working.length > 0 || tasks.some((r) => r.settled === null && r.releasedAt === null) ? 'running' : tasks.some((r) => r.settled === 'reported') ? 'review' : 'open'
    const assignee = working[0]?.address ?? (first.sender === PERSON ? this.records.recipients(first.id)[0]?.recipient : undefined)
    return {
      id: root,
      subject: subjectLine(first),
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
    return { id: root, subject: m ? subjectLine(m) : root, state: 'open', outcome: null, next: null, projectId: null, owner: this.party(m?.sender ?? PERSON), assignee: null, unread: 0, held: 0, blocked: 0, working: false, createdAt: at, updatedAt: at, last: null }
  }

  // ── Shapes ──

  /** The windows' `mail_changed` for a change to the mail (main.ts): a new message the person can read also names itself, for the OS notification (#1630) */
  changeEvent(c: MailChange): Extract<NormalizedEvent, { type: 'mail_changed' }> {
    const toPerson = c.recipients.includes(PERSON)
    const arrived = c.arrived && toPerson ? this.arrival(c.messageId) : undefined
    return { type: 'mail_changed', threadId: c.rootId, toPerson, ...(arrived ? { arrived } : {}) }
  }

  /** A new message as the person's notification names it (`mail_changed.arrived`): one they can read, not their own */
  private arrival(messageId: string): { messageId: string; from: MailParty; kind: string; preview: string } | undefined {
    const m = this.records.message(messageId)
    const row = this.records.recipient(messageId, PERSON)
    if (!m || !row || m.sender === PERSON || hiddenFromPerson(row) || row.held !== null) return undefined
    return { messageId, from: this.party(m.sender), kind: windowKind(m), preview: oneLineText(m.body, PREVIEW_CHARS) }
  }

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
      ...(m.choices ? { choices: m.choices } : {}),
      ...(m.replyTo !== null ? { replyTo: m.replyTo } : {}),
      createdAt: m.createdAt,
      ...(m.sender === PERSON
        ? { receipts: this.records.recipients(m.id).map((r) => ({ recipient: this.party(r.recipient), delivered: r.deliveredAt !== null, read: r.readAt !== null, handled: r.settled !== null })) }
        : {}),
    }
  }
}

/** What a session whose work the person closed is told, in Centralu's words: what the person did, what of its was withdrawn, and that its turn goes on unless it stops it */
function closedWords(root: string, outcome: CloseOutcome, ids: readonly string[]): string {
  const what = outcome === 'dropped' ? 'dropped' : outcome === 'finished' ? 'marked done' : 'closed'
  const shown = ids.slice(0, 10).join(', ') + (ids.length > 10 ? `, and ${ids.length - 10} more` : '')
  const withdrew = ids.length === 0 ? '' : ` and withdrew what they asked of you in it (${shown})`
  return `The person ${what} the mail that began with ${root}${withdrew}. Do not continue that work. Centralu did not stop your turn: if you are still working on it, stop it yourself. What you send in it still reaches the person.`
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
