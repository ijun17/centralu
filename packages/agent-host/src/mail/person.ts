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
}

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
    const root = this.rootOf(threadId)
    if (root === null) throw refuse('unknown_message', `There is no mail ${threadId} kept.`)
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
   * The person writes in a chain: an answer to the newest message in it sent to them by someone else (to its sender), else a word more to the ones the person's
   * own newest message went to. A question waits for an answer (D3); an answer or a note does not
   */
  reply(threadId: string, text: string, kind: 'note' | 'answer' | 'question' = 'note'): MailThreadView {
    const root = this.rootOf(threadId)
    const chain = root === null ? [] : this.shown(root).map((s) => s.m)
    // Only what was sent to the person is theirs to answer: a message held for them to act on is not
    const theirs = chain.findLast((m) => m.sender !== PERSON && parseAddress(m.sender)?.kind !== 'centralu' && this.records.recipient(m.id, PERSON) !== undefined)
    const mine = chain.findLast((m) => m.sender === PERSON)
    const target = theirs ?? mine
    if (root === null || !target) throw refuse('unknown_message', `There is no message in ${threadId} to answer.`)
    const to = target === theirs ? [target.sender] : this.records.recipients(target.id).map((r) => r.recipient)
    const sent = this.service.send(PERSON, { to, text, replyTo: target.id, needsReply: kind === 'question' })
    const at = this.shown(root).find((s) => s.m.id === sent.message.id)?.seq ?? 1
    return this.thread(root, { after: at - 1 })
  }

  /**
   * The person's Mark done or Drop: nothing in the chain waits for them any more, and their own questions in it wait for no answer. Nothing is
   * withdrawn: what the person sent is still delivered, and a task the person gave is still reported
   */
  close(threadId: string): MailThreadRow {
    const root = this.rootOf(threadId)
    if (root === null) throw refuse('unknown_message', `There is no mail ${threadId} kept.`)
    const ids = this.shown(root).map((s) => s.m.id)
    this.records.closeFor(PERSON, ids, Date.now())
    for (const id of ids) {
      const m = this.records.message(id)
      if (m?.sender === PERSON && m.needsReply) for (const r of this.records.recipients(id)) this.records.settle(id, r.recipient, 'done', Date.now())
    }
    this.service.announce()
    return this.row(root, this.heldIn(root)) ?? this.emptyRow(root)
  }

  /** Giving a thread's work to another session and a thread's blockers went with threads (§12.2) */
  removed(what: string): never {
    throw refuse('removed', `${what} went with threads: write to the session instead, or give it work from its own conversation.`)
  }

  /**
   * The person's Release (Send again, Retry) or Dismiss of held rows. A row held for a session's budget goes as the mail it is and is not held again. A
   * row held for its project's trust goes when the person trusts the project (§7.4): its Release says so. A dismissed answer leaves its question open (D8)
   */
  held(action: 'release' | 'dismiss', recipient: string, messageIds: string[]): { changed: number } {
    if (action === 'dismiss') return { changed: this.service.dismissHeld(recipient, messageIds, PERSON_HOLDS) }
    const projects = new Set(messageIds.flatMap((id) => (this.records.recipient(id, recipient)?.held === 'policy' ? (this.records.message(id)?.senderProject ?? []) : [])))
    // A project trusted since (its trust's release did not reach these rows): what it holds goes now, in order
    for (const p of projects) if (!this.host.untrusted(p)) this.trusted(p)
    const changed = this.service.resendHeld(recipient, messageIds, ['uncertain', 'failed', 'budget'])
    const still = [...projects].find((p) => this.host.untrusted(p))
    if (still !== undefined) throw refuse('untrusted_project', `${this.host.projectLabel(still)} is not trusted: what its sessions send out of it waits until you trust the project, and then goes in order.`)
    return { changed }
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

  /** The chain an id names: a message's root, or the newest chain moved from an old thread; null when neither is kept */
  private rootOf(id: string): string | null {
    return this.records.message(id)?.rootId ?? this.records.movedFrom(id)[0] ?? null
  }

  /** Every chain an id names: a message's root, or each chain moved from an old thread */
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
   * A chain as the window's list row. Done when the person said so (a row to them settled `done`) and nothing in it waits for them or for an answer to
   * them; open otherwise, so the person may always write in a chain that is not done
   */
  private row(root: string, held: number): MailThreadRow | null {
    const all = this.shown(root).map((s) => s.m)
    const first = all[0]
    const last = all.at(-1)
    if (!first || !last) return null
    const toPerson = all.flatMap((m) => this.records.recipient(m.id, PERSON) ?? [])
    const waits =
      toPerson.some((r) => r.settled === null) ||
      all.some((m) => m.sender === PERSON && (m.needsReply || m.kind === 'task') && this.records.recipients(m.id).some((r) => r.settled === null))
    const closed = toPerson.some((r) => r.settled === 'done')
    const assignee = first.sender === PERSON ? this.records.recipients(first.id)[0]?.recipient : undefined
    return {
      id: root,
      subject: oneLineText(first.body, SUBJECT_CHARS),
      state: closed && !waits ? 'done' : 'open',
      outcome: null,
      next: null,
      projectId: first.senderProject,
      owner: this.party(first.sender),
      assignee: assignee === undefined ? null : this.party(assignee),
      unread: toPerson.filter((r) => r.readAt === null && !hiddenFromPerson(r)).length,
      held,
      blocked: 0,
      working: false,
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
