import { TaskReport as TaskReportShape, errorMessage, oneLineText, type HostMailParams, type HubMailParams, type MailMoveParams, type MailRowState, type TaskReport } from '@cc/protocol'
import type { MailRow, RecipientRow } from '../dev-services/store/mailbox.js'
import { CENTRALU, PERSON, PERSON_ID, parseAddress, sessionAddress } from './address.js'
import { AcrossCore, older, type AcrossPeers, type Route } from './across-core.js'

/**
 * What became of mail that crossed a link (docs/plans/linked-mail.md §6): receipts both ways as the rows' state (`*.mailRows`), Centralu's reports and
 * notices owed to the other side and passed there, the reports a machine's ask holds back, and a hub's handoff moves told to its machines
 */

/**
 * How far before the kept mark (`toldAt`) crossing rows are read again: a row's `settled_at` can be the other side's
 * time, merged from its rows, and a clock behind this one would put a row settled after the mark before it (#2067 re-check)
 */
const TOLD_SLACK_MS = 10 * 60_000

/** The most ids one `host.mailMove` takes (`MailMoveParams`) */
const MOVE_IDS_PER_CALL = 500

export class AcrossReceipts extends AcrossCore {
  /** The state of each crossing row the other side was told last, by `<message id>|<recipient>` */
  private readonly told = new Map<string, string>()
  private syncing = false
  private again = false
  /** Reports being passed on now (`passOn`): a change and a connect at once send one once */
  private readonly passing = new Set<string>()
  /** Messages whose `pass` was asked for again while one was under way */
  private readonly passAgain = new Set<string>()
  /** On a hub: handoff moves a machine has not been told yet (`movedAcross`), by machine id, told again at each round of receipts */
  private readonly untoldMoves = new Map<string, MailMoveParams[]>()
  /** Tasks whose reports wait for the answer of the call that asked (`holdReports`) */
  private readonly held = new Set<string>()

  /** The links, once they exist. Rows the other side may not have heard of yet are sent now and at each connect */
  usePeers(peers: AcrossPeers): void {
    this.peers = peers
    peers.onConnect?.(() => this.changed())
    this.changed()
  }

  /**
   * On a hub: the reports on `taskId`, a machine's session's ask, wait while the call that asks answers (`MachineAsks`), so none reaches the machine
   * before that answer. Its answer carries a report it read (`carried`): that one is marked passed; any other goes once the hold ends
   */
  holdReports(taskId: string): (carried: boolean) => void {
    this.held.add(taskId)
    return (carried) => {
      this.held.delete(taskId)
      const now = this.now()
      for (const r of carried ? this.d.records.reportsOn(taskId) : []) {
        const rows = this.d.records.recipients(r.id).filter((row) => this.foreign(row.recipient) && row.deliveredAt === null)
        for (const row of rows) {
          this.d.records.markDelivered(row.recipient, [r.id], now, null)
          this.d.records.markRead(row.recipient, [r.id], now)
        }
      }
      this.changed()
    }
  }

  /**
   * On a hub: a handoff moved tasks it gave linked machines' sessions to another session here (`MessageService.handOver`, #1948 step 6). Each machine is
   * told, so its copy names the heir and reads as handed over; the report it sends back goes to the heir either way, by this host's task
   */
  async movedAcross(moves: readonly { from: string; to: string; ids: readonly string[] }[]): Promise<void> {
    for (const move of moves) {
      const byMachine = new Map<string, string[]>()
      for (const id of move.ids) {
        for (const row of this.d.records.recipients(id)) {
          const r = this.route(row.recipient)
          if (r?.kind === 'machine') byMachine.set(r.machineId, [...(byMachine.get(r.machineId) ?? []), id])
        }
      }
      for (const [machineId, ids] of byMachine) await this.tellMove(machineId, { from: move.from, to: move.to, ids })
    }
  }

  /**
   * Tells a machine a handoff moved tasks (`host.mailMove`). One that cannot be told now is kept and told again at the next round of receipts
   * (`syncOnce`): until it is, the machine's copy names the old sender, and its withdrawals and the heir's do not match
   */
  protected async tellMove(machineId: string, params: MailMoveParams): Promise<void> {
    const m = this.peers?.machine?.(machineId)
    // The ids go in chunks the call takes
    for (let i = 0; i < params.ids.length; i += MOVE_IDS_PER_CALL) {
      const part = { ...params, ids: params.ids.slice(i, i + MOVE_IDS_PER_CALL) }
      const r = m?.reachable ? await m.call('host.mailMove', part).then(() => null, (e: unknown) => errorMessage(e)) : 'not reachable'
      if (!r) continue
      this.d.log?.(`[mail] ${m?.name ?? machineId} could not be told that ${part.ids.length} task(s) went from ${params.from} to ${params.to} in a handoff: ${r}; told again later`)
      // A machine from before `host.mailMove` never takes it
      if (!older(r)) this.untoldMoves.set(machineId, [...(this.untoldMoves.get(machineId) ?? []), part])
    }
  }

  /**
   * On a machine: a hub's handoff moved the tasks it gave here (`host.mailMove`). Only from and to that hub's own sessions (never this machine's, never
   * another host's), and only tasks that hub's sessions sent; anything else is refused and logged
   */
  moveFromHub(hub: { id: string; name: string }, p: MailMoveParams): { ok: true; moved: number } | { ok: false; why: string; text: string } {
    const [from, to] = [this.fromHubNames(hub.id, p.from), this.fromHubNames(hub.id, p.to)]
    const ours = (a: string) => {
      const party = parseAddress(a)
      return party?.kind === 'session' && party.host === hub.id && a !== sessionAddress(hub.id, PERSON_ID)
    }
    if (!ours(from) || !ours(to)) {
      this.d.log?.(`[mail] ${hub.name} asked to move tasks from ${oneLineText(p.from, 200)} to ${oneLineText(p.to, 200)}, which are not both its sessions: refused`)
      return { ok: false, why: 'not_allowed', text: `${hub.name} may move only work its own sessions gave here.` }
    }
    const moved = this.d.service.moveAcross(from, to, p.ids)
    if (moved < p.ids.length) this.d.log?.(`[mail] ${hub.name} moved ${moved} of ${p.ids.length} task(s) from ${from}: the rest are not open tasks it gave here`)
    return { ok: true, moved }
  }

  // ── Receipts ──

  /** Something in the mailbox changed: the rows that crossed are compared with what the other side was told, soon */
  changed(): void {
    if (!this.peers) return
    if (this.syncing) {
      this.again = true
      return
    }
    // A round that fails (the store closing under it) is said, never an unhandled rejection: the next change runs it again
    ;(this.d.soon ?? ((fn) => setImmediate(fn)))(() => void this.sync().catch((e: unknown) => this.d.log?.(`[mail] receipts across could not be compared: ${errorMessage(e)}`)))
  }

  /** Tells the other side of each crossing row what changed since it was last told; a row that could not be told is tried again on the next change */
  async sync(): Promise<void> {
    if (this.syncing || !this.peers) return
    this.syncing = true
    try {
      do {
        this.again = false
        await this.syncOnce()
      } while (this.again)
    } finally {
      this.syncing = false
    }
  }

  protected async syncOnce(): Promise<void> {
    for (const [machineId, moves] of [...this.untoldMoves]) {
      if (!this.peers?.machine?.(machineId)?.reachable) continue
      this.untoldMoves.delete(machineId)
      for (const move of moves) await this.tellMove(machineId, move)
    }
    this.retryOwed()
    const out = new Map<string, { peer: { kind: 'hub'; id: string } | { kind: 'machine'; id: string }; rows: (MailRowState & { sender: string })[]; keys: [string, string][] }>()
    // Read before the rows: a row that changes after is newer, and its change runs this again
    const at = this.now()
    let all = true
    const mark = this.d.toldAt?.get() ?? null
    for (const row of this.d.records.acrossRows(this.d.hostId, mark === null ? 0 : Math.max(0, mark - TOLD_SLACK_MS))) {
      const copy = this.foreign(row.recipient)
      // The copy's side tells only a withdrawal; the recipient's side tells everything else
      if (copy && row.settled !== 'withdrawn') continue
      const toward = this.route(copy ? row.recipient : row.sender)
      if (!toward || toward.kind === 'here') continue
      const state = stateOf(row)
      const key = `${row.messageId}|${row.recipient}`
      const sig = JSON.stringify(state)
      if (this.told.get(key) === sig) continue
      const peer = toward.kind === 'hub' ? { kind: 'hub' as const, id: toward.hubId } : { kind: 'machine' as const, id: toward.machineId }
      const k = `${peer.kind}:${peer.id}`
      const batch = out.get(k) ?? { peer, rows: [], keys: [] }
      const named = peer.kind === 'hub' ? { ...state, recipient: this.asHubNames(peer.id, state.recipient), sender: this.asHubNames(peer.id, row.sender) } : { ...state, sender: row.sender }
      batch.rows.push(named)
      batch.keys.push([key, sig])
      out.set(k, batch)
    }
    await Promise.all(
      [...out.values()].map(async (b) => {
        const p = b.peer.kind === 'hub' ? this.peers?.hub?.(b.peer.id) : this.peers?.machine?.(b.peer.id)
        // A side no longer linked is never told, and does not hold the mark back; one linked and away is told when it connects
        if (!p) return
        if (!p.reachable) return void (all = false)
        try {
          for (let i = 0; i < b.rows.length; i += 200) await p.call(b.peer.kind === 'hub' ? 'hub.mailRows' : 'host.mailRows', { rows: b.rows.slice(i, i + 200) })
          for (const [key, sig] of b.keys) this.told.set(key, sig)
        } catch (e) {
          // Told again at the next change or connect; one from before item 2 never hears it, and does not hold the mark back
          if (older(e)) return
          all = false
          this.d.log?.(`[mail] ${p.name} could not be told what became of ${b.rows.length} message(s): ${errorMessage(e)}`)
        }
      }),
    )
    if (all) this.d.toldAt?.set(at)
  }

  /**
   * The other side's rows (`hub.mailRows`, `host.mailRows`). Each is merged into the row here when this host has it; on a
   * hub, a row of mail between two machines is passed on to the machine it is for (by the sender for a receipt, by the
   * recipient for a withdrawal). `from`: the hub whose names they are, on a machine
   */
  async rows(rows: readonly (MailRowState & { sender?: string })[], from: { hub: string } | { machine: string }): Promise<void> {
    const onward = new Map<string, MailRowState[]>()
    for (const raw of rows) {
      const recipient = 'hub' in from ? this.fromHubNames(from.hub, raw.recipient) : raw.recipient
      const sender = raw.sender === undefined ? undefined : 'hub' in from ? this.fromHubNames(from.hub, raw.sender) : raw.sender
      const row = { ...pickState(raw), recipient }
      // The row of a send whose answer was lost: the other side has it, so the copy is kept here now
      if (this.tells(from, recipient)) this.adopt(row.messageId, recipient)
      const here = this.d.records.recipient(row.messageId, recipient)
      if (here) {
        const side = this.foreign(recipient) ? 'copy' : 'recipient'
        // Who may tell it, read off what is stored here, never off what the row says: a receipt is the recipient's side's
        // (the copy's recipient), a withdrawal the sender's side's (the stored message's sender)
        const message = this.d.records.message(row.messageId)
        const stored = message?.sender
        if (!this.tells(from, side === 'copy' ? recipient : stored)) continue
        // A row a hub passes on from another machine names the sender that machine told; it must be the one stored here. On a hub, a machine's
        // receipt on a task a handoff moved names the old sender while the machine was not told of the move: the receipt is the machine's to tell,
        // so it is merged, and the machine is told the move again (`tellMove`)
        if (sender !== undefined && sender !== stored) {
          if (!('machine' in from) || side !== 'copy' || message?.kind !== 'task' || stored === undefined) continue
          this.untoldMoves.set(from.machine, [...(this.untoldMoves.get(from.machine) ?? []), { from: sender, to: stored, ids: [row.messageId] }])
          this.changed()
        }
        // A task's copy is settled by its report, which carries the answer (#1948 step 6): a row that says so first would make the report a stale one
        const merge = side === 'copy' && message?.kind === 'task' && row.settled === 'reported' ? { ...row, settled: null, settledAt: null } : row
        if (this.d.records.mergeAcross(merge, side)) {
          // What this side now has is what the other side told: not told back
          const merged = this.d.records.recipient(row.messageId, recipient)
          if (merged) this.told.set(`${row.messageId}|${recipient}`, JSON.stringify(stateOf(merged)))
        }
        continue
      }
      if (!('machine' in from)) continue
      // Between two machines: on to the other one. This hub keeps no copy of such mail, so the machine that tells it must be
      // the side it is about (the recipient's for a receipt, the sender's for a withdrawal), and the other machine checks
      // the sender against the message it has
      const withdrawn = row.settled === 'withdrawn'
      const target = this.route(withdrawn ? recipient : (sender ?? ''))
      if (target?.kind !== 'machine' || target.machineId === from.machine || !this.tells(from, withdrawn ? sender : recipient)) continue
      onward.set(target.machineId, [...(onward.get(target.machineId) ?? []), { ...row, ...(sender ? { sender } : {}) }])
    }
    await Promise.all(
      [...onward].map(async ([id, list]) => {
        const m = this.peers?.machine?.(id)
        if (m?.reachable) await m.call('host.mailRows', { rows: list }).catch((e) => this.d.log?.(`[mail] ${m.name} could not be told what became of ${list.length} message(s): ${errorMessage(e)}`))
      }),
    )
  }

  /**
   * Whether the side that sent rows (`from`) is the one `address` is on, and so may tell what became of its row: a machine
   * this hub links for its own sessions, a hub for the sessions on its side
   */
  protected tells(from: { hub: string } | { machine: string }, address: string | undefined): boolean {
    if (address === undefined) return false
    const r = this.route(address)
    if ('machine' in from) return r?.kind === 'machine' && r.machineId === from.machine
    return r?.kind === 'hub' && r.hubId === from.hub
  }

  // ── Notices ──

  /**
   * A Centralu notice or report written here to a session on the other side (`pass`): a stop notice, the "no longer watched" notice to a sender there,
   * a report on a task that side gave a session here
   */
  async passOn(messageId: string): Promise<void> {
    const m = this.d.records.message(messageId)
    if (m?.sender === CENTRALU) return this.pass(m)
  }

  /**
   * Centralu's mail to a session on the other side, passed there; owed like the work it is about, so while that side cannot be reached it stays
   * undelivered here and goes at the next connect or change (`retryOwed`), under that side's dedupe (a report's on its task, a notice's by its id). A
   * stop notice is owed as the report it stands for (#1948 step 6): a host that restarts while a session works on another computer's task tells that
   * computer once it is linked again. A notice goes as one (`notice`), which that side writes as this computer's words.
   *
   * A report is Centralu's on a task the other side gave a session here (#1948 step 6): on a machine, a hub's session's; on a hub, a machine's session's
   * ask_project. That side writes it on its copy, in its words from the facts. One that side refuses is said in the log, and it is not tried again. A
   * side no longer linked at all will never take it: the person here is told of a report, with where the answer is; a notice is dropped, said in the
   * log. A machine that takes no tasks (an older build) reads a report by asking again (`MachineAsks`), and one the call that asks carries waits for it
   * (`holdReports`)
   */
  protected async pass(m: MailRow): Promise<void> {
    // Asked again while it is under way (the machine answered the offer while the send before it was in flight): run once more after it, on what is known then
    if (this.passing.has(m.id)) return void this.passAgain.add(m.id)
    this.passing.add(m.id)
    try {
      for (const row of this.d.records.recipients(m.id)) {
        const r = this.route(row.recipient)
        if (!r || r.kind === 'here' || row.deliveredAt !== null) continue
        const report = m.kind === 'report'
        if (report && m.replyTo !== null && this.held.has(m.replyTo)) continue
        const hub = r.kind === 'hub' ? this.peers?.hub?.(r.hubId) : undefined
        const machine = r.kind === 'machine' ? this.peers?.machine?.(r.machineId) : undefined
        const peer = hub ?? machine
        // A machine whose answer to this connection's offer said it takes no mail from this hub never reads a notice: dropped, as a side no longer linked
        const mailless = !report && machine !== undefined && machine.tasks !== undefined && machine.mail !== true
        if (!peer || mailless) {
          if (report) this.uncrossed(m, row.recipient)
          else {
            this.d.log?.(`[mail] a notice to ${row.recipient} could not be passed on, as ${peer ? `${peer.name} takes no mail from this computer` : 'no such computer is linked'}, and was dropped`)
            this.passed(row.recipient, m.id)
          }
          continue
        }
        if (!peer.reachable || (hub && !hub.you) || (report && machine && machine.tasks !== true)) continue
        const sent = await this.ask(peer, r.kind === 'hub' ? 'hub.mail' : 'host.mail', this.frameOf(m, r, row.recipient))
        // Not known to have arrived: tried again at the next change or connect. A notice the other side answered with an error is not: it is news, and a
        // side that takes no mail from this one answers every try so
        if (!sent.ok && (sent.why === 'link_down' || (report && sent.maybe))) continue
        if (!sent.ok) this.d.log?.(`[mail] ${peer.name} refused the ${m.kind} ${m.id}: ${sent.text}`)
        this.passed(row.recipient, m.id)
      }
    } finally {
      this.passing.delete(m.id)
      const again = this.passAgain.delete(m.id) ? this.d.records.message(m.id) : undefined
      if (again) this.passSoon(again)
    }
  }

  /** `pass`, not awaited: one that fails (the store closing under it) is said, never an unhandled rejection; the next change or connect tries it again */
  protected passSoon(m: MailRow): void {
    this.pass(m).catch((e: unknown) => this.d.log?.(`[mail] ${m.id} could not be passed on: ${errorMessage(e)}`))
  }

  /**
   * The frame Centralu's mail `m` goes in to the other side: a report's facts, which that side words itself (`reportFrom`), so `text` is this host's
   * wording, which it does not keep; a notice as a notice, with its id. `hub.mail` names a session of the machine as its sender; a notice has none,
   * and the hub writes it as that machine's Centralu's
   */
  protected frameOf(m: MailRow, r: Exclude<Route, { kind: 'here' }>, recipient: string): HubMailParams | HostMailParams {
    const rest = m.kind === 'report'
      ? { ...(m.replyTo ? { replyTo: m.replyTo } : {}), report: reportOf(m) }
      : { notice: true, id: m.id }
    return r.kind === 'hub'
      ? ({ sessionId: CENTRALU, to: this.asHubNames(r.hubId, recipient), text: m.body, ...rest } satisfies HubMailParams)
      : ({ from: CENTRALU, to: r.sessionId, text: m.body, ...rest } satisfies HostMailParams)
  }

  /** Centralu's mail to the other side, its row here marked delivered and read: passed on, refused there, or told here instead */
  protected passed(recipient: string, messageId: string): void {
    const now = this.now()
    this.d.records.markDelivered(recipient, [messageId], now, null)
    this.d.records.markRead(recipient, [messageId], now)
  }

  /** Centralu's mail to the other side still undelivered here (`pass`), passed on again: at a connect, or any change */
  protected retryOwed(): void {
    for (const recipient of this.d.records.dueRecipients()) {
      if (!this.foreign(recipient)) continue
      for (const p of this.d.records.pendingFor(recipient, Number.MAX_SAFE_INTEGER)) if (p.message.sender === CENTRALU) this.passSoon(p.message)
    }
  }

  /**
   * A report whose other side is no longer linked to this computer: it ends here, told to the person here once, never dropped without a word. Names
   * only, as the person knows them, never an id or an address: the computer as last heard on this run, else in words
   */
  protected uncrossed(m: MailRow, recipient: string): void {
    const about = m.facts.about as { session?: unknown } | undefined
    const child = typeof about?.session === 'string' ? this.label(about.session) : 'a session here'
    const r = this.route(recipient)
    const known = r?.kind === 'hub' ? this.computers.get(r.hubId) : r?.kind === 'machine' ? this.computers.get(r.machineId) : undefined
    const computer = known === undefined ? undefined : oneLineText(known, 120)
    const sender = this.names.get(recipient) ?? `a session on ${computer ?? 'another computer'}`
    this.d.service.notice(PERSON, {
      body: `[Centralu] ${child} finished work that ${oneLineText(sender, 200)} gave it, but ${computer ?? 'that computer'} is no longer linked to this computer, so its report cannot be delivered. The answer is in ${child}.`,
      facts: { uncrossed: { message: m.id } },
      dedupeKey: `uncrossed:${m.id}`,
    })
    this.passed(recipient, m.id)
  }
}

/** The facts of a report that cross with it (`TaskReport`) */
const REPORT_FACTS = ['outcome', 'answer', 'error', 'reason', 'paused', 'waitingOn', 'personSince', 'after'] as const

/** A report's words cut to what `TaskReport` takes (2,000 for the answer, 200 for an error or reason), so a long one still crosses as what it says */
const clip = (v: unknown, max: number): unknown => (typeof v === 'string' && v.length > max ? `${v.slice(0, max - 1)}…` : v)

/** A report's facts as `TaskReport` takes them; one whose facts do not fit is a turn that ended */
function reportOf(m: MailRow): TaskReport {
  const facts = TaskReportShape.safeParse(Object.fromEntries(REPORT_FACTS.flatMap((k) => (m.facts[k] === undefined ? [] : [[k, clip(m.facts[k], k === 'answer' ? 2_000 : 200)]]))))
  return facts.success ? facts.data : { outcome: 'finished' }
}

/** A row as the other side reads it: a stored row, or one the other side sent */
type RowLike = Omit<Pick<RecipientRow, 'messageId' | 'recipient' | 'deliveredAt' | 'readAt' | 'settledAt' | 'answerId' | 'releasedAt'>, never> & { settled: string | null; releasedWhy: string | null }

function stateOf(r: RowLike): MailRowState {
  return {
    messageId: r.messageId,
    recipient: r.recipient,
    deliveredAt: r.deliveredAt,
    readAt: r.readAt,
    settled: r.settled,
    settledAt: r.settledAt,
    answerId: r.answerId,
    releasedAt: r.releasedAt,
    releasedWhy: r.releasedWhy,
  }
}

function pickState(r: MailRowState): Omit<MailRowState, 'sender'> {
  return stateOf(r)
}
