import { HostMailParams, HubFindResult, HubMailResult, TASK_REPORT_ANSWER_MAX, errorMessage, oneLineText, type HubFindParams, type HubMailParams, type TaskReport } from '@cc/protocol'
import { CENTRALU, PERSON, PERSON_ID, isPerson, parseAddress, sessionAddress } from './address.js'
import { FIND_LIMIT, findAnswer, named, ranked, type FoundEntry } from './find.js'
import type { TaskAcross } from './messages.js'
import { durationText, withTimeout } from '../timing.js'
import { bodyLimit, refusalReason, refuse, tooLongText } from './rules.js'
import { answerKept, reportWords } from './last-response.js'
import { mailCalls } from './frame.js'
import { LINK_HOLD_MS, older, sendOrDrop, unreachable, type AcrossMachine, type AcrossPeer, type AcrossSent, type Answer, type Kept, type Work } from './across-core.js'
import { AcrossReceipts } from './across-receipts.js'
import { MAILBOX_RETENTION, type MailRow, type PendingRow } from '../dev-services/store/mailbox.js'

/**
 * Mail across linked machines (docs/plans/linked-mail.md §5 to §8): every session reaches every other, on this computer or one
 * linked to it, both ways. **Names on the wire are the hub's:** a hub names a machine's session `session:<hub id>/<machine
 * id>.<id>`; a machine names everything on the hub's side the same way and reads `session:<hub id>/<its id there>.<id>` as its
 * own. **The recipient's host writes the message**, with its checks and guards; the sender's host writes its copy under the
 * same id (which it picked) once that host answered or showed it has the message. A refusal writes nothing anywhere; a
 * send whose answer was lost goes again under its id (`unsure`); a send while the link is down is held here (`hold`).
 * **Receipts** go back as the state of the rows (`*.mailRows`), merged forward only. A host may be a hub and a machine at
 * once: which one an address calls on is read off the address.
 */

/**
 * Whether `from` may mail `to` across a link. **Every pair may** (owner decision 2026-11-09): every agent reaches every other,
 * both ways, whichever machine each runs on, whatever the asks switch says. The one place per-direction trust would change, if
 * it comes
 */
export function mayReachAcross(_from: string, _to: string): boolean {
  return true
}

/** A send across: its fields, and what only the recipient's side reads (the person's Inbox shows a subject and a question's choices) */
type SendInput = { to: string; text: string; needsReply: boolean; urgent?: boolean; replyTo?: string; subject?: string; choices?: string[]; question?: true }
/** The fields of a send that cross, but its words, which `Way.params` takes */
type Fields = Omit<Kept, 'question' | 'text'>
/** What only the recipient's side reads, on a hub's side: the person's Inbox shows a subject and a question's choices */
type Extra = { subject?: string; choices?: string[] }
/** A task as it goes to a machine (`HostMailParams.task`), and as its copy here keeps it */
type GivenTask = Omit<TaskAcross, 'origin'> & { origin: NonNullable<HostMailParams['task']>['origin'] }
/** How a send reaches the other side (`MailAcross.way`) */
type Way = { peer: AcrossPeer; method: 'host.mail' | 'hub.mail'; params(id: string, text: string): HostMailParams | HubMailParams; older(r: Answer): Answer }

/** A message id another host picked: its host's id and a ulid (`messageIdOf`), never one of this host's */
const FOREIGN_ID = /^[^\s/]{1,120}\.m_[0-9A-Za-z]{10,40}$/

/** How long a directory search may wait for one hub */
export const FIND_MS = 4000
/** How long a send by name waits for a hub when a session here has that name already: what a reachable hub answers in */
export const NAMED_HERE_MS = 600

/** The most open tasks one offer asks a machine about (`HubOffer.open`): the oldest; the rest are asked at a later connect */
const OPEN_ASKED = 500
/**
 * How old a copy an offer still asks about may be: younger than what a machine keeps a settled task
 * (`MAILBOX_RETENTION.settledMs`), less a day for clocks that differ. A task the machine had, settled and swept would read
 * there as never arrived, and its sender would be told so wrongly
 */
const ASKED_WITHIN = MAILBOX_RETENTION.settledMs - 24 * 60 * 60 * 1000
/** The most task ids a machine remembers as never arrived from one hub (`lacking`), the oldest forgotten first */
const LACKED_MAX = 5000
/** The most tasks one notice that they did not arrive names; the rest are counted */
const NAMED_MAX = 10

export class MailAcross extends AcrossReceipts {
  /** Sends under way now: on a hub tasks, whose `host.mail` an offer neither asks about nor deletes; and mail held for its link that goes (`resend`) */
  private readonly sending = new Set<string>()
  /** On a machine: tasks it told a hub never arrived (`lacking`), by hub, so one hub's many cannot push another's out under `LACKED_MAX` */
  private readonly lacked = new Map<string, Set<string>>()
  /** Mail held for its link whose resend lost its answer: it may be written there, so it goes again whatever its age and is never dropped */
  private readonly mayHaveGone = new Set<string>()

  // ── Sending from here ──

  /**
   * A session's message to a session on another host (`to`: an address, or `parent` for a session a hub started here).
   * The other host writes it or refuses it; only then is the copy written here. Nothing is written when it is refused
   */
  async send(sessionId: string, input: SendInput): Promise<AcrossSent> {
    return this.sendFrom(this.d.service.sessionAddress(sessionId), input)
  }

  /**
   * On a hub: work a session here gives a linked machine's session (docs/plans/linked-mail.md §9): written there as a task (or
   * a note), which that machine's delivery gives the session and its engine reports; the copy here is a task too, so the report
   * that comes back answers it. A machine that does not take tasks is refused `older`, and nothing is written. `forPerson` is
   * said only for this host's Assistant's `send_to_session`; `depth`, the agent depth the session there works at on it
   */
  async sendTask(senderId: string, to: string, text: string, task: TaskAcross): Promise<AcrossSent> {
    const sender = this.d.service.sessionAddress(senderId)
    // As an agent's other calls on a machine (#1532): one that is down is tried now, and one just connected has answered this hub's offer, which says
    // whether it takes tasks, before it is read
    const route = this.route(to)
    const away = route?.kind === 'machine' ? await this.peers?.machine?.(route.machineId)?.reach?.() : null
    const there = this.taskPeer(to)
    if ('why' in there) return { ok: false, ...there }
    const { m, sessionId } = there
    if (text.length > bodyLimit('session')) return { ok: false, why: 'too_long', text: tooLongText('session') }
    const origin = task.origin === 'script' ? 'send_to_session' : task.origin
    const fields = { text, needsReply: false }
    const work = workOf({ ...task, origin })
    // For the person only as `forPersonOf` reads it here: this host's own Assistant's send_to_session (#2258, #2274)
    const given = { ...work, origin, ...(task.forPerson && origin === 'send_to_session' && this.d.reach.isAssistant(sender) ? { forPerson: true as const } : {}), ...(task.depth ? { depth: task.depth } : {}) }
    if (away || !m.reachable) return this.hold(sender, to, { ...fields, task: given }, m)
    const id = this.idFor(sender, to, fields, m.name, work)
    const params = this.taskParams(sender, sessionId, text, id, given)
    // The copy is kept before the task leaves, so the report that answers it finds it whenever it comes: after this host restarted too, when nothing
    // of the send is remembered. A send again of an unsure one has its copy already
    if (!this.d.records.message(id)) {
      try {
        this.d.service.sentAcross(sender, { id, to, ...fields, task: given })
      } catch (e) {
        this.unsure.delete(id)
        return { ok: false, why: 'failed', text: `this computer could not keep its copy of the task, so nothing was sent: ${oneLineText(errorMessage(e), 500)}` }
      }
    }
    this.sending.add(id)
    const r = this.settle(id, await this.ask(m, 'host.mail', params).finally(() => this.sending.delete(id)))
    if (!r.ok) {
      // Refused there: nothing there answers the copy. One that may have arrived keeps it, as the task it may be
      if (!r.maybe) this.d.records.deleteRows([{ messageId: id, recipient: to }])
      return { ok: false, why: r.why, text: r.text }
    }
    this.names.set(to, `${r.to} on ${m.name}`)
    return { ok: true, messageId: id, to: r.to, address: to, computer: m.name }
  }

  /** `host.mail` of a task to a machine's session, as `sendTask` gives it and a held one goes later (`resend`) */
  private taskParams(sender: string, sessionId: string, text: string, id: string, task: GivenTask): HostMailParams {
    return {
      from: sender, name: `${this.d.reach.labelOf(sender)} on ${this.selfName()}`, to: sessionId, text, id,
      task: { origin: task.origin, ...(task.note ? { note: true as const } : {}), ...(task.forPerson ? { forPerson: true as const } : {}), ...(task.depth ? { depth: task.depth } : {}) },
    }
  }

  /**
   * On a hub: the open tasks given to `machineId`'s sessions within `ASKED_WITHIN`, oldest first, that no send has under way: what its offer asks it
   * about (`HubOffer.open`)
   */
  openTasksTo(machineId: string): string[] {
    const since = this.now() - ASKED_WITHIN
    return this.d.records.openTasksToward(sessionAddress(this.d.hostId, `${machineId}.`), since, OPEN_ASKED).filter((id) => !this.sending.has(id))
  }

  /**
   * On a hub: `machineId` answered this connection's offer, and `lacks` are the tasks it says never arrived there: sends whose
   * answer was lost before the machine wrote them. Nothing there will ever report on one, so each copy still open and in no
   * send now is deleted, as a refusal deletes one, and each sender is told in one notice and woken once, as for a stop. Then
   * what is owed to the machine goes (`changed`)
   */
  offerAnswered(machineId: string, lacks: readonly string[]): void {
    const lost = new Map<string, { id: string; name: string }[]>()
    for (const id of lacks) {
      const m = this.sending.has(id) ? undefined : this.d.records.message(id)
      const row = m?.kind === 'task' ? this.d.records.recipients(id)[0] : undefined
      const r = row && this.route(row.recipient)
      if (!m || !row || r?.kind !== 'machine' || r.machineId !== machineId || row.settled !== null || row.releasedAt !== null) continue
      const name = this.nameOf(row.recipient)
      this.d.records.deleteRows([{ messageId: id, recipient: row.recipient }])
      this.unsure.delete(id)
      lost.set(m.sender, [...(lost.get(m.sender) ?? []), { id, name: oneLineText(name, 200) }])
      this.d.log?.(`[mail] ${id} never reached ${r.machineId}: its copy is deleted, and its sender told`)
    }
    for (const [sender, tasks] of lost) this.d.service.notice(sender, notArrived(tasks))
    this.changed()
  }

  /**
   * On a machine: which of the tasks hub `hubId`'s offer asks about (`HubOffer.open`) never arrived here. Only that hub's own
   * ids (`<hubId>.m_…`) are answered: another hub learns nothing of what is stored here and cannot have a hub's later task
   * refused. Each is remembered for that hub and a late one from it is refused (`taskFrom`): a send on a link the hub already
   * counted as dead can still land after this answer. Memory is enough, as no connection outlives this process
   */
  lacking(hubId: string, ids: readonly string[]): string[] {
    const lacks = ids.filter((id) => id.startsWith(`${hubId}.`) && !id.startsWith(`${this.d.hostId}.`) && FOREIGN_ID.test(id) && !this.d.records.message(id))
    const lacked = this.lacked.get(hubId) ?? new Set<string>()
    for (const id of lacks) lacked.add(id)
    for (const old of lacked) {
      if (lacked.size <= LACKED_MAX) break
      lacked.delete(old)
    }
    if (lacked.size) this.lacked.set(hubId, lacked)
    return lacks
  }

  /** Why a task to `to` cannot go now (`sendTask` says the same), or null: not a linked machine's session, no such machine, or one that takes no tasks yet or at all */
  taskRefusal(to: string): { why: string; text: string } | null {
    const there = this.taskPeer(to)
    return 'why' in there ? there : null
  }

  private taskPeer(to: string): { m: AcrossMachine; sessionId: string } | { why: string; text: string } {
    const route = this.route(to)
    if (route?.kind !== 'machine') return { why: 'bad_address', text: `${this.nameOf(to)} is not a session on a machine this computer links.` }
    const m = this.peers?.machine?.(route.machineId)
    if (!m) return { why: 'link_down', text: 'That computer is no longer linked to this one, so nothing was sent.' }
    if (m.reachable && m.tasks === undefined) return { why: 'link_down', text: `${m.name} is still connecting to this computer, so nothing was sent. Try again in a moment.` }
    if (m.reachable && m.tasks !== true) return { why: 'older', text: `${m.name} runs an older Centralu, which takes no work from this computer. Update Centralu on ${m.name}.` }
    return { m, sessionId: route.sessionId }
  }

  /**
   * On a machine: the copy of the task a hub wrote for `sender`'s ask_project to its session `to` (`HubAskResult.taskId`),
   * under the hub's id, so the report the hub sends (`host.mail` with `report`) answers it. An id that is not another host's,
   * or that names a message here, keeps nothing
   */
  keepAsk(sender: string, to: string, id: string, text: string): void {
    if (!FOREIGN_ID.test(id) || id.startsWith(`${this.d.hostId}.`) || this.d.records.message(id)) return
    try {
      this.d.service.sentAcross(sender, { id, to, text, needsReply: false, task: { origin: 'ask_project' } })
    } catch (e) {
      this.d.log?.(`[mail] the copy of the ask ${id}, which ${this.foreignName(to)?.name ?? to} took, could not be kept here: ${errorMessage(e)}`)
    }
  }

  /**
   * On a machine: where its session's mail to the person goes. The person works in the window of the hub that links this
   * computer, so it goes to the hub's person: the hub that started the session, else the one hub that offers mail here. Null
   * when it stays on this computer: no hub links it (or none has offered since this host started), or several do and none
   * started the session (`several`), where a guess would put it before the person in a window they may not read. A session a
   * hub started whose hub is not linked now is refused at once, as all mail across is
   */
  personTarget(sessionId: string, fromHub: boolean): { address: string } | { several: true } | { refused: AcrossSent & { ok: false } } | null {
    const started = this.peers?.startingHub?.(sessionId) ?? null
    if (started) {
      if (this.peers?.hub?.(started.id)) return { address: sessionAddress(started.id, PERSON_ID) }
      const name = oneLineText(started.name, 120) || 'the computer that started this session'
      return { refused: { ok: false, why: 'link_down', text: `the person works on ${name}, which started this session and is not linked to this computer right now (or runs a Centralu from before mail crossed computers), so nothing was sent. Send it again once the link is back.` } }
    }
    const hubs = this.peers?.hubs?.() ?? []
    const [only] = hubs
    if (only && hubs.length === 1) return { address: sessionAddress(only.id, PERSON_ID) }
    // Started by a hub before this computer recorded which: mail to the person written here is never seen there
    if (fromHub) {
      return { refused: { ok: false, why: 'elsewhere', text: 'the person works on the computer that started this session, which this computer did not record, and mail to the person written here is not seen there, so nothing was sent. End your turn with the answer: that is how your parent hears from you.' } }
    }
    return hubs.length > 1 ? { several: true } : null
  }

  /** `send` from any sender here: a session, or on a hub the person, whose answer in the Inbox goes to a machine's session that wrote to them (#1987) */
  async sendFrom(sender: string, input: SendInput): Promise<AcrossSent> {
    if (input.text.length > bodyLimit('session')) return { ok: false, why: 'too_long', text: tooLongText('session') }
    if (!input.text.trim()) return { ok: false, why: 'empty', text: 'a post says something' }
    if (input.to !== 'parent' && !mayReachAcross(sender, input.to)) return { ok: false, why: 'not_allowed', text: `this session may not mail ${this.nameOf(input.to)}.` }
    // Mail out of an untrusted project waits for the person here (§7.4); across a link nothing waits, so it is not sent
    const project = this.d.reach.projectOf(sender)
    if (project !== null && this.d.reach.untrusted(project)) {
      const p = this.d.reach.projectLabel(project)
      return { ok: false, why: 'untrusted_project', text: `your project ${p} is not trusted, and mail out of it to another computer cannot wait for the person as it does here, so nothing was sent. Ask the person to trust ${p}, then send it again.` }
    }
    const fields = { text: input.text, needsReply: input.needsReply, ...(input.urgent ? { urgent: true } : {}), ...(input.replyTo ? { replyTo: input.replyTo } : {}) }
    const kept: Kept = { ...fields, ...(input.question ? { question: true } : {}) }
    // What only the recipient's side reads (the person's Inbox): the copy here keeps the message without them
    const extra = { ...(input.subject ? { subject: input.subject } : {}), ...(input.choices ? { choices: input.choices } : {}) }
    const sessionId = sessionIdOf(sender)
    if (input.to === 'parent') return sessionId ? this.toParent(sessionId, sender, kept) : { ok: false, why: 'bad_address', text: 'only a session has a parent.' }
    const way = this.way(sender, input.to, fields, extra)
    if ('why' in way) return { ok: false, ...way }
    // Mail from the person is refused, not held: held mail waits on its sender's mail tool, and the person writes in the Inbox
    if (!way.peer.reachable) return isPerson(sender) ? unreachable(way.peer) : this.hold(sender, input.to, { ...kept, ...extra }, way.peer)
    const id = this.idFor(sender, input.to, kept, way.peer.name)
    const r = way.older(this.settle(id, await this.ask(way.peer, way.method, way.params(id, input.text))))
    return this.wrote(sender, input.to, kept, way.peer.name, r)
  }

  /**
   * How mail from `sender` reaches `to` on another host: the side it is on, the call, its params under an id and with the words that go, and how a
   * refusal from a build from before the person's mail crossed reads. Or why it cannot, with nothing written
   */
  private way(sender: string, to: string, fields: Fields, extra: Extra): Way | { why: string; text: string } {
    const route = this.route(to)
    if (!route || route.kind === 'here') return { why: 'bad_address', text: `${this.d.reach.shownId(to)} is not a session on another computer.` }
    if (route.kind === 'machine') {
      const m = this.peers?.machine?.(route.machineId)
      if (!m) return { why: 'link_down', text: 'That computer is no longer linked to this one, so nothing was sent.' }
      return {
        peer: m,
        method: 'host.mail',
        // The machine shows the sender as it reads here, with this computer's name
        params: (id, text) => ({ from: sender, name: `${sender === PERSON ? 'the person' : this.d.reach.labelOf(sender)} on ${this.selfName()}`, to: route.sessionId, ...fields, text, id }) satisfies HostMailParams,
        // A machine from before the person's mail crossed takes mail from the hub's sessions only
        older: (r) => (!r.ok && r.why === 'not_allowed' && sender === PERSON ? { ok: false, why: 'older', text: `${m.name} runs an older Centralu, which takes no answer from the person here. Update it there.` } : r),
      }
    }
    const sessionId = sessionIdOf(sender)
    if (!sessionId) return { why: 'not_allowed', text: `only a session here writes to ${this.d.reach.shownId(to)}.` }
    const h = this.peers?.hub?.(route.hubId)
    if (!h) return { why: 'link_down', text: `${this.computers.get(route.hubId) ?? 'the computer of that session'} is not linked to this one right now (or runs a Centralu from before mail crossed computers), so nothing was sent.` }
    if (!h.you) return { why: 'older', text: `${h.name} runs an older Centralu, which takes mail only for the session that started one of its children here. Update it there.` }
    const toPerson = to === sessionAddress(route.hubId, PERSON_ID)
    return {
      peer: h,
      method: 'hub.mail',
      params: (id, text) => ({ sessionId, to: this.asHubNames(route.hubId, to), name: this.d.reach.labelOf(sender), ...fields, ...extra, text, id }) satisfies HubMailParams,
      // A hub from before the person's mail crossed reads `person` as no address
      older: (r) => (!r.ok && r.why === 'bad_address' && toPerson ? { ok: false, why: 'older', text: `${h.name} runs an older Centralu, which takes no mail to the person from here. Update it there.` } : r),
    }
  }

  // ── Held while the link is down (docs/plans/linked-mail.md §12) ──

  /**
   * A send to a side linked and down now, its copy kept here held for its link. An earlier send of the same words whose answer was lost has its copy
   * already: that one stands, and its answer or the other side's rows settle it, so nothing more is held
   */
  private hold(sender: string, to: string, copy: Kept & Extra & { task?: GivenTask }, peer: AcrossPeer): AcrossSent {
    if (writtenLate(this.now(), this.selfName(), copy.text).length > bodyLimit('session')) return { ok: false, why: 'too_long', text: `${tooLongText('session')}, with the line held mail goes with` }
    const { subject: _s, choices: _c, task, ...fields } = copy
    const id = this.idFor(sender, to, fields, peer.name, task && workOf(task))
    if (this.d.records.message(id)) return { ok: false, why: 'link_down', text: `${peer.name} is not reachable right now. Your earlier send of this may have arrived there; it is followed up when the link is back, so nothing more was sent.` }
    // Kept, so not unsure: a send again of the same words is another message, held or sent on its own
    this.unsure.delete(id)
    try {
      this.d.service.sentAcross(sender, { id, to, ...copy, held: true })
    } catch (e) {
      return { ok: false, why: 'failed', text: `${peer.name} is not reachable right now, and this computer could not keep the message to send it later, so nothing was sent: ${oneLineText(errorMessage(e), 500)}` }
    }
    return { ok: true, messageId: id, to: this.nameOf(to), address: to, computer: peer.name, held: true }
  }

  /**
   * Also the sends held for their link. Each is marked `sending` before the first goes, so a drop or `mail send` of one still waiting its turn is
   * refused rather than raced; one to a computer no longer linked goes to `resend`, which refuses it
   */
  protected override retryOwed(): void {
    super.retryOwed()
    const go: PendingRow[] = []
    const late = new Map<string, PendingRow[]>()
    for (const p of this.d.records.heldForLink()) {
      const side = this.sending.has(p.message.id) ? 'down' : this.side(p.row.recipient)
      if (side === 'down') continue
      // A sender in the trash or deleted can decide nothing: its mail goes, as its mail not held is delivered
      if (side === 'gone' || this.mayHaveGone.has(p.message.id) || this.now() - p.message.createdAt < LINK_HOLD_MS || this.d.reach.gone(p.message.sender)) go.push(p)
      else if (p.row.toldAt === null) late.set(p.message.sender, [...(late.get(p.message.sender) ?? []), p])
    }
    for (const p of go) this.sending.add(p.message.id)
    void (async () => {
      for (const p of go) {
        try {
          await this.resend(p)
        } catch (e) {
          this.d.log?.(`[mail] ${p.message.id}, held for its link, could not be sent: ${errorMessage(e)}`)
        } finally {
          this.sending.delete(p.message.id)
        }
      }
    })()
    for (const [sender, rows] of late) {
      this.d.service.notice(sender, heldTooLong(rows.map((p) => ({ id: p.message.id, to: this.nameOf(p.row.recipient), body: p.message.body }))))
      this.d.records.markTold(rows.map((p) => p.row), this.now())
    }
  }

  /** Whether `id` is the sender's mail held for its link: what `mail send` with it and no recipient sends (`sendHeld`) */
  holds(sender: string, id: string): boolean {
    return this.heldOf(sender, id).length > 0
  }

  private heldOf(sender: string, id: string): PendingRow[] {
    return this.d.records.heldForLink(sender).filter((h) => h.message.id === id)
  }

  /**
   * `handled` on the sender's mail held for its link: a question or task is withdrawn as `mail done` withdraws one sent, which ends its hold
   * (`MailboxRecords.settle`); a message watched by no one is deleted, as nothing went. False when `id` is none of it
   */
  dropHeld(sender: string, id: string): boolean {
    const held = this.heldOf(sender, id)
    if (held.length === 0) return false
    if (this.sending.has(id)) throw refuse('busy', `${id} is being sent now, so it can no longer be dropped.`)
    if (this.mayHaveGone.has(id)) throw refuse('busy', `${id} may have arrived there already, so it can no longer be dropped: it is sent again under its id when the link is back, which never writes it twice.`)
    if (this.d.service.done(sender, id).settled === 0) this.d.records.deleteRows(held.map((h) => ({ messageId: id, recipient: h.row.recipient })))
    return true
  }

  /** `mail send` with the id of the sender's mail held for its link (`heldTooLong`): it goes now, whatever its age */
  async sendHeld(sender: string, id: string): Promise<AcrossSent> {
    const p = this.heldOf(sender, id)[0]
    if (!p) return { ok: false, why: 'unknown_message', text: `${oneLineText(id, 200)} is no message of yours held for its link.` }
    if (this.sending.has(id)) return { ok: false, why: 'busy', text: `${id} is being sent now.` }
    if (this.side(p.row.recipient) === 'down') return { ok: false, why: 'link_down', text: `the computer of ${oneLineText(this.nameOf(p.row.recipient), 200)} is still not reachable, so ${id} stays held.` }
    this.sending.add(id)
    try {
      return await this.resend(p)
    } finally {
      this.sending.delete(id)
    }
  }

  /**
   * Where held mail to `to` stands: `ready` to go (its side is reachable, and a machine has answered this connection's offer, before which it takes no
   * mail), `down` for now, or `gone`: its computer is no longer linked to this one
   */
  private side(to: string): 'ready' | 'down' | 'gone' {
    const r = this.route(to)
    const hub = r?.kind === 'hub' ? this.peers?.hub?.(r.hubId) : undefined
    const m = r?.kind === 'machine' ? this.peers?.machine?.(r.machineId) : undefined
    if (!hub && !m) return 'gone'
    return (hub?.reachable ?? false) || (m?.reachable === true && m.tasks !== undefined) ? 'ready' : 'down'
  }

  /** Mail held for its link goes now under its own id, led by `writtenLate`. Its answer lost, it stays held; refused, it is deleted. The caller marks it `sending` */
  private async resend({ row, message: m }: PendingRow): Promise<AcrossSent> {
    const to = row.recipient
    const text = writtenLate(m.createdAt, this.selfName(), m.body)
    const origin = HostMailParams.shape.task.unwrap().shape.origin.safeParse(m.origin)
    const fields = { needsReply: m.needsReply, ...(m.urgent ? { urgent: true } : {}), ...(m.replyTo ? { replyTo: m.replyTo } : {}) }
    const extra = { ...(m.subject ? { subject: m.subject } : {}), ...(m.choices ? { choices: m.choices } : {}) }
    let peer: AcrossPeer
    let r: Answer
    if (origin.success) {
      const there = this.taskPeer(to)
      if ('why' in there) return this.refusedHeld(m, to, there)
      peer = there.m
      r = await this.ask(peer, 'host.mail', this.taskParams(m.sender, there.sessionId, text, m.id, { origin: origin.data, ...(m.kind === 'message' ? { note: true as const } : {}), ...(m.facts.hubAssistant ? { forPerson: true as const } : {}), ...(m.facts.agentDepth ? { depth: m.facts.agentDepth } : {}) }))
    } else {
      const way = this.way(m.sender, to, fields, extra)
      if ('why' in way) return this.refusedHeld(m, to, way)
      peer = way.peer
      r = way.older(await this.ask(peer, way.method, way.params(m.id, text)))
    }
    this.settle(m.id, r)
    if (!r.ok && r.maybe) {
      this.mayHaveGone.add(m.id)
      return { ok: false, why: r.why, text: r.text }
    }
    if (!r.ok) return this.refusedHeld(m, to, r)
    this.mayHaveGone.delete(m.id)
    this.d.service.heldWent(m, to)
    this.names.set(to, `${r.to} on ${peer.name}`)
    return { ok: true, messageId: m.id, to: r.to, address: to, computer: peer.name }
  }

  /** Held mail the other side refused, or that can no longer go there: deleted here, and its sender told why, and that it may have arrived when a send's answer was lost */
  private refusedHeld(m: MailRow, to: string, r: { why: string; text: string }): AcrossSent {
    const fate = this.mayHaveGone.delete(m.id) ? 'may have arrived there, from a send whose answer was lost, and is not sent again' : 'was not sent'
    this.d.records.deleteRows([{ messageId: m.id, recipient: to }])
    const name = oneLineText(this.nameOf(to), 200)
    this.d.service.notice(m.sender, { body: `[Centralu] ${m.id} to ${name}, held while the link was down, ${fate}: ${r.text}`, facts: {}, dedupeKey: `held-refused:${m.id}` })
    return { ok: false, why: r.why, text: r.text }
  }

  /** The computer whose session `parent` names for a session a hub started here (`startingHub`), or null: the giver of its tasks from there (#2357) */
  parentHost(sessionId: string): string | null {
    return this.startedBy(sessionId)?.id ?? null
  }

  /** The hub that started a session here, as recorded with the session (`startingHub`), or null */
  private startedBy(sessionId: string): { id: string; name: string } | null {
    return this.peers?.startingHub?.(sessionId) ?? null
  }

  /** A session a hub started here, to the session there that started it: through that hub only, which knows who that is */
  private async toParent(sessionId: string, sender: string, kept: Kept): Promise<AcrossSent> {
    const { question: _question, ...fields } = kept
    const started = this.startedBy(sessionId)
    if (!started) {
      return {
        ok: false,
        why: 'elsewhere',
        text: 'your parent is a session on another computer, and this session was started before this computer recorded which computer that was, so nothing was sent. End your turn with the answer: that is how your parent hears from you.',
      }
    }
    const h = this.peers?.hub?.(started.id)
    const name = h?.name ?? (oneLineText(started.name, 120) || 'the computer that started this session')
    if (!h) return { ok: false, why: 'link_down', text: `${name}, which started this session, is not linked to this computer right now (or runs a Centralu from before mail crossed computers), so nothing was sent. Send it again once the link is back.` }
    // Its address there is the hub's to say: a second send of the same words reuses the id, and the hub takes it as the one it has
    const id = this.idFor(sender, 'parent', kept, name)
    const r = this.settle(id, await this.ask(h, 'hub.mail', { sessionId, name: this.d.reach.labelOf(sender), ...fields, id }))
    if (!r.ok && r.why === 'not_yours') return { ok: false, why: 'gone', text: `${name} no longer has the session that started this one (it was archived or deleted there, or its record of this session is gone), so nothing was sent. No session there waits for this one's answer.` }
    if (!r.ok && r.why === 'older') return { ok: false, why: 'older', text: `${name} runs an older Centralu, which mail does not reach. Update it there; until then your parent hears from you at your turn's end.` }
    // A hub from before item 2 does not say the parent's address: nothing to keep a copy under, and it took the message as a note
    return this.wrote(sender, r.ok ? (r.address ?? null) : null, kept, name, r)
  }

  /** The other host's answer: on success the copy is written here, under its id */
  private wrote(sender: string, to: string | null, fields: Kept, computer: string, r: Answer): AcrossSent {
    if (!r.ok) return { ok: false, why: r.why, text: r.text }
    const address = to && this.route(to) && this.foreign(to) ? to : null
    if (address) {
      this.names.set(address, `${r.to} on ${computer}`)
      // Kept already: the other side's row of it came while the answer was on its way
      if (!this.d.records.message(r.messageId)) {
        try {
          this.d.service.sentAcross(sender, { id: r.messageId, to: address, ...fields })
        } catch (e) {
          // It arrived there: the copy is what this side lacks, said in the log, never as a failed send
          this.d.log?.(`[mail] the copy of ${r.messageId}, which ${computer} took, could not be kept here: ${errorMessage(e)}`)
        }
      }
    }
    return { ok: true, messageId: r.messageId, to: r.to, address: address ?? '', computer, ...(r.quiet ? { quiet: true as const } : {}) }
  }

  // ── Taking from the other side ──

  /**
   * On a hub: a machine's `hub.mail`. The sender is that machine's session, qualified with the link's machine id and never
   * with anything the call says. `to` absent is the session here that started it; an address here is written here; a
   * session of another machine is passed on to it, and the answer is that machine's
   */
  async fromMachine(machine: { id: string; name: string }, p: HubMailParams): Promise<HubMailResult & { address?: string }> {
    this.computers.set(machine.id, machine.name)
    if (p.report) return this.reportFrom({ machine: machine.id }, machine.name, p.report, { ...p, centralu: p.sessionId === CENTRALU })
    const sender = this.d.service.sessionAddress(`${machine.id}.${p.sessionId}`)
    if (p.name) this.names.set(sender, `${oneLineText(p.name, 120)} on ${machine.name}`)
    // A machine's notice is its Centralu's, read as that computer's words (`write`)
    else if (p.notice && p.sessionId === CENTRALU) this.names.set(sender, `Centralu on ${machine.name}`)
    let to: string
    if (p.to === undefined) {
      const parentId = this.peers?.parentOf?.(`${machine.id}.${p.sessionId}`)
      // Another hub may have started it
      if (!parentId) return { ok: false, why: 'not_yours', text: `${this.selfName()} did not start this session.` }
      to = this.d.service.sessionAddress(parentId)
    } else to = p.to
    // To the person, who works in this hub's window (#1987)
    if (to === PERSON) return this.write(sender, PERSON, p)
    const route = this.route(to)
    if (!route) return { ok: false, why: 'bad_address', text: `Not a mail address: ${JSON.stringify(oneLineText(to, 200))}` }
    if (route.kind === 'hub') return { ok: false, why: 'elsewhere', text: `That session is not on ${this.selfName()} or a machine it links.` }
    if (route.kind === 'machine') {
      if (route.machineId === machine.id) return { ok: false, why: 'bad_address', text: `That is a session on your own computer: write to it by its id, ${route.sessionId}.` }
      const m = this.peers?.machine?.(route.machineId)
      if (!m) return { ok: false, why: 'link_down', text: `No machine linked to ${this.selfName()} now goes by ${route.machineId}, and no computer that links yours does either, so nothing was sent.` }
      const r = await this.ask(m, 'host.mail', { from: sender, name: this.names.get(sender) ?? p.name, to: route.sessionId, text: p.text, ...pick(p) } satisfies HostMailParams)
      return r.ok ? { ok: true, messageId: r.messageId, to: `${r.to} on ${m.name}`, address: to, ...(r.quiet ? { quiet: true as const } : {}) } : r
    }
    return this.write(sender, to, p)
  }

  /**
   * On a machine: a hub's `host.mail`, from the hub that offered on this connection (`hub`). `from` must be on that hub's
   * side; `to` is a session of this host
   */
  fromHub(hub: { id: string; name: string }, p: HostMailParams): HubMailResult & { address?: string } {
    this.computers.set(hub.id, hub.name)
    if (p.report) return this.reportFrom({ hub: hub.id }, hub.name, p.report, { ...p, centralu: p.from === CENTRALU })
    const from = p.from === CENTRALU ? CENTRALU : this.fromHubNames(hub.id, p.from)
    const party = parseAddress(from)
    if (from !== CENTRALU && (party?.kind !== 'session' || party.host !== hub.id)) return { ok: false, why: 'not_allowed', text: `${hub.name} may send mail only from its own side.` }
    // The hub names the sender with its computer (`<name> on <computer>`)
    if (from !== CENTRALU) this.names.set(from, p.name ? oneLineText(p.name, 200) : `a session on ${hub.name}`)
    const to = this.d.service.sessionAddress(p.to)
    if (p.task) return this.taskFrom(hub, from, to, { ...p, task: p.task })
    return this.write(from, to, p)
  }

  /**
   * On a machine: work a session of the hub gives one here, written as the task it is under the hub's id and given by this
   * host's own delivery (held while the session is busy, as here). `forPerson` is the hub's word for its Assistant's
   * `send_to_session`, taken from this link only
   */
  private taskFrom(hub: { id: string; name: string }, from: string, to: string, p: HostMailParams & { task: NonNullable<HostMailParams['task']> }): HubMailResult & { address?: string } {
    if (from === CENTRALU || isPerson(from)) return { ok: false, why: 'not_allowed', text: `${hub.name} gives work here only from its sessions.` }
    // Never to this host's Assistant or a coordinator, which a hub is not shown and may not direct (remote-hub.md §3.4, as `LinkedHost.directedFromHub`)
    const role = this.d.ownEntries().find((e) => e.address === to)?.role
    if (role === 'assistant' || role === 'coordinator') return { ok: false, why: 'not_allowed', text: `Not a session this machine shares: ${this.label(to)}` }
    if (p.id === undefined || !FOREIGN_ID.test(p.id) || p.id.startsWith(`${this.d.hostId}.`)) return { ok: false, why: 'bad_value', text: 'a task from another computer comes with the id it gave it.' }
    if (this.lacked.get(hub.id)?.has(p.id)) return { ok: false, why: 'not_allowed', text: `${this.selfName()} told ${hub.name} when the link came back that this task never arrived, so it was not written now. Give it again.` }
    const had = this.d.records.message(p.id)
    if (had) return had.sender === from && this.d.records.recipient(p.id, to) ? { ok: true, messageId: p.id, to: this.label(to, from), address: to } : { ok: false, why: 'bad_value', text: `${oneLineText(p.id, 200)} is the id of another message on ${this.selfName()}.` }
    if (this.d.reach.mayWrite(from, to) === 'gone') return { ok: false, why: 'gone', text: `${this.label(to, from)} is gone from ${this.selfName()}: it is in the session archive there or deleted, so nothing was written.` }
    try {
      const m = this.d.service.task(from, to, { text: p.text, origin: p.task.origin, delivered: false, ...(p.task.note ? { note: true as const } : {}), across: { id: p.id, ...(p.task.forPerson ? { forPerson: true as const } : {}) }, ...(p.task.depth ? { depth: p.task.depth } : {}) })
      return { ok: true, messageId: m.id, to: this.label(to), address: to }
    } catch (e) {
      return { ok: false, why: refusalReason(e) ?? 'failed', text: oneLineText(errorMessage(e), 4000) }
    }
  }

  /**
   * Centralu's report on a task a session here gave one on the other side: on a hub, a machine's session; on a machine, the
   * hub's session its ask_project went to. Taken only from the side that task went to (its copy's one row is a session there)
   * and written here as this host's report on its copy: the task's sender here (the heir, after a handoff) reads it as a local
   * child's, answering the task. The same report again is the one written (`MessageService.report` dedupes it)
   */
  private reportFrom(side: { hub: string } | { machine: string }, name: string, report: TaskReport, p: { replyTo?: string | undefined; text: string; centralu: boolean }): HubMailResult {
    const task = p.replyTo === undefined ? undefined : this.d.records.message(p.replyTo)
    const row = task ? this.d.records.recipients(task.id)[0] : undefined
    if (!task || !p.centralu || task.kind !== 'task' || !this.tells(side, row?.recipient)) {
      this.d.log?.(`[mail] ${name} sent a report on ${oneLineText(p.replyTo ?? '(none)', 200)}, which is no task this computer gave it: refused`)
      return { ok: false, why: 'not_allowed', text: `${this.selfName()} gave ${name} no such task, so nothing was written.` }
    }
    try {
      // Centralu's words are this host's own, from the report's facts: the other side's text is never written as Centralu's (#120). The session it is
      // about by the id the task's sender reads it under (`MailReach.shownId`)
      const childId = row && parseAddress(row.recipient)?.kind === 'session' ? this.d.reach.shownId(row.recipient) : task.id
      const body = reportWords(childId, { outcome: report.outcome, answer: answerKept(report.answer, TASK_REPORT_ANSWER_MAX), ...(report.personSince ? { personSince: true } : {}), ...(report.after ? { after: true } : {}) })
      const written = this.d.service.report(task.id, { ...report, body })
      return { ok: true, messageId: 'message' in written ? written.message.id : task.id, to: this.label(task.sender) }
    } catch (e) {
      return { ok: false, why: refusalReason(e) ?? 'failed', text: oneLineText(errorMessage(e), 4000) }
    }
  }

  /**
   * The message written here, by this host's one send and its guards; or its refusal, nothing written. Only `from` set to
   * Centralu, which `fromHub` alone passes (a hub writes its own notices on the machines it links), is written as a notice
   * of Centralu's. A notice from the other side's session or machine is that side's message, never Centralu's, and is
   * taken only for a session here that mailed that side: the "no longer watched" notice it passes on is about such mail.
   */
  private write(
    from: string,
    to: string,
    p: { text: string; needsReply?: boolean | undefined; urgent?: boolean | undefined; replyTo?: string | undefined; notice?: boolean | undefined; id?: string | undefined; subject?: string | undefined; choices?: string[] | undefined },
  ): HubMailResult & { address?: string } {
    if (p.id !== undefined) {
      if (!FOREIGN_ID.test(p.id) || p.id.startsWith(`${this.d.hostId}.`)) return { ok: false, why: 'bad_value', text: `${oneLineText(p.id, 200)} is not an id another computer may give a message.` }
      // Sent again after its answer was lost: the message written then is this one
      const had = this.d.records.message(p.id)
      if (had) {
        if (had.sender === from && this.d.records.recipient(p.id, to)) return { ok: true, messageId: p.id, to: this.label(to, from), address: to, ...(had.facts.quiet === true ? { quiet: true as const } : {}) }
        return { ok: false, why: 'bad_value', text: `${oneLineText(p.id, 200)} is the id of another message on ${this.selfName()}.` }
      }
    }
    // A reply to a message this side sent while the answer was lost: its copy is kept now
    if (p.replyTo !== undefined) this.adopt(p.replyTo, from)
    try {
      if (from === CENTRALU) {
        // A notice passed again after its answer was lost is the one written then (its id, `pass`)
        const m = this.d.service.notice(to, { body: p.text, facts: {}, dedupeKey: p.id ? `across:${p.id}` : `across:${this.now()}:${Math.random().toString(36).slice(2, 10)}` })
        return { ok: true, messageId: m?.id ?? 'notice', to: this.d.reach.labelOf(to), address: to }
      }
      if (p.notice && !this.d.records.sentToward(to, sideOf(from))) {
        return { ok: false, why: 'not_allowed', text: `${oneLineText(this.nameOf(from), 200)} may send a notice only to a session that mailed it, and ${this.label(to, from)} did not, so nothing was written.` }
      }
      const sent = this.d.service.send(from, { to: [to], text: p.text, needsReply: p.notice ? false : (p.needsReply ?? true), ...(p.urgent && !p.notice ? { urgent: true } : {}), ...(p.replyTo && !p.notice ? { replyTo: p.replyTo } : {}), ...(p.id ? { id: p.id } : {}), ...(p.subject ? { subject: p.subject } : {}), ...(p.choices ? { choices: p.choices } : {}) })
      // This side owns the receiver's wake, so its decision is the one its sender is told
      return { ok: true, messageId: sent.message.id, to: this.label(to), address: to, ...(sent.quiet ? { quiet: true as const } : {}) }
    } catch (e) {
      const why = refusalReason(e)
      // A reply to a message this side never kept: one that arrived there while the link failed during its send
      const lost = why === 'unknown_message' && p.replyTo !== undefined && !this.d.records.message(p.replyTo)
      const text = why === 'gone'
        ? // The service names the session by this host's id, which the sender never used; the person reads it by its name
          isPerson(from)
          ? `${this.label(to)} on ${this.selfName()} is in the session archive there or was deleted, so your answer was not sent.`
          : `${this.d.reach.shownId(to, from)} is gone from ${this.selfName()}: it is in the session archive there or deleted, so nothing was written.`
        : lost
        ? `${this.selfName()} has no record of ${oneLineText(p.replyTo ?? '', 200)}: it most likely reached you while the link failed during its sending, so ${this.selfName()} never kept its copy, and nothing was written. Send your answer again as a new message (without replying to that one), saying what it answers.`
        : why
          ? errorMessage(e)
          : `${this.selfName()} could not take the message: ${oneLineText(errorMessage(e), 500)}`
      return { ok: false, why: why ?? 'failed', text: text.slice(0, 4000) }
    }
  }

  /** A session by its name, here or on the other side, as a refusal names it; an address that is no session, quoted */
  private nameOf(address: string): string {
    const r = this.route(address)
    if (!r) return JSON.stringify(oneLineText(address, 200))
    return r.kind === 'here' ? this.label(address) : (this.foreignName(address)?.name ?? this.d.reach.shownId(address))
  }

  // ── Finding ──

  /**
   * `mail find` (§8): this host's sessions and those it reaches, ranked, at most `FIND_LIMIT`. `self`: the caller, left out.
   * On a machine each hub is asked, bounded; a hub that does not answer is named, and its side is not listed
   */
  async find(query: string, self: string): Promise<string> {
    const { entries, away, total } = await this.directory(query, false)
    const found = ranked(entries.filter((e) => e.address !== self), query)
    return findAnswer({ query, found, matched: found.length, total: total - (entries.some((e) => e.address === self) ? 1 : 0), away, shown: (a) => this.d.reach.shownId(a) })
  }

  /**
   * The sessions on other computers named `name` exactly, and the computers that could not be asked. `here`: a session on this
   * computer has the name, so a hub is waited for only as long as a reachable one answers in (`NAMED_HERE_MS`), not `FIND_MS`:
   * one that does not answer then leaves the send to the session here
   */
  async named(name: string, o: { here?: boolean } = {}): Promise<{ found: FoundEntry[]; away: { name: string; why: string }[] }> {
    const { entries, away } = await this.directory(name, true, false, o.here ? NAMED_HERE_MS : FIND_MS)
    return { found: named(entries, name), away }
  }

  /** The directory: this host's own entries (unless `own` is false), a hub's mirrors, and each hub's answer on a machine */
  private async directory(query: string, exact: boolean, own = true, ms = FIND_MS): Promise<{ entries: FoundEntry[]; away: { name: string; why: string }[]; total: number }> {
    const entries: FoundEntry[] = own ? this.d.ownEntries() : []
    const away: { name: string; why: string }[] = []
    let total = entries.length
    const mirror = this.peers?.machineDirectory?.()
    if (mirror) {
      entries.push(...mirror.entries)
      total += mirror.entries.length
      away.push(...mirror.away)
    }
    await Promise.all(
      (this.peers?.hubs?.() ?? []).map(async (h) => {
        if (!h.you) return away.push({ name: h.name, why: 'it runs an older Centralu; update it there' })
        if (!h.reachable) return away.push({ name: h.name, why: 'not reachable right now' })
        try {
          const raw = await withTimeout(h.call('hub.find', { query, limit: exact ? 50 : FIND_LIMIT, ...(exact ? { exact: true } : {}) } satisfies HubFindParams), ms, noAnswer)
          const r = HubFindResult.safeParse(raw)
          if (!r.success) return away.push({ name: h.name, why: 'its answer could not be read' })
          for (const e of r.data.entries) {
            const address = this.fromHubNames(h.id, e.address)
            if (!this.foreign(address)) continue
            this.names.set(address, e.machine ? `${e.name} on ${e.machine}` : `${e.name} on ${h.name}`)
            entries.push({ ...e, address, machine: e.machine ?? h.name })
          }
          // What it matched beyond what it sent counts toward the total, not the list
          total += r.data.total
          away.push(...r.data.away)
        } catch (e) {
          away.push({ name: h.name, why: older(e) ? 'it runs an older Centralu; update it there' : 'it did not answer' })
        }
      }),
    )
    return { entries, away, total }
  }

  /** On a hub: a machine's `hub.find`. Its own sessions are left out: it lists them itself, under its own addresses */
  answerFind(machine: { id: string; name: string }, p: HubFindParams): HubFindResult {
    const own = this.d.ownEntries().map((e) => ({ ...e, machine: e.machine ?? this.selfName() }))
    const mirror = this.peers?.machineDirectory?.() ?? { entries: [], away: [] }
    const all = [...own, ...mirror.entries.filter((e) => e.machineId !== machine.id)]
    const found = p.exact ? named(all, p.query) : ranked(all, p.query)
    return {
      entries: found.slice(0, p.limit).map(({ machineId: _m, ...e }) => e),
      matched: found.length,
      total: all.length,
      away: mirror.away,
    }
  }
}

/**
 * The side of a link an address of another host's session is on, as a prefix of the addresses there: a linked machine's
 * sessions (`session:<hub>/<machine>.`), or a hub's own (`session:<hub>/`)
 */
function sideOf(address: string): string {
  const p = parseAddress(address)
  if (p?.kind !== 'session') return address
  const dot = p.sessionId.indexOf('.')
  return dot < 0 ? `session:${p.host}/` : `session:${p.host}/${p.sessionId.slice(0, dot + 1)}`
}

function pick(p: { needsReply?: boolean | undefined; urgent?: boolean | undefined; replyTo?: string | undefined; notice?: boolean | undefined; id?: string | undefined }) {
  return { ...(p.needsReply !== undefined ? { needsReply: p.needsReply } : {}), ...(p.urgent ? { urgent: true } : {}), ...(p.replyTo ? { replyTo: p.replyTo } : {}), ...(p.notice ? { notice: true } : {}), ...(p.id ? { id: p.id } : {}) }
}

const noAnswer = (ms: number): string => `no answer within ${durationText(ms)}`

const sessionIdOf = (sender: string): string | null => {
  const party = parseAddress(sender)
  return party?.kind === 'session' ? party.sessionId : null
}

/** What `idFor` reads of a task */
const workOf = (task: { origin: Work['origin']; note?: true | undefined }): Work => ({ origin: task.origin, ...(task.note ? { note: true as const } : {}) })

/** The words of mail held for its link as they go, led by when and where they were written, so the reader there knows they come late */
const writtenLate = (at: number, computer: string, body: string): string =>
  `[Written at ${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC on ${computer}, while the link between the computers was down.]\n\n${body}`

/**
 * The notice to a sender whose mail held for its link is older than `LINK_HOLD_MS` when the link is back: one per sender and round, naming each
 * (id, recipient, first line) with the two things it can do. Its rows are marked told, so none is named again
 */
function heldTooLong(held: readonly { id: string; to: string; body: string }[]): { body: string; facts: Record<string, never>; dedupeKey: string } {
  const calls = mailCalls('plain')
  const each = held.slice(0, NAMED_MAX).map((h) => `${h.id} to ${oneLineText(h.to, 200)}: ${JSON.stringify(oneLineText(h.body, 120))}`)
  const more = held.length > NAMED_MAX ? `, and ${held.length - NAMED_MAX} more, which your inbox lists` : ''
  const what = held.length === 1 ? 'Your message held while the link was down was' : `${held.length} of your messages held while the link was down were`
  const body = `[Centralu] The link is back. ${what} written more than ${durationText(LINK_HOLD_MS)} ago, so it did not go by itself: it may be out of date. ${each.join('; ')}${more}. For each, ${sendOrDrop(calls, '<id>')}.`
  return { body, facts: {}, dedupeKey: `held-too-long:${held.map((h) => h.id).join(',')}` }
}

/**
 * The notice to a sender whose tasks never reached a machine (docs/plans/linked-mail.md §10): one per sender and connect, so
 * many lost at once wake it once. Several are each named by id and recipient, the first `NAMED_MAX` of them; their copies are
 * gone, so none is ever told again
 */
function notArrived(tasks: readonly { id: string; name: string }[]): { body: string; facts: { notArrived: { messages: string[] } }; dedupeKey: string } {
  const ids = tasks.map((t) => t.id)
  const named = tasks.slice(0, NAMED_MAX).map((t) => `${t.id} to ${t.name}`)
  const more = tasks.length > NAMED_MAX ? `, and ${tasks.length - NAMED_MAX} more` : ''
  const body =
    tasks.length === 1
      ? `[Centralu] Your task to ${tasks[0]?.name} did not arrive: the link failed while it was being sent, and nobody is working on it. Give it again if it is still needed.`
      : `[Centralu] ${tasks.length} of your tasks did not arrive: ${named.join(', ')}${more}. The link failed while they were being sent, and nobody is working on them. Give them again if they are still needed.`
  return { body, facts: { notArrived: { messages: ids } }, dedupeKey: `not-arrived:${ids[0]}` }
}
