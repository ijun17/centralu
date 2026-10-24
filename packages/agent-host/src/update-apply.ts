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
 *      "Apply now" and reports (`updates.reportApply`): "started" right before it relaunches, then an error or done.
 *      Its connection ending counts as the relaunch only after "started", since a relaunching window can close before
 *      its last report is written; ending before it is answered as not known.
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
/** How long a window whose connection ended before it said "started" gets to reconnect and report */
const GONE_GRACE_MS = 5_000

export const NO_WINDOW =
  'No Centralu window is open, so nothing was relaunched. The installed build starts the next time the person opens Centralu.'
export const WINDOW_GONE =
  'The window that was told to relaunch went away before it said it was relaunching, so whether it relaunched is not known. Look at Centralu.'
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
  /** The connection the window last spoke on: the go's answer, then its latest report */
  client: number
  /** The window said it is relaunching now (`reportApply` with `started`) */
  started: boolean
  version?: string
  /** Running while the window's connection is gone before "started", for it to come back */
  grace?: ReturnType<typeof setTimeout>
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
      goneGraceMs?: number
    },
  ) {}

  /**
   * The whole call: ask, then the caller's consent (null to go on, or why not), then ask again and relaunch one window.
   * `consent` runs only when a window was ready, so "nothing installed" never raises a card.
   * `unasked` is for a consent that went without a card (#1509): read again after the second probe, it answers null to go on
   * (the window then also waits out typing), a reason to stop, or undefined when a person's card stood for it.
   */
  async apply(consent: () => Promise<string | null>, unasked?: () => string | null | undefined): Promise<ApplyOutcome> {
    const first = await this.probe()
    if (!first.ready) return { ok: false, error: first.error }
    const refused = await consent()
    if (refused) return { ok: false, error: refused }
    const ready = await this.probe()
    if (!ready.ready) return { ok: false, error: ready.error }
    // Read once more right before the relaunch: the second probe takes up to `answerMs`, and a turn may have started meanwhile
    const late = unasked?.()
    if (typeof late === 'string') return { ok: false, error: late }
    return this.go(ready, late === null)
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

  /**
   * Tells the picked window to relaunch and waits for its outcome (#665 review). The window says "started" right before
   * it relaunches; only after that does its connection ending count as the relaunch. Ending before it — a crash, a
   * reload, a lost socket — is not a success: the window is given `goneGraceMs` to come back and report under the same
   * ticket, then the answer says whether it relaunched is not known.
   */
  go(ready: Extract<ApplyProbe, { ready: true }>, unasked = false): Promise<ApplyOutcome> {
    return new Promise<ApplyOutcome>((resolve) => {
      const g: Go = {
        requestId: ready.requestId,
        ticket: ready.ticket,
        client: ready.client,
        started: false,
        ...(ready.version ? { version: ready.version } : {}),
        finish: (o) => {
          if (!this.goes.delete(ready.ticket)) return
          clearTimeout(timer)
          clearTimeout(g.grace)
          resolve(o)
        },
      }
      const timer = setTimeout(
        () =>
          g.finish({
            ok: false,
            error: g.started
              ? 'The window said it was relaunching but is still open. Look at Centralu to see whether it relaunched.'
              : 'The window was told to relaunch but did not say whether it did. Look at Centralu to see whether it relaunched.',
          }),
        this.opts.outcomeMs ?? OUTCOME_MS,
      )
      this.goes.set(ready.ticket, g)
      this.opts.push({ type: 'update_apply_go', requestId: ready.requestId, ticket: ready.ticket, ...(unasked ? { unasked } : {}) })
    })
  }

  /**
   * `updates.reportApply`: the picked window's outcome. Matched by ticket, not by connection: only that window was given
   * it, and a window that reconnected has a new connection number. A report naming another ticket, or a settled one, is
   * dropped. The connection it came on is the one whose end is watched from then on.
   */
  report(client: number, r: { requestId: string; ticket: string; started?: boolean; error?: string }): void {
    const g = this.goes.get(r.ticket)
    if (!g || g.requestId !== r.requestId) return
    g.client = client
    clearTimeout(g.grace)
    g.grace = undefined
    if (r.error) return g.finish({ ok: false, error: r.error })
    if (r.started) {
      g.started = true
      return
    }
    g.finish(this.relaunched(g))
  }

  /** A window's connection ended: after "started" that is the relaunch; before it, unknown; and one less to wait for */
  clientGone(client: number): void {
    for (const g of [...this.goes.values()]) {
      if (g.client !== client) continue
      if (g.started) {
        g.finish(this.relaunched(g))
        continue
      }
      clearTimeout(g.grace)
      g.grace = setTimeout(() => g.finish({ ok: false, error: WINDOW_GONE }), this.opts.goneGraceMs ?? GONE_GRACE_MS)
    }
    for (const p of [...this.probes.values()]) {
      if (p.answered.size >= this.opts.windows()) p.finish(this.notReady(p))
    }
  }

  private relaunched(g: Go): ApplyOutcome {
    return { ok: true, ...(g.version ? { version: g.version } : {}) }
  }

  private notReady(p: Probe): ApplyProbe {
    if (p.reasons.length === 0) return { ready: false, error: this.opts.windows() === 0 ? NO_WINDOW : NO_ANSWER }
    return { ready: false, error: `Nothing was relaunched. ${p.reasons.join(' ')}` }
  }
}
