import { HubFindResult, HubMailResult, TASK_REPORT_ANSWER_MAX, errorMessage, oneLineText, type HostMailParams, type HubFindParams, type HubMailParams, type TaskReport } from '@cc/protocol'
import { CENTRALU, PERSON, PERSON_ID, isPerson, parseAddress, sessionAddress } from './address.js'
import { FIND_LIMIT, findAnswer, named, ranked, type FoundEntry } from './find.js'
import type { DelegationOrigin } from './messages.js'
import { durationText, withTimeout } from '../timing.js'
import { bodyLimit, refusalReason, tooLongText } from './rules.js'
import { answerKept, reportWords } from './last-response.js'
import { older, unreachable, type AcrossMachine, type AcrossSent, type Work } from './across-core.js'
import { AcrossReceipts } from './across-receipts.js'
import { MAILBOX_RETENTION } from '../dev-services/store/mailbox.js'

/**
 * Mail across linked machines (#2067 items 2 and 3, docs/plans/linked-mail.md §5 to §8): every session reaches every
 * other, on this computer or on one linked to it, both ways.
 *
 *   - **Names on the wire are the hub's.** A hub names a machine's session `session:<hub id>/<machine id>.<id>`; a machine
 *     names everything on the hub's side the same way, and reads `session:<hub id>/<its id there>.<id>` as its own.
 *   - **The recipient's host writes the message**, with its checks and guards; the sender's host writes its copy, under the
 *     same id (which it picked), once that host answered or showed it has the message. A refusal, or a link that is down,
 *     writes nothing anywhere; a send whose answer was lost goes again under its id (`unsure`).
 *   - **Receipts** go back as the state of the rows (`*.mailRows`), merged forward only; a Centralu notice to a session on
 *     the other side is passed on as a notice.
 *
 * A host may be a hub (it links machines) and a machine (hubs link it) at once: which one an address calls on is read off
 * the address.
 */

/**
 * Whether `from` may mail `to` across a link. **Every pair may** (owner decision 2026-11-09, recorded on #2067): every
 * agent reaches every other, both ways, whichever machine each runs on, whatever the asks switch says. The one place
 * per-direction trust (#1455) would change, if it comes
 */
export function mayReachAcross(_from: string, _to: string): boolean {
  return true
}

/** A send across: its fields, and what only the recipient's side reads (the person's Inbox shows a subject and a question's choices) */
type SendInput = { to: string; text: string; needsReply: boolean; urgent?: boolean; replyTo?: string; subject?: string; choices?: string[]; question?: true }
/** What a send across keeps in its copy here: the fields that cross, and that its sender marked it as a question (#2348, `MailFacts.question`), which only this side reads */
type Kept = { text: string; needsReply: boolean; urgent?: boolean; replyTo?: string; question?: true }

/** A message id another host picked: its host's id and a ulid (`messageIdOf`), never one of this host's */
const FOREIGN_ID = /^[^\s/]{1,120}\.m_[0-9A-Za-z]{10,40}$/

/** How long a directory search may wait for one hub */
export const FIND_MS = 4000
/** How long a send by name waits for a hub when a session here has that name already: what a reachable hub answers in */
export const NAMED_HERE_MS = 600

/** The most open tasks one offer asks a machine about (`HubOffer.open`): the oldest; the rest are asked at a later connect */
const OPEN_ASKED = 500
/**
 * How old a copy an offer still asks about may be: younger than what a machine keeps a settled task (`MAILBOX_RETENTION.settledMs`), less a day for
 * clocks that differ. A task the machine had, settled and swept would read there as never arrived, and its sender would be told so wrongly
 */
const ASKED_WITHIN = MAILBOX_RETENTION.settledMs - 24 * 60 * 60 * 1000
/** The most task ids a machine remembers as never arrived from one hub (`lacking`), the oldest forgotten first */
const LACKED_MAX = 5000
/** The most tasks one notice that they did not arrive names; the rest are counted */
const NAMED_MAX = 10

export class MailAcross extends AcrossReceipts {
  /** On a hub: tasks whose `host.mail` is under way now, which an offer neither asks about nor deletes */
  private readonly sending = new Set<string>()
  /** On a machine: tasks it told a hub never arrived (`lacking`), by hub, so one hub's many cannot push another's out under `LACKED_MAX` */
  private readonly lacked = new Map<string, Set<string>>()

  // ── Sending from here ──

  /**
   * A session's message to a session on another host (`to`: an address, or `parent` for a session a hub started here).
   * The other host writes it or refuses it; only then is the copy written here. Nothing is written when it is refused
   */
  async send(sessionId: string, input: SendInput): Promise<AcrossSent> {
    return this.sendFrom(this.d.service.sessionAddress(sessionId), input)
  }

  /**
   * On a hub: work a session here gives a linked machine's session (#1948 step 6, docs/plans/linked-mail.md §9): written there as a task (or a note),
   * which that machine's delivery gives the session and its engine reports; the copy here is a task too, so the report that comes back answers it. A
   * machine that does not take tasks is refused `older`, and nothing is written. `forPerson` is said only for this host's Assistant's `send_to_session`;
   * `depth`, the agent depth the session there works at on it
   */
  async sendTask(senderId: string, to: string, text: string, task: { origin: DelegationOrigin; note?: true; forPerson?: true; depth?: number }): Promise<AcrossSent> {
    const sender = this.d.service.sessionAddress(senderId)
    // As an agent's other calls on a machine (#1532): one that is down is tried now, and one just connected has answered this hub's offer, which says
    // whether it takes tasks, before it is read
    const route = this.route(to)
    const away = route?.kind === 'machine' ? await this.peers?.machine?.(route.machineId)?.reach?.() : null
    if (away) return { ok: false, why: 'link_down', text: away }
    const there = this.taskPeer(to)
    if ('why' in there) return { ok: false, ...there }
    const { m, sessionId } = there
    if (text.length > bodyLimit('session')) return { ok: false, why: 'too_long', text: tooLongText('session') }
    // Before an id is kept as unsure: a send never made leaves no doubt
    if (!m.reachable) return unreachable(m)
    const origin = task.origin === 'script' ? 'send_to_session' : task.origin
    const fields = { text, needsReply: false }
    const work: Work = { origin, ...(task.note ? { note: true as const } : {}) }
    const id = this.idFor(sender, to, fields, m.name, work)
    const params: HostMailParams = {
      from: sender, name: `${this.d.reach.labelOf(sender)} on ${this.selfName()}`, to: sessionId, text, id,
      // For the person only as `forPersonOf` reads it here: this host's own Assistant's send_to_session (#2258, #2274)
      task: { origin, ...(task.note ? { note: true as const } : {}), ...(task.forPerson && origin === 'send_to_session' && this.d.reach.isAssistant(sender) ? { forPerson: true as const } : {}), ...(task.depth ? { depth: task.depth } : {}) },
    }
    // The copy is kept before the task leaves, so the report that answers it finds it whenever it comes: after this host restarted too, when nothing
    // of the send is remembered. A send again of an unsure one has its copy already
    if (!this.d.records.message(id)) {
      try {
        this.d.service.sentAcross(sender, { id, to, ...fields, task: work })
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

  /**
   * On a hub: the open tasks given to `machineId`'s sessions within `ASKED_WITHIN`, oldest first, that no send has under way: what its offer asks it
   * about (`HubOffer.open`)
   */
  openTasksTo(machineId: string): string[] {
    const since = this.now() - ASKED_WITHIN
    return this.d.records.openTasksToward(sessionAddress(this.d.hostId, `${machineId}.`), since, OPEN_ASKED).filter((id) => !this.sending.has(id))
  }

  /**
   * On a hub: `machineId` answered this connection's offer, and `lacks` are the tasks it says never arrived there (#2289): sends whose answer was lost
   * before the machine wrote them. Nothing there will ever report on one, so each copy still open and in no send now is deleted, as a refusal deletes
   * one, and each sender is told in one notice and woken once, as for a stop. Then what is owed to the machine goes (`changed`)
   */
  offerAnswered(machineId: string, lacks: readonly string[]): void {
    const lost = new Map<string, { id: string; name: string }[]>()
    for (const id of lacks) {
      const m = this.sending.has(id) ? undefined : this.d.records.message(id)
      const row = m?.kind === 'task' ? this.d.records.recipients(id)[0] : undefined
      const r = row && this.route(row.recipient)
      if (!m || !row || r?.kind !== 'machine' || r.machineId !== machineId || row.settled !== null || row.releasedAt !== null) continue
      const name = this.foreignName(row.recipient)?.name ?? row.recipient
      this.d.records.deleteRows([{ messageId: id, recipient: row.recipient }])
      this.unsure.delete(id)
      lost.set(m.sender, [...(lost.get(m.sender) ?? []), { id, name: oneLineText(name, 200) }])
      this.d.log?.(`[mail] ${id} never reached ${r.machineId}: its copy is deleted, and its sender told`)
    }
    for (const [sender, tasks] of lost) this.d.service.notice(sender, notArrived(tasks))
    this.changed()
  }

  /**
   * On a machine: which of the tasks hub `hubId`'s offer asks about (`HubOffer.open`) never arrived here. Only that hub's own ids (`<hubId>.m_…`) are
   * answered: another hub learns nothing of what is stored here, and cannot have a hub's later task refused. Each is remembered for that hub, and a
   * late one from it is refused (`taskFrom`): a send on a link the hub already counted as dead can still land after this answer. Memory is enough, as
   * no connection outlives this process: after a restart nothing sent before it can arrive
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
   * On a machine: the copy of the task a hub wrote for `sender`'s ask_project to its session `to` (`HubAskResult.taskId`, #1948 step 6), under the hub's
   * id, so the report the hub sends (`host.mail` with `report`) answers it. An id that is not another host's, or that names a message here, keeps nothing
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
   * On a machine: where its session's mail to the person goes (#1987). The person works in the window of the hub that links this
   * computer, so it goes to the hub's person: the hub that started the session, else the one hub that offers mail here. Null when it
   * stays on this computer: no hub links it (or none has offered since this host started), or several do and none started the
   * session (`several`), where a guess would put it before the person in a window they may not read. A session a hub started whose
   * hub is not linked now is refused at once, as all mail across is (#2067)
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
    if (input.to !== 'parent' && !mayReachAcross(sender, input.to)) return { ok: false, why: 'not_allowed', text: `this session may not mail ${input.to}.` }
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
    const party = parseAddress(sender)
    const sessionId = party?.kind === 'session' ? party.sessionId : null
    if (input.to === 'parent') return sessionId ? this.toParent(sessionId, sender, kept) : { ok: false, why: 'bad_address', text: 'only a session has a parent.' }
    const route = this.route(input.to)
    if (!route || route.kind === 'here') return { ok: false, why: 'bad_address', text: `${input.to} is not a session on another computer.` }
    if (route.kind === 'machine') {
      const m = this.peers?.machine?.(route.machineId)
      if (!m) return { ok: false, why: 'link_down', text: 'That computer is no longer linked to this one, so nothing was sent.' }
      const id = this.idFor(sender, input.to, kept, m.name)
      // The machine shows the sender as it reads here, with this computer's name
      const params: HostMailParams = { from: sender, name: `${sender === PERSON ? 'the person' : this.d.reach.labelOf(sender)} on ${this.selfName()}`, to: route.sessionId, ...fields, id }
      const r = this.settle(id, await this.ask(m, 'host.mail', params))
      // A machine from before the person's mail crossed takes mail from the hub's sessions only
      if (!r.ok && r.why === 'not_allowed' && sender === PERSON) return { ok: false, why: 'older', text: `${m.name} runs an older Centralu, which takes no answer from the person here. Update it there.` }
      return this.wrote(sender, input.to, kept, m.name, r)
    }
    if (!sessionId) return { ok: false, why: 'not_allowed', text: `only a session here writes to ${input.to}.` }
    const h = this.peers?.hub?.(route.hubId)
    if (!h) return { ok: false, why: 'link_down', text: `the computer ${route.hubId} is not linked to this one right now (or runs a Centralu from before mail crossed computers), so nothing was sent.` }
    if (!h.you) return { ok: false, why: 'older', text: `${h.name} runs an older Centralu, which takes mail only for the session that started one of its children here. Update it there.` }
    const id = this.idFor(sender, input.to, kept, h.name)
    const toPerson = input.to === sessionAddress(route.hubId, PERSON_ID)
    const params: HubMailParams = { sessionId, to: this.asHubNames(route.hubId, input.to), name: this.d.reach.labelOf(sender), ...fields, ...extra, id }
    const r = this.settle(id, await this.ask(h, 'hub.mail', params))
    // A hub from before the person's mail crossed reads `person` as no address
    if (!r.ok && r.why === 'bad_address' && toPerson) return { ok: false, why: 'older', text: `${h.name} runs an older Centralu, which takes no mail to the person from here. Update it there.` }
    return this.wrote(sender, input.to, kept, h.name, r)
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
  private wrote(
    sender: string,
    to: string | null,
    fields: Kept,
    computer: string,
    r: { ok: true; messageId: string; to: string; address?: string } | { ok: false; why: string; text: string; maybe?: boolean },
  ): AcrossSent {
    if (!r.ok) return { ok: false, why: r.why, text: r.text }
    const address = to && this.route(to) && this.foreign(to) ? to : null
    if (address) {
      this.names.set(address, `${r.to} on ${computer}`)
      // Kept already: the other side's row of it came while the answer was on its way
      if (this.d.records.message(r.messageId)) return { ok: true, messageId: r.messageId, to: r.to, address, computer }
      try {
        this.d.service.sentAcross(sender, { id: r.messageId, to: address, ...fields })
      } catch (e) {
        // It arrived there: the copy is what this side lacks, said in the log, never as a failed send
        this.d.log?.(`[mail] the copy of ${r.messageId}, which ${computer} took, could not be kept here: ${errorMessage(e)}`)
      }
    }
    return { ok: true, messageId: r.messageId, to: r.to, address: address ?? '', computer }
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
    if (route.kind === 'hub') return { ok: false, why: 'elsewhere', text: `${oneLineText(to, 200)} is not on ${this.selfName()} or a machine it links.` }
    if (route.kind === 'machine') {
      if (route.machineId === machine.id) return { ok: false, why: 'bad_address', text: `${oneLineText(to, 200)} is a session on your own computer: write to it by its id, ${route.sessionId}.` }
      const m = this.peers?.machine?.(route.machineId)
      if (!m) return { ok: false, why: 'link_down', text: `That computer is no longer linked to ${this.selfName()}, so nothing was sent.` }
      const r = await this.ask(m, 'host.mail', { from: sender, name: this.names.get(sender) ?? p.name, to: route.sessionId, text: p.text, ...pick(p) } satisfies HostMailParams)
      return r.ok ? { ok: true, messageId: r.messageId, to: `${r.to} on ${m.name}`, address: to } : r
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
    return this.write(from, to, p, this.asHubNames(hub.id, to))
  }

  /**
   * On a machine: work a session of the hub gives one here (#1948 step 6), written as the task it is, under the hub's id, and given by this host's own
   * delivery (held while the session is busy, as here). `forPerson` is the hub's word for its Assistant's `send_to_session`, taken from this link only
   */
  private taskFrom(hub: { id: string; name: string }, from: string, to: string, p: HostMailParams & { task: NonNullable<HostMailParams['task']> }): HubMailResult & { address?: string } {
    if (from === CENTRALU || isPerson(from)) return { ok: false, why: 'not_allowed', text: `${hub.name} gives work here only from its sessions.` }
    // Never to this host's Assistant or a coordinator, which a hub is not shown and may not direct (remote-hub.md §3.4, as `LinkedHost.directedFromHub`)
    const role = this.d.ownEntries().find((e) => e.address === to)?.role
    if (role === 'assistant' || role === 'coordinator') return { ok: false, why: 'not_allowed', text: `Not a session this machine shares: ${this.label(to)}` }
    if (p.id === undefined || !FOREIGN_ID.test(p.id) || p.id.startsWith(`${this.d.hostId}.`)) return { ok: false, why: 'bad_value', text: 'a task from another computer comes with the id it gave it.' }
    if (this.lacked.get(hub.id)?.has(p.id)) return { ok: false, why: 'not_allowed', text: `${this.selfName()} told ${hub.name} when the link came back that this task never arrived, so it was not written now. Give it again.` }
    const had = this.d.records.message(p.id)
    if (had) return had.sender === from && this.d.records.recipient(p.id, to) ? { ok: true, messageId: p.id, to: this.label(to), address: to } : { ok: false, why: 'bad_value', text: `${oneLineText(p.id, 200)} is the id of another message on ${this.selfName()}.` }
    // A session gone from here has no name left here: the sender knows which it gave the work to
    if (this.d.reach.mayWrite(from, to, false) === 'gone') return { ok: false, why: 'gone', text: `${this.label(to) === to ? 'That session' : this.label(to)} is gone from ${this.selfName()}: it is in the session archive there or deleted, so nothing was written.` }
    try {
      const m = this.d.service.task(from, to, { text: p.text, origin: p.task.origin, delivered: false, ...(p.task.note ? { note: true as const } : {}), across: { id: p.id, ...(p.task.forPerson ? { forPerson: true as const } : {}) }, ...(p.task.depth ? { depth: p.task.depth } : {}) })
      return { ok: true, messageId: m.id, to: this.label(to), address: to }
    } catch (e) {
      return { ok: false, why: refusalReason(e) ?? 'failed', text: oneLineText(errorMessage(e), 4000) }
    }
  }

  /**
   * Centralu's report on a task a session here gave one on the other side (#1948 step 6): on a hub, a machine's session; on a machine, the hub's session
   * its ask_project went to. Taken only from the side that task went to (its copy's one row is a session there), and written here as this host's report
   * on its copy: the task's sender here (the heir, after a handoff) reads it as a local child's, answering the task. The same report again is the one
   * written (`MessageService.report` dedupes it)
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
      // about by the id the task's sender reads it under: on a hub `<machine id>.<id>`, as its address here names it; on a machine `<hub id>.<id>`
      const party = row ? parseAddress(row.recipient) : null
      const childId = party?.kind !== 'session' ? task.id : party.host === this.d.hostId ? party.sessionId : `${party.host}.${party.sessionId}`
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
   * `seen`: `to` as the sender's side names it, which a refusal names
   */
  private write(
    from: string,
    to: string,
    p: { text: string; needsReply?: boolean | undefined; urgent?: boolean | undefined; replyTo?: string | undefined; notice?: boolean | undefined; id?: string | undefined; subject?: string | undefined; choices?: string[] | undefined },
    seen = to,
  ): HubMailResult & { address?: string } {
    if (p.id !== undefined) {
      if (!FOREIGN_ID.test(p.id) || p.id.startsWith(`${this.d.hostId}.`)) return { ok: false, why: 'bad_value', text: `${oneLineText(p.id, 200)} is not an id another computer may give a message.` }
      // Sent again after its answer was lost: the message written then is this one
      const had = this.d.records.message(p.id)
      if (had) {
        if (had.sender === from && this.d.records.recipient(p.id, to)) return { ok: true, messageId: p.id, to: this.label(to), address: to }
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
        return { ok: false, why: 'not_allowed', text: `${oneLineText(this.foreignName(from)?.name ?? from, 200)} may send a notice only to a session that mailed it, and ${oneLineText(to, 200)} did not, so nothing was written.` }
      }
      const sent = this.d.service.send(from, { to: [to], text: p.text, needsReply: p.notice ? false : (p.needsReply ?? true), ...(p.urgent && !p.notice ? { urgent: true } : {}), ...(p.replyTo && !p.notice ? { replyTo: p.replyTo } : {}), ...(p.id ? { id: p.id } : {}), ...(p.subject ? { subject: p.subject } : {}), ...(p.choices ? { choices: p.choices } : {}) })
      return { ok: true, messageId: sent.message.id, to: this.label(to), address: to }
    } catch (e) {
      const why = refusalReason(e)
      // A reply to a message this side never kept: one that arrived there while the link failed during its send
      const lost = why === 'unknown_message' && p.replyTo !== undefined && !this.d.records.message(p.replyTo)
      const text = why === 'gone'
        ? // The service names the session by this host's address, which the sender never used; the person reads it by its name
          isPerson(from)
          ? `${this.label(to)} on ${this.selfName()} is in the session archive there or was deleted, so your answer was not sent.`
          : `${oneLineText(seen, 200)} is gone from ${this.selfName()}: it is in the session archive there or deleted, so nothing was written.`
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
    return r.kind === 'here' ? this.label(address) : (this.foreignName(address)?.name ?? address)
  }

  // ── Finding ──

  /**
   * `mail find` (§8): this host's sessions and those it reaches, ranked, at most `FIND_LIMIT`. `self`: the caller, left out.
   * On a machine each hub is asked, bounded; a hub that does not answer is named, and its side is not listed
   */
  async find(query: string, self: string): Promise<string> {
    const { entries, away, total } = await this.directory(query, false)
    const found = ranked(entries.filter((e) => e.address !== self), query)
    return findAnswer({ query, found, matched: found.length, total: total - (entries.some((e) => e.address === self) ? 1 : 0), away })
  }

  /**
   * The sessions on other computers named `name` exactly, and the computers that could not be asked. `here`: a session on
   * this computer has the name, so a hub is waited for only as long as a reachable one answers in (`NAMED_HERE_MS`), not
   * `FIND_MS`: one that does not answer then leaves the send to the session here (#2067 review)
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

/**
 * The notice to a sender whose tasks never reached a machine (#2289, docs/plans/linked-mail.md §10): one per sender and connect, so many lost at once
 * wake it once. Several are each named by id and recipient, the first `NAMED_MAX` of them; their copies are gone, so none is ever told again
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
