import { randomUUID } from 'node:crypto'
import type { HostRequest, HostRequestOutcome, NormalizedEvent } from '@cc/protocol'
import { TrashFlow } from './sessions/trash-flow.js'
import type { HostAskAnswer } from './sessions/host-cards.js'
import type { WindowRpc } from './sessions/window-rpc.js'
import { plainQuoted } from './sessions/tool-answers.js'
import { rpcError } from './rpc-error.js'
import { asItRuns, effectOf, namedTargets } from './host-request-targets.js'

/**
 * Host requests (#1405): a call made with the limited credential that cannot be undone or widens what runs without
 * asking (`asks` in transport/method-rights.ts) waits for the person, as a card the window shows, and runs only when
 * they allow it. Not a session's card: the program that asked holds no session's rights, and a card in the
 * orchestrator's slot would read as the orchestrator's doing.
 *
 * - **What the card names.** The trash's deletes go through the orchestrator's own trash flow (sessions/trash-flow.ts),
 *   with this card in place of the orchestrator's: the same question, naming each session and what goes with it, and the
 *   same reading of the trash again after Allow, so nothing the card did not name is deleted (`trash.empty` deletes the
 *   rows its card listed, never what arrived while it stood). Every other method gets a card that names the method, what
 *   it acts on by name and what it loses, and its parameters as its schema parses them, quoted on one line; it runs with
 *   those parsed parameters (`generic`, host-request-targets.ts).
 * - **Who answers.** `requests.answer`, which only a window holding the token may call (`window` in method-rights.ts).
 * - **When it is refused at once.** No window that shows host requests is attached with the token (owner, 2026-10-21:
 *   refused, not left standing), or `maxOpen` requests already wait (a loop cannot flood the window).
 * - **When it ends unanswered.** The program disconnects (its socket's signal), `lifetimeMs` passes (15 minutes, owner
 *   2026-10-21: the one card with a timer, since a raw call has no turn to end it), or no window shows requests for
 *   `windowGoneMs` (`closeAll`). A host that stops ends them through the first: its sockets close with it.
 *   Nothing is kept across a host swap: the caller's socket closes with it, and the next host asks again.
 */
export const HOST_REQUEST_LIMITS = { maxOpen: 8, lifetimeMs: 15 * 60_000, windowGoneMs: 30_000 }

/** How long a generic card's parameters may be: what runs is what the card shows, whole, so a longer call is refused */
const SHOWN_PARAMS_MAX = 2000

/** What `HostRequest` holds of a name the program gave (its `client`), escapes included */
const QUOTED_NAME_MAX = 200

/**
 * A name quoted for a card (`plainQuoted`), within `QUOTED_NAME_MAX` once its escapes are written: a name of format
 * characters is several times longer quoted, and a request over its schema's bound is one the window cannot read
 */
export function quotedName(value: string): string {
  for (let max = 60; ; max = Math.floor(max / 2)) {
    const quoted = plainQuoted(value, max)
    if (quoted.length <= QUOTED_NAME_MAX || max === 0) return quoted
  }
}

export type HostRequestsDeps = {
  emit: (event: NormalizedEvent) => void
  /** The window's RPC as the router answers it: what an allowed call runs through, with the token's rights */
  rpc: WindowRpc
  /** Whether a window that shows host requests is attached with the token (`HostServer.showsHostRequests`) */
  canShow: () => boolean
  /** A session's name, to say on a card which session's process asked (#1405); null when there is none */
  sessionName?: (sessionId: string) => string | null
  now?: () => number
  limits?: Partial<typeof HOST_REQUEST_LIMITS>
}

/**
 * Who asked, as the hello said it: what the program called itself, never checked, and the session whose credential it
 * holds (#1405, session-token.ts), which says only which session's process it claims to be
 */
export type RequestFrom = { client: string | null; session?: string }

type Waiting = { request: HostRequest; settle: (answer: 'allow' | 'deny' | null, outcome: HostRequestOutcome) => void }

/** How a card ended: answered, gone unanswered, or never raised (the bound, or no window to show it) */
type Ended = { decision: 'allow' | 'deny' | null; outcome: HostRequestOutcome | 'too_many_requests' | 'no_window' }

/** Why a host request ended without running, for a program to read (`data.refused`) */
export type RequestRefusal = 'no_window' | 'too_many_requests' | 'denied' | 'withdrawn' | 'expired' | 'not_done'

export class HostRequests {
  private readonly open = new Map<string, Waiting>()
  private readonly limits: typeof HOST_REQUEST_LIMITS
  private readonly now: () => number
  /** Set while no window shows requests: when it fires, what still waits is withdrawn (`showingChanged`) */
  private noWindow: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly deps: HostRequestsDeps) {
    this.limits = { ...HOST_REQUEST_LIMITS, ...deps.limits }
    this.now = deps.now ?? Date.now
  }

  /**
   * A limited call of an `asks` method: the card, then the call once allowed. Rejects with `data.refused` when it does
   * not run. `signal` is the calling socket's: it fires when the program disconnects.
   */
  async ask(method: string, params: unknown, from: RequestFrom, signal: AbortSignal): Promise<unknown> {
    // Said before anything is read; `card` checks both again when it raises, after the trash was read
    const early = this.cannotRaise()
    if (early) throw unanswered(method, early)
    const p = fields(params)
    switch (method) {
      case 'trash.purge':
        return this.viaTrash(method, from, signal, { action: 'delete', sessionId: str(p.sessionId), what: 'session' }, () => ({ ok: true }))
      case 'trash.purgeSubagentSteps':
        return this.viaTrash(method, from, signal, { action: 'delete', sessionId: str(p.sessionId), what: 'steps' }, () => ({ ok: true }))
      case 'trash.empty':
        return this.viaTrash(method, from, signal, { action: 'empty' }, (purged, text, failed) => ({ purged, failed, text }))
      default:
        return this.generic(method, params, from, signal)
    }
  }

  /**
   * Any other method's card (host-request-targets.ts): the call parsed by its method's schema, which is what the card
   * shows and what runs, what it acts on by name, and what it loses. After Allow the names are read again, and a call
   * whose target changed meanwhile (renamed, deleted, unlinked) is not run: the person allowed what the card named.
   */
  private async generic(method: string, params: unknown, from: RequestFrom, signal: AbortSignal): Promise<unknown> {
    const runs = asItRuns(method, params)
    if (!runs.ok) throw refused('not_done', `${method} was not done: ${runs.why}.`)
    // The card shows every parameter that will run: one too long to show whole is refused, never cut
    const shown = JSON.stringify(runs.params ?? {})
    if (shown.length > SHOWN_PARAMS_MAX) {
      throw refused('not_done', `The parameters of ${method} are too long to show the person whole (${shown.length} characters, at most ${SHOWN_PARAMS_MAX}), so it was not done.`)
    }
    const targets = await namedTargets(this.deps.rpc, runs.params)
    if (!targets.ok) throw refused('not_done', `${method} was not done: ${targets.why}.`)
    const question =
      `Allow ${method}${targets.text ? ` for ${targets.text}` : ''}? ${effectOf(method, runs.params)}` +
      `A program on this computer called it with ${plainQuoted(shown, SHOWN_PARAMS_MAX)}. ` +
      'It cannot be undone or widens what runs without asking, so it waits for you. Allow it only if you asked for this.'
    const answer = await this.card(method, question, from, signal)
    if (answer.decision !== 'allow') throw unanswered(method, answer.outcome)
    const now = await namedTargets(this.deps.rpc, runs.params)
    if (!now.ok || now.text !== targets.text) {
      throw refused('not_done', `${method} was not done: what its card named changed while it stood (${now.ok ? `now ${now.text}` : now.why}).`)
    }
    return this.deps.rpc(method, runs.params)
  }

  /** The requests waiting, oldest first */
  list(): HostRequest[] {
    return [...this.open.values()].map((w) => w.request).sort((a, b) => a.createdAt - b.createdAt)
  }

  /** The person's answer from a window; false when the request no longer waits */
  answer(requestId: string, decision: 'allow' | 'deny'): boolean {
    const w = this.open.get(requestId)
    if (!w) return false
    w.settle(decision, decision === 'allow' ? 'allowed' : 'denied')
    return true
  }

  /** Every request ends unanswered, and its call runs nothing: no window came back in time (`showingChanged`) */
  closeAll(): void {
    for (const w of [...this.open.values()]) w.settle(null, 'withdrawn')
  }

  /**
   * How many windows that show requests are attached (`HostServer`'s `onShowing`). With none, what waits is withdrawn
   * once `windowGoneMs` passes with none back: a card nobody can see is not left standing (owner, 2026-10-21), and a
   * window that reloads, or reconnects after a swap behind the front door, comes back within it and keeps its cards.
   */
  showingChanged(count: number): void {
    if (count > 0) {
      if (this.noWindow) clearTimeout(this.noWindow)
      this.noWindow = null
      return
    }
    if (this.noWindow || this.open.size === 0) return
    this.noWindow = setTimeout(() => {
      this.noWindow = null
      if (!this.deps.canShow()) this.closeAll()
    }, this.limits.windowGoneMs)
    this.noWindow.unref?.()
  }

  /** Why no card can be raised now, or null */
  private cannotRaise(): 'too_many_requests' | 'no_window' | null {
    if (this.open.size >= this.limits.maxOpen) return 'too_many_requests'
    if (!this.deps.canShow()) return 'no_window'
    return null
  }

  /**
   * A trash delete through the orchestrator's own flow, with this card for its question. `result` makes the method's own
   * answer from how many sessions the flow purged and what it said.
   */
  private async viaTrash(
    method: string,
    from: RequestFrom,
    signal: AbortSignal,
    req: { action: 'delete'; sessionId: string; what: 'session' | 'steps' } | { action: 'empty' },
    result: (purged: number, text: string, failed: { sessionId: string; name: string; error: string }[]) => unknown,
  ): Promise<unknown> {
    /** How the card ended, once one was raised: the flow says only that it did not run */
    const asked: Ended[] = []
    const flow = new TrashFlow({
      askHost: async (_caller, detail, cardSignal): Promise<HostAskAnswer> => {
        const answer = await this.card(method, 'raw' in detail ? detail.raw : '', from, cardSignal ?? signal)
        asked.push(answer)
        return answer.decision
      },
    })
    let purged = 0
    /** The sessions whose purge failed, by the names the trash gave them, as `trash.empty` answers them */
    const failed: { sessionId: string; name: string; error: string }[] = []
    const names = new Map<string, string>()
    flow.useRpc(async (m, p) => {
      try {
        const r = await this.deps.rpc(m, p)
        if (m === 'trash.list') for (const row of listed(r)) names.set(row.id, row.name)
        if (m === 'trash.purge') purged++
        return r
      } catch (e) {
        if (m === 'trash.purge') {
          const sessionId = str(fields(p).sessionId)
          failed.push({ sessionId, name: names.get(sessionId) ?? sessionId, error: e instanceof Error ? e.message : String(e) })
        }
        throw e
      }
    })
    const answer = await flow.run('', req, signal)
    if (!answer.ok) {
      // Not asked at all (nothing to delete, a bad id), or asked and not allowed, or allowed and then changed meanwhile
      const ended = asked.at(-1)
      // Never raised (the bound, no window): its own message, not the flow's "withdrawn before the person answered"
      if (ended && (ended.outcome === 'too_many_requests' || ended.outcome === 'no_window')) throw unanswered(method, ended.outcome)
      throw rpcError(answer.error, 'internal', { data: { refused: ended && ended.decision !== 'allow' ? refusalOf(ended.outcome) : 'not_done' } })
    }
    return result(purged, answer.text, failed)
  }

  /** Raises one card and waits for its answer, its time, or its caller going away */
  private card(method: string, question: string, from: RequestFrom, signal: AbortSignal): Promise<Ended> {
    if (signal.aborted) return Promise.resolve({ decision: null, outcome: 'withdrawn' })
    // Checked here too: a trash delete reads the trash first, and many of them at once must not get past the bound
    const cannot = this.cannotRaise()
    if (cannot) return Promise.resolve({ decision: null, outcome: cannot })
    const createdAt = this.now()
    const request: HostRequest = {
      requestId: randomUUID(),
      method,
      question,
      client: from.client === null ? null : quotedName(from.client),
      // A session credential's session (#1405): its name quoted, its id when it has none
      session: from.session ? quotedName(this.deps.sessionName?.(from.session) ?? from.session) : null,
      createdAt,
      expiresAt: createdAt + this.limits.lifetimeMs,
    }
    return new Promise((resolve) => {
      const onAbort = () => settle(null, 'withdrawn')
      const timer = setTimeout(() => settle(null, 'expired'), this.limits.lifetimeMs)
      timer.unref?.()
      const settle = (decision: 'allow' | 'deny' | null, outcome: HostRequestOutcome) => {
        if (!this.open.delete(request.requestId)) return
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        this.deps.emit({ type: 'host_request_resolved', requestId: request.requestId, outcome })
        resolve({ decision, outcome })
      }
      this.open.set(request.requestId, { request, settle })
      signal.addEventListener('abort', onAbort, { once: true })
      this.deps.emit({ type: 'host_request', request })
    })
  }
}

function fields(params: unknown): Record<string, unknown> {
  return params !== null && typeof params === 'object' && !Array.isArray(params) ? { ...params } : {}
}

/** A parameter as the flow's own id check reads it: anything but a string is checked (and refused) as an empty one */
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function refusalOf(outcome: Ended['outcome']): RequestRefusal {
  if (outcome === 'too_many_requests' || outcome === 'no_window') return outcome
  return outcome === 'denied' ? 'denied' : outcome === 'expired' ? 'expired' : 'withdrawn'
}

/** The rows of a `trash.list` answer, read defensively */
function listed(r: unknown): { id: string; name: string }[] {
  const sessions = fields(r).sessions
  if (!Array.isArray(sessions)) return []
  return sessions.flatMap((row: unknown) => {
    const f = fields(row)
    return typeof f.id === 'string' && typeof f.name === 'string' ? [{ id: f.id, name: f.name }] : []
  })
}

function refused(why: RequestRefusal, message: string): Error {
  return rpcError(message, 'internal', { data: { refused: why } })
}

function unanswered(method: string, outcome: Ended['outcome']): Error {
  const why = refusalOf(outcome)
  switch (why) {
    case 'too_many_requests':
      return refused(why, `Too many requests already wait for the person in the Centralu window, so ${method} was not done.`)
    case 'no_window':
      return refused(why, `No Centralu window is open to ask the person, so ${method} was not done. It needs the person's approval in the window.`)
    case 'denied':
      return refused(why, `The person did not allow ${method}, so it was not done.`)
    case 'expired':
      return refused(why, `Nobody answered the card for ${method} in time, so it was not done.`)
    default:
      return refused(why, `The card for ${method} was withdrawn before the person answered, so it was not done.`)
  }
}
