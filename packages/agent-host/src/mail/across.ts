import { HubFindResult, HubMailResult, errorMessage, oneLineText, type HostMailParams, type HubFindParams, type HubMailParams, type MailRowState } from '@cc/protocol'
import type { MailboxRecords, RecipientRow } from '../dev-services/store/mailbox.js'
import { isPeerAnswer } from '../rpc-error.js'
import { CENTRALU, parseAddress, sessionAddress } from './address.js'
import { FIND_LIMIT, findAnswer, named, ranked, type FoundEntry } from './find.js'
import type { MessageService } from './messages.js'
import type { MailReach } from './reach.js'
import { bodyLimit, refusalReason, tooLongText } from './rules.js'

/**
 * Mail across linked machines (#2067 items 2 and 3, docs/plans/linked-mail.md §5 to §8): every session reaches every
 * other, on this computer or on one linked to it, both ways.
 *
 *   - **Names on the wire are the hub's.** A hub names a machine's session `session:<hub id>/<machine id>.<id>`; a machine
 *     names everything on the hub's side the same way, and reads `session:<hub id>/<its id there>.<id>` as its own.
 *   - **The recipient's host writes the message**, with its checks and guards; the sender's host writes its copy, under the
 *     same id, only once that host answered. A refusal, or a link that is down, writes nothing anywhere.
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

/** What a send across came to: the message id on both sides, the recipient's name and computer; or why not, with nothing written */
export type AcrossSent = { ok: true; messageId: string; to: string; address: string; computer: string } | { ok: false; why: string; text: string }

/** One side of a link this host calls: a hub that offered on a connection here, or a machine this hub links */
export type AcrossPeer = {
  name: string
  /** Connected now */
  reachable: boolean
  call(method: string, params: unknown): Promise<unknown>
}

/** What this host reaches, given once its links exist (main.ts); absent parts are a role this host does not have */
export type AcrossPeers = {
  /** A hub, by its id, as it offered here; `you` is this machine's id there, null for a hub from before item 2 */
  hub?(id: string): (AcrossPeer & { you: string | null }) | undefined
  hubs?(): (AcrossPeer & { id: string; you: string | null })[]
  /** The hub that started a session here (`startingHub`), for `parent` */
  startingHub?(sessionId: string): { id: string; name: string } | null
  /** A machine this hub links, by its id */
  machine?(id: string): (AcrossPeer & { id: string }) | undefined
  /** A linked machine's session as `<name> on <machine>`, from this hub's mirror of it */
  machineSession?(machineId: string, sessionId: string): string | undefined
  /** The linked machines' sessions as this hub's mirror last had them, and the machines that are not reachable */
  machineDirectory?(): { entries: FoundEntry[]; away: { name: string; why: string }[] }
  /** The session here that started a machine's child, by the child's qualified id (`<machine>.<id>`), for that child's `parent` */
  parentOf?(qualifiedId: string): string | undefined
  /** This computer's name, as the other side reads it */
  selfName(): string
}

export type MailAcrossDeps = {
  hostId: string
  service: MessageService
  records: MailboxRecords
  reach: Pick<MailReach, 'labelOf' | 'projectOf' | 'untrusted' | 'projectLabel'>
  /** This host's own sessions as the directory lists them */
  ownEntries(): FoundEntry[]
  now?: () => number
  /** Runs `fn` soon; tests run it at once */
  soon?: (fn: () => void) => void
  log?: (line: string) => void
}

/** Where an address is, from this host: here, a machine this hub links, or a hub's side */
type Route = { kind: 'here' } | { kind: 'machine'; machineId: string; sessionId: string } | { kind: 'hub'; hubId: string }

/** The words a call failed with for an older build (it has no such method) */
const older = (err: unknown) => /Unknown method/i.test(errorMessage(err))

/** How long a directory search may wait for one hub */
const FIND_MS = 4000

export class MailAcross {
  private peers: AcrossPeers | null = null
  /** The names of sessions on the other side, as last heard (from a message or a search) */
  private readonly names = new Map<string, string>()
  /** The state of each crossing row the other side was told last, by `<message id>|<recipient>` */
  private readonly told = new Map<string, string>()
  private syncing = false
  private again = false
  private readonly startedAt: number
  private readonly now: () => number

  constructor(private readonly d: MailAcrossDeps) {
    this.now = d.now ?? Date.now
    this.startedAt = this.now()
  }

  /** The links, once they exist. Rows the other side may not have heard of yet are sent */
  usePeers(peers: AcrossPeers): void {
    this.peers = peers
    this.changed()
  }

  // ── Addresses ──

  private route(address: string): Route | null {
    const p = parseAddress(address)
    if (p?.kind !== 'session') return null
    if (p.host === this.d.hostId) {
      const dot = p.sessionId.indexOf('.')
      return dot < 0 ? { kind: 'here' } : { kind: 'machine', machineId: p.sessionId.slice(0, dot), sessionId: p.sessionId.slice(dot + 1) }
    }
    return { kind: 'hub', hubId: p.host }
  }

  /** Whether an address is a session on another host: this host never delivers to it, and never writes to it but a copy */
  foreign(address: string): boolean {
    const r = this.route(address)
    return r !== null && r.kind !== 'here'
  }

  /** A foreign session's name as last heard, with its computer: what this host's mail shows for it */
  foreignName(address: string): { name: string } | undefined {
    const r = this.route(address)
    if (!r || r.kind === 'here') return undefined
    const heard = this.names.get(address) ?? (r.kind === 'machine' ? this.peers?.machineSession?.(r.machineId, r.sessionId) : undefined)
    if (heard) return { name: heard }
    const computer = this.computerOf(r)
    return { name: computer ? `a session on ${computer}` : address }
  }

  private computerOf(r: Route): string | null {
    if (r.kind === 'machine') return this.peers?.machine?.(r.machineId)?.name ?? null
    if (r.kind === 'hub') return this.peers?.hub?.(r.hubId)?.name ?? null
    return null
  }

  /** On a machine, its own session as the hub `hubId` names it */
  private asHubNames(hubId: string, address: string): string {
    const you = this.peers?.hub?.(hubId)?.you
    const p = parseAddress(address)
    return you && p?.kind === 'session' && p.host === this.d.hostId && !p.sessionId.includes('.') ? sessionAddress(hubId, `${you}.${p.sessionId}`) : address
  }

  /** On a machine, an address as the hub `hubId` names it, as this host names it (its own sessions are its own again) */
  private fromHubNames(hubId: string, address: string): string {
    const you = this.peers?.hub?.(hubId)?.you
    const p = parseAddress(address)
    if (!you || p?.kind !== 'session' || p.host !== hubId || !p.sessionId.startsWith(`${you}.`)) return address
    return this.d.service.sessionAddress(p.sessionId.slice(you.length + 1))
  }

  // ── Sending from here ──

  /**
   * A session's message to a session on another host (`to`: an address, or `parent` for a session a hub started here).
   * The other host writes it or refuses it; only then is the copy written here. Nothing is written when it is refused
   */
  async send(sessionId: string, input: { to: string; text: string; needsReply: boolean; urgent?: boolean; replyTo?: string }): Promise<AcrossSent> {
    const sender = this.d.service.sessionAddress(sessionId)
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
    if (input.to === 'parent') return this.toParent(sessionId, sender, fields)
    const route = this.route(input.to)
    if (!route || route.kind === 'here') return { ok: false, why: 'bad_address', text: `${input.to} is not a session on another computer.` }
    if (route.kind === 'machine') {
      const m = this.peers?.machine?.(route.machineId)
      if (!m) return { ok: false, why: 'link_down', text: `no machine ${route.machineId} is linked to this computer, so nothing was sent.` }
      // The machine shows the sender as it reads here, with this computer's name
      const params: HostMailParams = { from: sender, name: `${this.d.reach.labelOf(sender)} on ${this.selfName()}`, to: route.sessionId, ...fields }
      return this.wrote(sender, input.to, fields, m.name, await this.ask(m, 'host.mail', params))
    }
    const h = this.peers?.hub?.(route.hubId)
    if (!h) return { ok: false, why: 'link_down', text: `the computer ${route.hubId} is not linked to this one right now (or runs a Centralu from before mail crossed computers), so nothing was sent.` }
    if (!h.you) return { ok: false, why: 'older', text: `${h.name} runs an older Centralu, which takes mail only for the session that started one of its children here. Update it there.` }
    const params: HubMailParams = { sessionId, to: input.to, name: this.d.reach.labelOf(sender), ...fields }
    return this.wrote(sender, input.to, fields, h.name, await this.ask(h, 'hub.mail', params))
  }

  /** A session a hub started here, to the session there that started it: through that hub only, which knows who that is */
  private async toParent(sessionId: string, sender: string, fields: { text: string; needsReply: boolean; urgent?: boolean; replyTo?: string }): Promise<AcrossSent> {
    const started = this.peers?.startingHub?.(sessionId) ?? null
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
    const r = await this.ask(h, 'hub.mail', { sessionId, name: this.d.reach.labelOf(sender), ...fields })
    if (!r.ok && r.why === 'not_yours') return { ok: false, why: 'gone', text: `${name} no longer has the session that started this one (it was archived or deleted there, or its record of this session is gone), so nothing was sent. No session there waits for this one's answer.` }
    if (!r.ok && r.why === 'older') return { ok: false, why: 'older', text: `${name} runs an older Centralu, which mail does not reach. Update it there; until then your parent hears from you at your turn's end.` }
    // A hub from before item 2 does not say the parent's address: nothing to keep a copy under, and it took the message as a note
    return this.wrote(sender, r.ok ? (r.address ?? null) : null, fields, name, r)
  }

  /** One call to the other side, its failure in the words the sender reads */
  private async ask(peer: AcrossPeer, method: string, params: unknown): Promise<{ ok: true; messageId: string; to: string; address?: string } | { ok: false; why: string; text: string }> {
    if (!peer.reachable) return { ok: false, why: 'link_down', text: `${peer.name} is not reachable right now, so nothing was sent. Send it again once the link is back.` }
    let raw: unknown
    try {
      raw = await peer.call(method, params)
    } catch (err) {
      const said = oneLineText(errorMessage(err), 500).replace(/\.$/, '')
      if (older(err)) return { ok: false, why: 'older', text: `${peer.name} runs an older Centralu, which this mail does not reach. Update it there.` }
      // It answered with an error of its own: it was there, and an error raised after it wrote cannot be told from one before
      if (isPeerAnswer(err)) return { ok: false, why: 'refused', text: `${peer.name} answered the send with an error: ${said}. It may not have taken the message; if it did, sending it again is refused there as a repeat.` }
      return { ok: false, why: 'link_down', text: `the link to ${peer.name} failed during the send (${said}), so it is not known whether the message arrived. If you send it again and it did, ${peer.name} refuses the second one as a repeat.` }
    }
    const parsed = HubMailResult.safeParse(raw)
    if (!parsed.success) return { ok: false, why: 'link_down', text: `${peer.name} answered in a form this computer does not read, so it is not known whether the message arrived.` }
    const r = parsed.data
    if (!r.ok) return { ok: false, why: /^[a-z_]{1,40}$/.test(r.why) ? r.why : 'refused', text: r.text.length > 4000 ? `${r.text.slice(0, 4000)}…` : r.text }
    return { ok: true, messageId: oneLineText(r.messageId, 200), to: oneLineText(r.to, 120), ...(r.address ? { address: r.address } : {}) }
  }

  /** The other host's answer: on success the copy is written here, under its id */
  private wrote(
    sender: string,
    to: string | null,
    fields: { text: string; needsReply: boolean; urgent?: boolean; replyTo?: string },
    computer: string,
    r: { ok: true; messageId: string; to: string; address?: string } | { ok: false; why: string; text: string },
  ): AcrossSent {
    if (!r.ok) return r
    const address = to && this.route(to) && this.foreign(to) ? to : null
    if (address) {
      this.names.set(address, `${r.to} on ${computer}`)
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
    const sender = this.d.service.sessionAddress(`${machine.id}.${p.sessionId}`)
    if (p.name) this.names.set(sender, `${oneLineText(p.name, 120)} on ${machine.name}`)
    let to: string
    if (p.to === undefined) {
      const parentId = this.peers?.parentOf?.(`${machine.id}.${p.sessionId}`)
      // Another hub may have started it
      if (!parentId) return { ok: false, why: 'not_yours', text: `${this.selfName()} did not start this session.` }
      to = this.d.service.sessionAddress(parentId)
    } else to = p.to
    const route = this.route(to)
    if (!route) return { ok: false, why: 'bad_address', text: `Not a mail address: ${JSON.stringify(oneLineText(to, 200))}` }
    if (route.kind === 'hub') return { ok: false, why: 'elsewhere', text: `${oneLineText(to, 200)} is not on ${this.selfName()} or a machine it links.` }
    if (route.kind === 'machine') {
      if (route.machineId === machine.id) return { ok: false, why: 'bad_address', text: `${oneLineText(to, 200)} is a session on your own computer: write to it by its id, ${route.sessionId}.` }
      const m = this.peers?.machine?.(route.machineId)
      if (!m) return { ok: false, why: 'link_down', text: `no machine ${route.machineId} is linked to ${this.selfName()}, so nothing was sent.` }
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
    const from = p.from === CENTRALU ? CENTRALU : this.fromHubNames(hub.id, p.from)
    const party = parseAddress(from)
    if (from !== CENTRALU && (party?.kind !== 'session' || party.host !== hub.id)) return { ok: false, why: 'not_allowed', text: `${hub.name} may send mail only from its own side.` }
    // The hub names the sender with its computer (`<name> on <computer>`)
    if (from !== CENTRALU) this.names.set(from, p.name ? oneLineText(p.name, 200) : `a session on ${hub.name}`)
    const to = this.d.service.sessionAddress(p.to)
    return this.write(from, to, p)
  }

  /** The message written here, by this host's one send and its guards; or its refusal, nothing written */
  private write(from: string, to: string, p: { text: string; needsReply?: boolean | undefined; urgent?: boolean | undefined; replyTo?: string | undefined; notice?: boolean | undefined }): HubMailResult & { address?: string } {
    try {
      if (p.notice || from === CENTRALU) {
        const m = this.d.service.notice(to, { body: p.text, facts: {}, dedupeKey: `across:${this.now()}:${Math.random().toString(36).slice(2, 10)}` })
        return { ok: true, messageId: m?.id ?? 'notice', to: this.d.reach.labelOf(to), address: to }
      }
      const sent = this.d.service.send(from, { to: [to], text: p.text, needsReply: p.needsReply ?? true, ...(p.urgent ? { urgent: true } : {}), ...(p.replyTo ? { replyTo: p.replyTo } : {}) })
      let label = to
      try {
        label = oneLineText(this.d.reach.labelOf(to), 120)
      } catch {
        // Written: the answer says so whatever its label
      }
      return { ok: true, messageId: sent.message.id, to: label, address: to }
    } catch (e) {
      const why = refusalReason(e)
      const text = why ? errorMessage(e) : `${this.selfName()} could not take the message: ${oneLineText(errorMessage(e), 500)}`
      return { ok: false, why: why ?? 'failed', text: text.slice(0, 4000) }
    }
  }

  private selfName(): string {
    return this.peers?.selfName() ?? 'this computer'
  }

  // ── Receipts ──

  /** Something in the mailbox changed: the rows that crossed are compared with what the other side was told, soon */
  changed(): void {
    if (!this.peers) return
    if (this.syncing) {
      this.again = true
      return
    }
    ;(this.d.soon ?? ((fn) => setImmediate(fn)))(() => void this.sync())
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

  private async syncOnce(): Promise<void> {
    const out = new Map<string, { peer: { kind: 'hub'; id: string } | { kind: 'machine'; id: string }; rows: (MailRowState & { sender: string })[]; keys: [string, string][] }>()
    for (const row of this.d.records.acrossRows(this.d.hostId, this.startedAt - 10 * 60_000)) {
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
        if (!p?.reachable) return
        try {
          for (let i = 0; i < b.rows.length; i += 200) await p.call(b.peer.kind === 'hub' ? 'hub.mailRows' : 'host.mailRows', { rows: b.rows.slice(i, i + 200) })
          for (const [key, sig] of b.keys) this.told.set(key, sig)
        } catch (e) {
          // Told again at the next change; one from before item 2 never hears it
          if (!older(e)) this.d.log?.(`[mail] ${p.name} could not be told what became of ${b.rows.length} message(s): ${errorMessage(e)}`)
        }
      }),
    )
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
      const here = this.d.records.recipient(row.messageId, recipient)
      if (here) {
        const side = this.foreign(recipient) ? 'copy' : 'recipient'
        // A machine may tell only rows that concern its own sessions
        if ('machine' in from && !this.concerns(from.machine, recipient, sender)) continue
        if (this.d.records.mergeAcross(row, side)) {
          // What this side now has is what the other side told: not told back
          const merged = this.d.records.recipient(row.messageId, recipient)
          if (merged) this.told.set(`${row.messageId}|${recipient}`, JSON.stringify(stateOf(merged)))
        }
        continue
      }
      if (!('machine' in from)) continue
      // Between two machines: on to the other one
      const target = this.route(row.settled === 'withdrawn' ? recipient : (sender ?? ''))
      if (target?.kind !== 'machine' || target.machineId === from.machine || !this.concerns(from.machine, recipient, sender)) continue
      onward.set(target.machineId, [...(onward.get(target.machineId) ?? []), { ...row, ...(sender ? { sender } : {}) }])
    }
    await Promise.all(
      [...onward].map(async ([id, list]) => {
        const m = this.peers?.machine?.(id)
        if (m?.reachable) await m.call('host.mailRows', { rows: list }).catch((e) => this.d.log?.(`[mail] ${m.name} could not be told what became of ${list.length} message(s): ${errorMessage(e)}`))
      }),
    )
  }

  /** Whether a row from machine `machineId` is about one of its own sessions, as recipient or sender */
  private concerns(machineId: string, recipient: string, sender: string | undefined): boolean {
    const mine = (a: string | undefined) => {
      const r = a === undefined ? null : this.route(a)
      return r?.kind === 'machine' && r.machineId === machineId
    }
    return mine(recipient) || mine(sender)
  }

  // ── Notices ──

  /**
   * A Centralu notice written here to a session on the other side (the "no longer watched" notice to a sender there): passed
   * on as a notice, and its row here marked delivered and read, so this host never tries it. One that cannot be passed on
   * is dropped and said in the log: nothing waits for a link
   */
  async passOn(messageId: string): Promise<void> {
    const m = this.d.records.message(messageId)
    if (!m || m.sender !== CENTRALU) return
    for (const row of this.d.records.recipients(messageId)) {
      if (!this.foreign(row.recipient) || row.deliveredAt !== null) continue
      const now = this.now()
      this.d.records.markDelivered(row.recipient, [messageId], now, null)
      this.d.records.markRead(row.recipient, [messageId], now)
      const r = this.route(row.recipient)
      let sent: { ok: boolean; text?: string } = { ok: false, text: 'no link' }
      if (r?.kind === 'machine') {
        const peer = this.peers?.machine?.(r.machineId)
        if (peer) sent = await this.ask(peer, 'host.mail', { from: CENTRALU, to: r.sessionId, text: m.body, notice: true } satisfies HostMailParams)
      } else if (r?.kind === 'hub') {
        const peer = this.peers?.hub?.(r.hubId)
        // `hub.mail` names a session of the machine as its sender; a notice has none, and the hub writes it as its own
        if (peer?.you) sent = await this.ask(peer, 'hub.mail', { sessionId: 'centralu', to: row.recipient, text: m.body, notice: true } satisfies HubMailParams)
      }
      if (!sent.ok) this.d.log?.(`[mail] a notice to ${row.recipient} could not be passed on, and was dropped: ${sent.text ?? ''}`)
    }
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

  /** The sessions on other computers named `name` exactly, and the computers that could not be asked */
  async named(name: string): Promise<{ found: FoundEntry[]; away: { name: string; why: string }[] }> {
    const { entries, away } = await this.directory(name, true, false)
    return { found: named(entries, name), away }
  }

  /** The directory: this host's own entries (unless `own` is false), a hub's mirrors, and each hub's answer on a machine */
  private async directory(query: string, exact: boolean, own = true): Promise<{ entries: FoundEntry[]; away: { name: string; why: string }[]; total: number }> {
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
          const raw = await Promise.race([h.call('hub.find', { query, limit: exact ? 50 : FIND_LIMIT, ...(exact ? { exact: true } : {}) } satisfies HubFindParams), timeout(FIND_MS)])
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

function pick(p: { needsReply?: boolean | undefined; urgent?: boolean | undefined; replyTo?: string | undefined; notice?: boolean | undefined }) {
  return { ...(p.needsReply !== undefined ? { needsReply: p.needsReply } : {}), ...(p.urgent ? { urgent: true } : {}), ...(p.replyTo ? { replyTo: p.replyTo } : {}), ...(p.notice ? { notice: true } : {}) }
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

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    const t = setTimeout(() => reject(new Error(`no answer within ${ms / 1000} s`)), ms)
    t.unref?.()
  })
}
