import { HubMailResult, errorMessage, oneLineText } from '@cc/protocol'
import type { MailboxRecords } from '../dev-services/store/mailbox.js'
import { isPeerAnswer } from '../rpc-error.js'
import { durationText } from '../timing.js'
import { PERSON, PERSON_ID, inHubTerms, parseAddress, sessionAddress } from './address.js'
import type { FoundEntry } from './find.js'
import type { MessageCalls } from './frame.js'
import type { DelegationOrigin, MessageService } from './messages.js'
import type { MailReach } from './reach.js'

/**
 * What mail across a link (`MailAcross`, across.ts) is built on: where an address is and how the other side names it, the one call to the other side and
 * its failure in the sender's words, and the sends from here whose answer did not come back (`unsure`), kept by their id
 */

/**
 * What a send across came to: the message id on both sides, the recipient's name and computer; or why not, with nothing written. `held`: the link to
 * that computer is down, so the copy here is held for it (`LINK_HOLD`) and nothing went yet (`heldLine` says so)
 */
export type AcrossSent = { ok: true; messageId: string; to: string; address: string; computer: string; held?: true } | { ok: false; why: string; text: string }

/**
 * How long what a session did while a link was down still stands once it is back: held mail goes by itself
 * (docs/plans/linked-mail.md §12), a refused app call is named to its session (docs/plans/remote-hub.md §13.6). Older, the session has moved on
 */
export const LINK_HOLD_MS = 10 * 60_000

/** What a send held for its link says, in the mail tool's answer, a delegation's and the inbox alike */
export const heldLine = (computer: string): string =>
  `${computer} is not reachable right now, so it is held here and goes when the link is back, saying when it was written. Held longer than ${durationText(LINK_HOLD_MS)}, it waits for you to send it or drop it.`

/** What the sender of mail held for its link can do with it */
export const sendOrDrop = (calls: MessageCalls, id: string): string => `send it with ${calls.send(id)}, or drop it with ${calls.done(id)}`

/** One side of a link this host calls: a hub that offered on a connection here, or a machine this hub links */
export type AcrossPeer = {
  name: string
  /** Connected now */
  reachable: boolean
  call(method: string, params: unknown): Promise<unknown>
}

/**
 * A machine a hub links. `tasks`: it takes this hub's tasks as mail (#1948 step 6), undefined until it answered this connection's offer; `mail`: its
 * answer said it takes mail from this hub (#2067 item 2); `reach`: a task needs it, as an agent's call on it does (#1532, `settleForCall`): one that is
 * down is tried now, and one up has answered this connection's offer; null once it is up, else why not as such a call says it (`awaySentence`).
 * Absent: it is not tried
 */
export type AcrossMachine = AcrossPeer & { id: string; tasks?: boolean; mail?: boolean; reach?(): Promise<string | null> }

/** What this host reaches, given once its links exist (main.ts); absent parts are a role this host does not have */
export type AcrossPeers = {
  /** A hub, by its id, as it offered here; `you` is this machine's id there, null for a hub from before item 2 */
  hub?(id: string): (AcrossPeer & { you: string | null }) | undefined
  hubs?(): (AcrossPeer & { id: string; you: string | null })[]
  /** The hub that started a session here (`startingHub`), for `parent` */
  startingHub?(sessionId: string): { id: string; name: string } | null
  /** A machine this hub links, by its id */
  machine?(id: string): AcrossMachine | undefined
  /** A linked machine's session as `<name> on <machine>`, from this hub's mirror of it */
  machineSession?(machineId: string, sessionId: string): string | undefined
  /** Its state as that mirror last had it (`waiting_input`, `idle`, …) */
  machineState?(machineId: string, sessionId: string): string | undefined
  /** The linked machines' sessions as this hub's mirror last had them, and the machines that are not reachable */
  machineDirectory?(): { entries: FoundEntry[]; away: { name: string; why: string }[] }
  /** The session here that started a machine's child, by the child's qualified id (`<machine>.<id>`), for that child's `parent` */
  parentOf?(qualifiedId: string): string | undefined
  /** This computer's name, as the other side reads it */
  selfName(): string
  /**
   * `fn` runs each time a hub offers mail here again: what became of mail that crossed is told then (§6). A hub hears its
   * machines answer its offer through `LinkDeps.onOfferAnswered`
   */
  onConnect?(fn: () => void): void
}

export type MailAcrossDeps = {
  hostId: string
  service: MessageService
  records: MailboxRecords
  reach: Pick<MailReach, 'labelOf' | 'projectOf' | 'untrusted' | 'projectLabel' | 'mayWrite' | 'isAssistant' | 'gone'>
  /** This host's own sessions as the directory lists them */
  ownEntries(): FoundEntry[]
  now?: () => number
  /**
   * When what became of crossing mail was last told to every linked side, kept in the store: rows settled since are told
   * again after a restart, so none that was never told is lost. Absent: every crossing row is read at each change
   */
  toldAt?: { get(): number | null; set(at: number): void }
  /** Runs `fn` soon; tests run it at once */
  soon?: (fn: () => void) => void
  log?: (line: string) => void
}

/** Where an address is, from this host: here, a machine this hub links, or a hub's side */
export type Route = { kind: 'here' } | { kind: 'machine'; machineId: string; sessionId: string } | { kind: 'hub'; hubId: string }

/** The words a call failed with for an older build (it has no such method) */
export const older = (err: unknown) => /Unknown method/i.test(errorMessage(err))

/** A send whose answer did not come back: it may have been written on the other side (`MailAcross.unsure`) */
export type Unsure = { sender: string; to: string; fields: Kept; computer: string; at: number; task?: Work }

/** Work given across a link (#1948 step 6): the copy kept here is a task (a note) from that tool, whichever side's word comes first */
export type Work = { origin: DelegationOrigin; note?: true }

/** Whether two sends say the same: a send again of an unsure one goes under its id only then (`idFor`) */
const sameMessage = (a: Unsure['fields'], b: Unsure['fields']): boolean =>
  a.text === b.text && a.replyTo === b.replyTo && a.needsReply === b.needsReply && (a.urgent ?? false) === (b.urgent ?? false)

/** How long, and how many, unsure sends are kept: a copy is kept for one only while it is likely to be heard of */
const UNSURE_MS = 24 * 60 * 60_000
const UNSURE_MAX = 500

/** What a send across keeps in its copy here: the fields that cross, and that its sender marked it as a question (#2348, `MailFacts.question`), which only this side reads */
export type Kept = { text: string; needsReply: boolean; urgent?: boolean; replyTo?: string; question?: true }

/** The other side's answer to one call (`AcrossCore.ask`): written there, or refused; `maybe`: it may have been written there */
export type Answer = { ok: true; messageId: string; to: string; address?: string } | { ok: false; why: string; text: string; maybe?: boolean }

/** A send to a side not connected now: not sent */
export const unreachable = (peer: AcrossPeer) => ({ ok: false as const, why: 'link_down', text: `${peer.name} is not reachable right now, so nothing was sent. Send it again once the link is back.` })

/** What a send whose answer was lost says to do */
const AGAIN = 'Send it again with the same words: if it did arrive, it is not written there twice, and this computer keeps its copy then.'

export class AcrossCore {
  protected peers: AcrossPeers | null = null
  /** The names of sessions on the other side, as last heard (from a message or a search) */
  protected readonly names = new Map<string, string>()
  /** The names of the computers on the other side, by host id, as last heard on a call of theirs: a notice names one that is no longer linked by it (`uncrossed`) */
  protected readonly computers = new Map<string, string>()
  /**
   * The sends from here not yet answered, or whose answer was lost (the link failed or the answer did not come in time),
   * by message id. The other side may have written one: a second send of the same words reuses its id, which the other
   * side takes as the one it has, and the copy is kept here once the other side's row or a reply to it arrives
   */
  protected readonly unsure = new Map<string, Unsure>()
  protected readonly now: () => number

  constructor(protected readonly d: MailAcrossDeps) {
    this.now = d.now ?? Date.now
  }

  /** This host's id in mail addresses: a hub that links it reads its mail in the hub's terms by it (`host.hubOffer`'s answer, #2268) */
  get hostId(): string {
    return this.d.hostId
  }

  // ── Addresses ──

  protected route(address: string): Route | null {
    const p = parseAddress(address)
    if (p?.kind !== 'session') return null
    if (p.host === this.d.hostId) {
      const dot = p.sessionId.indexOf('.')
      return dot < 0 ? { kind: 'here' } : { kind: 'machine', machineId: p.sessionId.slice(0, dot), sessionId: p.sessionId.slice(dot + 1) }
    }
    return { kind: 'hub', hubId: p.host }
  }

  /** Whether `hostId` is a hub that links this host, reachable now or not: one that offered here on this run, or one kept from an earlier run that took mail (`LinkedHubs.peer`) */
  isHub(hostId: string): boolean {
    return this.peers?.hub?.(hostId) !== undefined
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

  /** A linked machine's session's state as this hub's mirror last had it, for the person's Inbox; undefined for any other address */
  foreignState(address: string): string | undefined {
    const r = this.route(address)
    return r?.kind === 'machine' ? this.peers?.machineState?.(r.machineId, r.sessionId) : undefined
  }

  protected computerOf(r: Route): string | null {
    if (r.kind === 'machine') return this.peers?.machine?.(r.machineId)?.name ?? null
    if (r.kind === 'hub') return this.peers?.hub?.(r.hubId)?.name ?? null
    return null
  }

  /** On a machine, its own session as the hub `hubId` names it */
  protected asHubNames(hubId: string, address: string): string {
    const you = this.peers?.hub?.(hubId)?.you
    return inHubTerms(address, hubId, you ? { host: this.d.hostId, id: you } : undefined)
  }

  /** On a machine, an address as the hub `hubId` names it, as this host names it (its own sessions are its own again) */
  protected fromHubNames(hubId: string, address: string): string {
    if (address === PERSON) return sessionAddress(hubId, PERSON_ID)
    const you = this.peers?.hub?.(hubId)?.you
    const p = parseAddress(address)
    if (!you || p?.kind !== 'session' || p.host !== hubId || !p.sessionId.startsWith(`${you}.`)) return address
    return this.d.service.sessionAddress(p.sessionId.slice(you.length + 1))
  }

  /**
   * The id a send to `to` goes under: the one of an unsure send of the same message by the same sender (its words, what it
   * answers, whether it is urgent and wants a reply), so the other side takes it as the message it may have, else a new
   * one, kept as unsure until the other side answers. A send again that changes any of them is another message: under the
   * same id the other side would keep the first, and its urgency or question would be lost (#2067)
   */
  protected idFor(sender: string, to: string, fields: Kept, computer: string, task?: Work): string {
    const now = this.now()
    for (const [id, u] of this.unsure) {
      if (now - u.at > UNSURE_MS) this.unsure.delete(id)
      else if (u.sender === sender && u.to === to && sameMessage(u.fields, fields) && u.task?.origin === task?.origin && u.task?.note === task?.note) return id
    }
    const id = this.d.service.mintId()
    this.unsure.set(id, { sender, to, fields, computer, at: now, ...(task ? { task } : {}) })
    for (const old of this.unsure.keys()) {
      if (this.unsure.size <= UNSURE_MAX) break
      this.unsure.delete(old)
    }
    return id
  }

  /** The other side's answer to the send of `id`: one it gave, written or refused, ends the doubt; a lost one keeps it */
  protected settle<R extends { ok: boolean; maybe?: boolean }>(id: string, r: R): R {
    if (r.ok || !r.maybe) this.unsure.delete(id)
    return r
  }

  /**
   * The copy of an unsure send, kept now that the other side showed it has the message (its row or a reply came). It stays
   * unsure: the sender, told the send failed, may send the same words again, which then go under this id and find it there
   */
  protected adopt(messageId: string, recipient: string): void {
    const u = this.unsure.get(messageId)
    if (!u || u.to !== recipient || this.d.records.message(messageId)) return
    try {
      this.d.service.sentAcross(u.sender, { id: messageId, to: u.to, ...u.fields })
    } catch (e) {
      this.d.log?.(`[mail] the copy of ${messageId}, which ${u.computer} took, could not be kept here: ${errorMessage(e)}`)
    }
  }

  /** One call to the other side, its failure in the words the sender reads; `maybe`: it may have been written there */
  protected async ask(peer: AcrossPeer, method: string, params: unknown): Promise<Answer> {
    if (!peer.reachable) return unreachable(peer)
    let raw: unknown
    try {
      raw = await peer.call(method, params)
    } catch (err) {
      const said = oneLineText(errorMessage(err), 500).replace(/\.$/, '')
      if (older(err)) return { ok: false, why: 'older', text: `${peer.name} runs an older Centralu, which this mail does not reach. Update it there.` }
      // It answered with an error of its own: it was there, and an error raised after it wrote cannot be told from one before
      if (isPeerAnswer(err)) return { ok: false, why: 'refused', maybe: true, text: `${peer.name} answered the send with an error: ${said}. It may not have taken the message. ${AGAIN}` }
      return { ok: false, why: 'link_down', maybe: true, text: `the link to ${peer.name} failed during the send (${said}), so it is not known whether the message arrived. ${AGAIN}` }
    }
    const parsed = HubMailResult.safeParse(raw)
    if (!parsed.success) return { ok: false, why: 'link_down', maybe: true, text: `${peer.name} answered in a form this computer does not read, so it is not known whether the message arrived. ${AGAIN}` }
    const r = parsed.data
    if (!r.ok) return { ok: false, why: /^[a-z_]{1,40}$/.test(r.why) ? r.why : 'refused', text: r.text.length > 4000 ? `${r.text.slice(0, 4000)}…` : r.text }
    return { ok: true, messageId: oneLineText(r.messageId, 200), to: oneLineText(r.to, 120), ...(r.address ? { address: r.address } : {}) }
  }

  /** A session here as the other side's answer names it; written whatever its label */
  protected label(to: string): string {
    if (to === PERSON) return 'the person'
    try {
      return oneLineText(this.d.reach.labelOf(to), 120)
    } catch {
      return to
    }
  }

  protected selfName(): string {
    return this.peers?.selfName() ?? 'this computer'
  }
}
