import { HubAskResult, HubMethods, errorMessage, oneLineText, type HubAskParams, type HubOffer, type HubProject } from '@cc/protocol'
import { NOT_REACHABLE } from '../adapters/contract.js'
import { LOOKUP_MS } from './machine-reach.js'
import type { AppsPeer } from './linked-apps.js'
import type { StartingHub } from '../sessions/hub-preset.js'

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
 *     for asks says, and a session it started here mails its parent there through it (`mail`), through that hub only.
 *     Its projects are listed and asked only while that switch is on.
 */

/** `asks`: the hub's switch for this machine is on. `mail`: it takes mail from the sessions it started here */
type Hub = { id: string; name: string; client: number | null; projects: HubProject[] | null; asks: boolean; mail: boolean; apps: boolean; you: string | null }

/** How long a message to a hub may take before the send is refused as not known to have arrived */
const MAIL_MS = 30_000

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
  /** Records the hub that started a session here (`recordStartingHub`), for one created before that hub offered (`awaitOffer`) */
  record?: (sessionId: string, hub: StartingHub) => void
}

/** The words a call that failed for an older hub says (it has no such method) */
const older = (err: unknown) => /Unknown method/i.test(errorMessage(err))

export class LinkedHubs {
  private hubs = new Map<string, Hub>()
  /** Sessions a hub created on a connection before it offered there, by connection (`awaitOffer`) */
  private readonly waiting = new Map<number, string[]>()

  /** Run each time a hub offers mail on a connection (`onMailOffer`) */
  private readonly mailOffered = new Set<(hubId: string) => void>()

  constructor(private readonly deps: LinkedHubsDeps) {}

  /** `fn` runs each time a hub offers mail here, at each connect: what crossed while it was away is told then (#2067 review) */
  onMailOffer(fn: (hubId: string) => void): void {
    this.mailOffered.add(fn)
  }

  /** A hub's offer, on the connection it came in on. Off, without mail and without apps, forgets it */
  offer(client: number, o: HubOffer): void {
    const mail = o.mail === true
    const apps = o.apps === true
    if (!o.on && !mail && !apps) {
      this.hubs.delete(o.hub.id)
      return
    }
    const prev = this.hubs.get(o.hub.id)
    const projects = o.on ? (prev?.projects ?? null) : null
    const name = oneLineText(o.hub.name, 120) || o.hub.id
    this.hubs.set(o.hub.id, { id: o.hub.id, name, client, projects, asks: o.on, mail, apps, you: o.you ?? null })
    const waiting = this.waiting.get(client)
    this.waiting.delete(client)
    for (const id of waiting ?? []) this.deps.record?.(id, { id: o.hub.id, name, apps })
    if (mail) for (const fn of this.mailOffered) fn(o.hub.id)
  }

  /** The hubs whose switch for this machine is on: the ones whose projects its sessions may ask */
  private asking(): Hub[] {
    return [...this.hubs.values()].filter((h) => h.asks)
  }

  /** A connection ended: a hub it carried is not reachable until it offers again */
  gone(client: number): void {
    this.waiting.delete(client)
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
   * A hub's apps for a session it started here (#1938, docs/plans/remote-hub.md §13.5), called on the connection it
   * offered on and no other. `answers`: it said it answers `hub.apps`; one that did not is never called, since a hub from
   * before it leaves a call from a machine unanswered
   */
  appsPeer(hubId: string): AppsPeer | undefined {
    const h = this.hubs.get(hubId)
    if (!h) return undefined
    return {
      id: h.id,
      name: h.name,
      reachable: h.client !== null,
      answers: h.apps,
      gives: true,
      call: (method, params, timeoutMs) => {
        const client = this.hubs.get(hubId)?.client
        if (client === null || client === undefined) return Promise.reject(new Error(`${h.name} is ${NOT_REACHABLE}`))
        return this.deps.call(client, `hub.${method}`, params, { timeoutMs })
      },
    }
  }

  /** The hub that offered apps on this connection, if one did: only it calls `host.apps` and `host.appCall` here (#1938) */
  appsOn(client: number): { id: string; name: string } | undefined {
    for (const h of this.hubs.values()) if (h.client === client && h.apps) return { id: h.id, name: h.name }
    return undefined
  }

  /** The hub that offered on this connection, if one did (`startedByHub`: the hub a session it creates here records) */
  on(client: number): StartingHub | undefined {
    for (const h of this.hubs.values()) if (h.client === client) return { id: h.id, name: h.name, apps: h.apps }
    return undefined
  }

  /**
   * A hub that takes mail (#2067), as mail across calls it (`MailAcross`, docs/plans/linked-mail.md §6): on the connection
   * it offered on and no other. `you`: this machine's id there, which a hub from before item 2 does not say
   */
  peer(hubId: string): { id: string; name: string; reachable: boolean; you: string | null; call(method: string, params: unknown): Promise<unknown> } | undefined {
    // A hub that offered asks and not mail is from before it: called all the same, it answers "Unknown method", which names the cause
    const h = this.hubs.get(hubId)
    if (!h) return undefined
    return {
      id: h.id,
      name: h.name,
      reachable: h.client !== null,
      you: h.you,
      call: (method, params) => {
        const client = this.hubs.get(hubId)?.client
        if (client === null || client === undefined) return Promise.reject(new Error(`${h.name} is ${NOT_REACHABLE}`))
        return this.deps.call(client, method, params, { timeoutMs: this.deps.mailTimeoutMs ?? MAIL_MS })
      },
    }
  }

  /** Every hub that takes mail, for a search across them */
  mailHubs(): NonNullable<ReturnType<LinkedHubs['peer']>>[] {
    return [...this.hubs.values()].flatMap((h) => {
      const p = h.mail ? this.peer(h.id) : undefined
      return p ? [p] : []
    })
  }

  /**
   * A session a hub created on this connection before it offered here (item 1's open case): recorded under the hub that
   * then offers on the connection (`deps.record`), so its `parent` reaches that hub. A connection that ends first forgets it
   */
  awaitOffer(client: number, sessionId: string): void {
    this.waiting.set(client, [...(this.waiting.get(client) ?? []), sessionId])
  }
}
