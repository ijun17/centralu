import { HubAskResult, HubMethods, oneLineText, type HubAskParams, type HubOffer, type HubProject } from '@cc/protocol'
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
 */

/** How long a list of a hub's projects may take before that hub counts as away for the call (as `LOOKUP_MS`, #984) */
const LOOKUP_MS = 4000

type Hub = { id: string; name: string; client: number | null; projects: HubProject[] | null }

/** A hub's project as an ask_project names it here: its id qualified by the hub's (`<hub id>.<project id>`) */
export type HubProjectRef = { id: string; projectId: string; name: string; hub: string; hubId: string; away?: string }

export type LinkedHubsDeps = {
  /** A call to a connected client (`HostServer.call`) */
  call: (client: number, method: string, params: unknown, opts: { timeoutMs?: number; signal?: AbortSignal }) => Promise<unknown>
  lookupMs?: number
}

/** The words a call that failed for an older hub says (it has no such method) */
const older = (err: unknown) => /Unknown method/i.test((err as Error)?.message ?? '')

export class LinkedHubs {
  private hubs = new Map<string, Hub>()

  constructor(private readonly deps: LinkedHubsDeps) {}

  /** A hub's offer, on the connection it came in on. Off forgets it */
  offer(client: number, o: HubOffer): void {
    if (!o.on) {
      this.hubs.delete(o.hub.id)
      return
    }
    const prev = this.hubs.get(o.hub.id)
    this.hubs.set(o.hub.id, { id: o.hub.id, name: oneLineText(o.hub.name, 120) || o.hub.id, client, projects: prev?.projects ?? null })
  }

  /** A connection ended: a hub it carried is not reachable until it offers again */
  gone(client: number): void {
    for (const h of this.hubs.values()) if (h.client === client) h.client = null
  }

  /** Whether any hub offered (a session's project list says nothing of hubs otherwise) */
  get any(): boolean {
    return this.hubs.size > 0
  }

  /**
   * Every offered hub's projects, asked in parallel and each bounded: a hub that is away contributes the projects it
   * last listed, marked, and its name under `away`
   */
  async projects(): Promise<{ projects: HubProjectRef[]; away: { hubId: string; hub: string; why: string }[] }> {
    const projects: HubProjectRef[] = []
    const away: { hubId: string; hub: string; why: string }[] = []
    await Promise.all(
      [...this.hubs.values()].map(async (h) => {
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
    if (!h) return { ok: false, error: 'That computer no longer lets this machine ask its projects.' }
    if (h.client === null) return { ok: false, error: `${h.name} is ${NOT_REACHABLE}. Try again once its link is back.` }
    let raw: unknown
    try {
      raw = await this.deps.call(h.client, 'hub.askProject', params, { signal })
    } catch (err) {
      if (signal?.aborted) return { ok: false, error: 'The call was cancelled.' }
      if (older(err)) return { ok: false, error: `${h.name} runs a Centralu from before this, so it cannot be asked. Update it there.` }
      return { ok: false, error: `${h.name} could not be asked: ${oneLineText((err as Error).message, 500)}` }
    }
    const parsed = HubAskResult.safeParse(raw)
    if (!parsed.success) return { ok: false, error: `${h.name} answered in a form this machine does not read.` }
    const r = parsed.data
    // A refusal may list sessions one per line: kept as lines, and cut to size
    if (!r.ok) return { ok: false, error: r.error.length > 4000 ? `${r.error.slice(0, 4000)}…` : r.error }
    return { ...r, project: oneLineText(r.project, 120), sessionName: oneLineText(r.sessionName, 120) }
  }
}
