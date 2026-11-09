import { HubAskResult, HubMailResult, HubMethods, errorMessage, oneLineText, type HubAskParams, type HubOffer, type HubProject } from '@cc/protocol'
import { NOT_REACHABLE } from '../adapters/contract.js'

/**
 * The hubs linked to this host that let its sessions ask their projects (#550, the reverse direction,
 * docs/plans/remote-hub.md §12.7, owner decision 2026-10-18). Each hub says so itself (`host.hubOffer`) on the
 * connection it opened to this host, and is called back on that connection only (`HostServer.call`), never on another
 * and never by an address of its own choosing.
 *
 *   - **Several hubs** appear to this host's sessions by their own names. A hub whose connection is gone stays listed
 *     as "not reachable right now", with the projects it last listed, until it says otherwise or this host restarts.
 *   - **A hub that never offered** (one from before this, or whose switch for this machine is off) is not listed: its
 *     projects cannot be named. One that offered and then said off is forgotten at once.
 *   - **What a hub answers is someone else's words**: names on one line, and an answer that does not read as one is a
 *     refusal, never passed on as it came.
 *   - **Mail** (#2067 item 1, docs/plans/linked-mail.md §3): a hub that says it takes mail is kept whatever its switch
 *     for asks says, and a session it started here mails its parent there through it (`mail`). Its projects are listed
 *     and asked only while that switch is on.
 */

/** How long a list of a hub's projects may take before that hub counts as away for the call (as `LOOKUP_MS`, #984) */
const LOOKUP_MS = 4000

/** `asks`: the hub's switch for this machine is on. `mail`: it takes mail from the sessions it started here */
type Hub = { id: string; name: string; client: number | null; projects: HubProject[] | null; asks: boolean; mail: boolean }

/** How long a message to a hub may take before the send is refused as not known to have arrived */
const MAIL_MS = 30_000

/**
 * What a message to a parent on a hub came to (`mail`): sent, with the hub's message id, the parent's name there and
 * the hub's; or refused, with the reason and the words the session reads, and nothing written on either side, except
 * where the words say it is not known
 */
export type HubParentMail = { ok: true; messageId: string; to: string; hub: string } | { ok: false; why: string; text: string }

/** A hub's project as an ask_project names it here: its id qualified by the hub's (`<hub id>.<project id>`) */
export type HubProjectRef = { id: string; projectId: string; name: string; hub: string; hubId: string; away?: string }

export type LinkedHubsDeps = {
  /** A call to a connected client (`HostServer.call`) */
  call: (client: number, method: string, params: unknown, opts: { timeoutMs?: number; signal?: AbortSignal }) => Promise<unknown>
  lookupMs?: number
  /** How long one ask may wait for the hub's answer, its card included; the transport's bound when absent. For tests */
  askTimeoutMs?: number
  /** How long one message may wait for the hub's answer (30 s when absent). For tests */
  mailTimeoutMs?: number
}

/** The words a call that failed for an older hub says (it has no such method) */
const older = (err: unknown) => /Unknown method/i.test(errorMessage(err))

export class LinkedHubs {
  private hubs = new Map<string, Hub>()

  constructor(private readonly deps: LinkedHubsDeps) {}

  /** A hub's offer, on the connection it came in on. Off, and without mail, forgets it */
  offer(client: number, o: HubOffer): void {
    const mail = o.mail === true
    if (!o.on && !mail) {
      this.hubs.delete(o.hub.id)
      return
    }
    const prev = this.hubs.get(o.hub.id)
    const projects = o.on ? (prev?.projects ?? null) : null
    this.hubs.set(o.hub.id, { id: o.hub.id, name: oneLineText(o.hub.name, 120) || o.hub.id, client, projects, asks: o.on, mail })
  }

  /** The hubs whose switch for this machine is on: the ones whose projects its sessions may ask */
  private asking(): Hub[] {
    return [...this.hubs.values()].filter((h) => h.asks)
  }

  /** A connection ended: a hub it carried is not reachable until it offers again */
  gone(client: number): void {
    for (const h of this.hubs.values()) if (h.client === client) h.client = null
  }

  /** Whether any hub offered its projects (a session's project list says nothing of hubs otherwise) */
  get any(): boolean {
    return this.asking().length > 0
  }

  /**
   * Every offered hub's projects, asked in parallel and each bounded: a hub that is away contributes the projects it
   * last listed, marked, and its name under `away`
   */
  async projects(): Promise<{ projects: HubProjectRef[]; away: { hubId: string; hub: string; why: string }[] }> {
    const projects: HubProjectRef[] = []
    const away: { hubId: string; hub: string; why: string }[] = []
    await Promise.all(
      this.asking().map(async (h) => {
        let why: string | null = null
        if (h.client === null) why = NOT_REACHABLE
        else {
          try {
            const raw = await this.deps.call(h.client, 'hub.projects', {}, { timeoutMs: this.deps.lookupMs ?? LOOKUP_MS })
            const parsed = HubMethods['hub.projects'].result.safeParse(raw)
            if (parsed.success) h.projects = parsed.data.projects
            else why = 'its answer could not be read'
          } catch (err) {
            why = older(err) ? 'it runs a Centralu from before this; update it there' : NOT_REACHABLE
          }
        }
        if (why) away.push({ hubId: h.id, hub: h.name, why })
        for (const p of h.projects ?? []) {
          projects.push({ id: `${h.id}.${p.id}`, projectId: p.id, name: oneLineText(p.name, 120), hub: h.name, hubId: h.id, ...(why ? { away: why } : {}) })
        }
      }),
    )
    return { projects, away }
  }

  /** One ask into a hub's project (`hub.askProject`), waited on until the hub answers or `signal` withdraws it */
  async ask(hubId: string, params: HubAskParams, signal?: AbortSignal): Promise<HubAskResult> {
    const h = this.hubs.get(hubId)
    if (!h?.asks) return { ok: false, error: 'That computer no longer lets this machine ask its projects.' }
    if (h.client === null) return { ok: false, error: `${h.name} is ${NOT_REACHABLE}. Try again once its link is back.` }
    let raw: unknown
    try {
      raw = await this.deps.call(h.client, 'hub.askProject', params, { signal, ...(this.deps.askTimeoutMs ? { timeoutMs: this.deps.askTimeoutMs } : {}) })
    } catch (err) {
      if (signal?.aborted) return { ok: false, error: 'The call was cancelled.' }
      if (older(err)) return { ok: false, error: `${h.name} runs a Centralu from before this, so it cannot be asked. Update it there.` }
      return { ok: false, error: `${h.name} could not be asked: ${oneLineText(errorMessage(err), 500)}` }
    }
    const parsed = HubAskResult.safeParse(raw)
    if (!parsed.success) return { ok: false, error: `${h.name} answered in a form this machine does not read.` }
    const r = parsed.data
    // A refusal may list sessions one per line: kept as lines, and cut to size
    if (!r.ok) return { ok: false, error: r.error.length > 4000 ? `${r.error.slice(0, 4000)}…` : r.error }
    return { ...r, project: oneLineText(r.project, 120), sessionName: oneLineText(r.sessionName, 120) }
  }

  /**
   * A message of a session a hub started here to the session that started it (`hub.mail`, #2067 item 1). This host does
   * not know which hub that is: each hub that offered mail is asked in turn, and one that did not start the session
   * answers `not_yours`. A hub that offered asks but not mail runs a release from before mail crossed computers, and is
   * asked too, so that it can say so. Nothing is written here: the hub that takes it writes it, and a refusal is said at
   * once and written nowhere, so the same text may be sent again (docs/plans/linked-mail.md §3's table).
   */
  async mail(sessionId: string, input: { text: string; needsReply?: boolean; urgent?: boolean }): Promise<HubParentMail> {
    const hubs = [...this.hubs.values()].sort((a, b) => Number(b.mail) - Number(a.mail))
    let down: Hub | null = null
    let lost: { hub: Hub; why: string } | null = null
    let before: Hub | null = null
    for (const h of hubs) {
      if (h.client === null) {
        down ??= h
        continue
      }
      let raw: unknown
      try {
        raw = await this.deps.call(h.client, 'hub.mail', { sessionId, ...input }, { timeoutMs: this.deps.mailTimeoutMs ?? MAIL_MS })
      } catch (err) {
        if (older(err)) before ??= h
        else lost ??= { hub: h, why: oneLineText(errorMessage(err), 300) }
        continue
      }
      const parsed = HubMailResult.safeParse(raw)
      if (!parsed.success) return { ok: false, why: 'link_down', text: `${h.name} answered in a form this computer does not read, so it is not known whether the message arrived.` }
      const r = parsed.data
      if (!r.ok && r.why === 'not_yours') continue
      if (!r.ok) return { ok: false, why: /^[a-z_]{1,40}$/.test(r.why) ? r.why : 'refused', text: r.text.length > 4000 ? `${r.text.slice(0, 4000)}…` : r.text }
      return { ok: true, messageId: oneLineText(r.messageId, 200), to: oneLineText(r.to, 120), hub: h.name }
    }
    if (lost) {
      return { ok: false, why: 'link_down', text: `the link to ${lost.hub.name} failed during the send (${lost.why}), so it is not known whether the message arrived. If you send it again and it did, ${lost.hub.name} refuses the second one as a repeat.` }
    }
    if (down) return { ok: false, why: 'link_down', text: `${down.name} is ${NOT_REACHABLE}, so nothing was sent. Send it again once the link is back.` }
    if (before) {
      return { ok: false, why: 'older', text: `${before.name} runs an older Centralu, which mail does not reach. Update it there; until then your parent hears from you at your turn's end.` }
    }
    if (hubs.length) return { ok: false, why: 'unknown', text: 'no computer linked to this one says it started this session, so nothing was sent. End your turn with the answer: that is how your parent hears from you.' }
    return {
      ok: false,
      why: 'elsewhere',
      text: "your parent is a session on another computer, which is not linked to this one now or runs a Centralu from before mail crossed computers, so nothing was sent. End your turn with the answer: that is how your parent hears from you.",
    }
  }
}
