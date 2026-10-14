import { randomUUID } from 'node:crypto'
import type { NormalizedEvent } from '@cc/protocol'

/**
 * An agent's "Apply now" (#665): `update_centralu` action "apply" asks the windows to relaunch into the installed build,
 * the way the window's own button does (#352), and answers once a relaunch started or says why not.
 *
 * Only a window can relaunch: the host has no relaunch of its own, and the checks (installed build newer than the
 * window, the bundle verified, a relaunch port that the keeper holds the host for) are the window's. So the host
 * asks, in two steps over the event stream:
 *
 *   1. `update_apply_request`: every window makes the button's checks and answers (`updates.answerApply`). The first
 *      that is ready gets a ticket; nothing relaunches yet. With no window ready the call ends here, with the windows'
 *      reasons, before the person is asked anything.
 *   2. After the caller's consent, the windows are asked again (a minute on a card can change what is installed or
 *      which windows are open), and `update_apply_go` names the first ready window's ticket. That window alone runs its
 *      "Apply now" and reports (`updates.reportApply`); its connection ending after the go counts as started, since a
 *      relaunched window can close before its report is written.
 *
 * One window relaunches: tickets go to one answer per request, and the keeper's relaunch (`apply_update_relaunch`) is
 * the one owner of the swap that follows, as it is for the button. A replayed request or go (a window reconnecting
 * within this host's event log) finds no request waiting, or holds no ticket, and starts nothing. A host swap in the
 * middle ends this host and its requests: the next host knows none of them, so a late answer gets no ticket.
 */
export type ApplyProbe =
  | { ready: true; requestId: string; ticket: string; client: number; version?: string }
  | { ready: false; error: string }

export type ApplyOutcome = { ok: true; version?: string } | { ok: false; error: string }

/** How long the windows get to answer. Their checks are one call to the shell; a bridge or a hub never answers */
const ANSWER_MS = 5_000
/** How long the picked window gets to report. Its relaunch is one call to the shell, which answers before it exits */
const OUTCOME_MS = 20_000

export const NO_WINDOW =
  'No Centralu window is open, so nothing was relaunched. The installed build starts the next time the person opens Centralu.'
export const NO_ANSWER =
  'No Centralu window answered. A window of an older build cannot apply an update for an agent: ask the person to click Apply now on the update line.'

type Probe = {
  requestId: string
  answered: Set<number>
  reasons: string[]
  finish: (p: ApplyProbe) => void
}

type Go = {
  requestId: string
  ticket: string
  client: number
  version?: string
  finish: (o: ApplyOutcome) => void
}

export class UpdateApplyBroker {
  private probes = new Map<string, Probe>()
  private goes = new Map<string, Go>()

  constructor(
    private readonly opts: {
      push: (e: NormalizedEvent) => void
      /** The windows connected now (bridges are not counted); a hub linked to this host is counted and never answers */
      windows: () => number
      answerMs?: number
      outcomeMs?: number
    },
  ) {}

  /**
   * The whole call: ask, then the caller's consent (null to go on, or why not), then ask again and relaunch one window.
   * `consent` runs only when a window was ready, so "nothing installed" never raises a card.
   */
  async apply(consent: () => Promise<string | null>): Promise<ApplyOutcome> {
    const first = await this.probe()
    if (!first.ready) return { ok: false, error: first.error }
    const refused = await consent()
    if (refused) return { ok: false, error: refused }
    const ready = await this.probe()
    if (!ready.ready) return { ok: false, error: ready.error }
    return this.go(ready)
  }

  /** Asks every window whether its "Apply now" could relaunch now; resolves with the first ready one */
  probe(): Promise<ApplyProbe> {
    if (this.opts.windows() === 0) return Promise.resolve({ ready: false, error: NO_WINDOW })
    const requestId = randomUUID()
    return new Promise<ApplyProbe>((resolve) => {
      const p: Probe = {
        requestId,
        answered: new Set(),
        reasons: [],
        finish: (r) => {
          if (!this.probes.delete(requestId)) return
          clearTimeout(timer)
          resolve(r)
        },
      }
      const timer = setTimeout(() => p.finish(this.notReady(p)), this.opts.answerMs ?? ANSWER_MS)
      this.probes.set(requestId, p)
      this.opts.push({ type: 'update_apply_request', requestId })
    })
  }

  /** `updates.answerApply`: a ticket for the first ready window of a request still waiting, null for every other */
  answer(client: number, a: { requestId: string; ready: boolean; reason?: string; version?: string }): { ticket: string | null } {
    const p = this.probes.get(a.requestId)
    if (!p || p.answered.has(client)) return { ticket: null }
    p.answered.add(client)
    if (a.ready) {
      const ticket = randomUUID()
      p.finish({ ready: true, requestId: a.requestId, ticket, client, ...(a.version ? { version: a.version } : {}) })
      return { ticket }
    }
    const reason = a.reason?.trim() || 'That window cannot relaunch into the installed build.'
    if (!p.reasons.includes(reason)) p.reasons.push(reason)
    // Every window said no: no reason to wait out the bound
    if (p.answered.size >= this.opts.windows()) p.finish(this.notReady(p))
    return { ticket: null }
  }

  /** Tells the picked window to relaunch and waits for its report, its connection ending, or the bound */
  go(ready: Extract<ApplyProbe, { ready: true }>): Promise<ApplyOutcome> {
    return new Promise<ApplyOutcome>((resolve) => {
      const g: Go = {
        requestId: ready.requestId,
        ticket: ready.ticket,
        client: ready.client,
        ...(ready.version ? { version: ready.version } : {}),
        finish: (o) => {
          if (!this.goes.delete(ready.ticket)) return
          clearTimeout(timer)
          resolve(o)
        },
      }
      const timer = setTimeout(
        () => g.finish({ ok: false, error: 'The window was told to relaunch but did not say whether it did. Look at Centralu to see whether it relaunched.' }),
        this.opts.outcomeMs ?? OUTCOME_MS,
      )
      this.goes.set(ready.ticket, g)
      this.opts.push({ type: 'update_apply_go', requestId: ready.requestId, ticket: ready.ticket })
    })
  }

  /** `updates.reportApply`: the picked window's outcome. A report for another window's ticket, or a stale one, is dropped */
  report(client: number, r: { requestId: string; ticket: string; error?: string }): void {
    const g = this.goes.get(r.ticket)
    if (!g || g.requestId !== r.requestId || g.client !== client) return
    g.finish(r.error ? { ok: false, error: r.error } : { ok: true, ...(g.version ? { version: g.version } : {}) })
  }

  /** A window's connection ended: after its go that is the relaunch; before, a window less to wait for */
  clientGone(client: number): void {
    for (const g of [...this.goes.values()]) if (g.client === client) g.finish({ ok: true, ...(g.version ? { version: g.version } : {}) })
    for (const p of [...this.probes.values()]) {
      if (p.answered.size >= this.opts.windows()) p.finish(this.notReady(p))
    }
  }

  private notReady(p: Probe): ApplyProbe {
    if (p.reasons.length === 0) return { ready: false, error: this.opts.windows() === 0 ? NO_WINDOW : NO_ANSWER }
    return { ready: false, error: `Nothing was relaunched. ${p.reasons.join(' ')}` }
  }
}
