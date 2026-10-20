import { randomUUID } from 'node:crypto'
import type { HostRequest, HostRequestOutcome, NormalizedEvent } from '@cc/protocol'
import { TrashFlow } from './sessions/trash-flow.js'
import type { HostAskAnswer } from './sessions/host-cards.js'
import type { WindowRpc } from './sessions/window-rpc.js'
import { plainQuoted } from './sessions/tool-answers.js'
import { rpcError } from './rpc-error.js'

/**
 * Host requests (#1405): a call made with the limited credential that cannot be undone or widens what runs without
 * asking (`asks` in transport/method-rights.ts) waits for the person, as a card the window shows, and runs only when
 * they allow it. Not a session's card: the program that asked holds no session's rights, and a card in the
 * orchestrator's slot would read as the orchestrator's doing.
 *
 * - **What the card names.** The trash's deletes go through the orchestrator's own trash flow (sessions/trash-flow.ts),
 *   with this card in place of the orchestrator's: the same question, naming each session and what goes with it, and the
 *   same reading of the trash again after Allow, so nothing the card did not name is deleted (`trash.empty` deletes the
 *   rows its card listed, never what arrived while it stood). Every other method gets a card that names the method and
 *   its parameters, quoted on one line, and runs as called.
 * - **Who answers.** `requests.answer`, which only a window holding the token may call (`window` in method-rights.ts).
 * - **When it is refused at once.** No window that shows host requests is attached with the token (owner, 2026-10-21:
 *   refused, not left standing), or `maxOpen` requests already wait (a loop cannot flood the window).
 * - **When it ends unanswered.** The program disconnects (its socket's signal), `lifetimeMs` passes (15 minutes, owner
 *   2026-10-21: the one card with a timer, since a raw call has no turn to end it), or the host stops (`closeAll`).
 *   Nothing is kept across a host swap: the caller's socket closes with it, and the next host asks again.
 */
export const HOST_REQUEST_LIMITS = { maxOpen: 8, lifetimeMs: 15 * 60_000 }

export type HostRequestsDeps = {
  emit: (event: NormalizedEvent) => void
  /** The window's RPC as the router answers it: what an allowed call runs through, with the token's rights */
  rpc: WindowRpc
  /** Whether a window that shows host requests is attached with the token (`HostServer.showsHostRequests`) */
  canShow: () => boolean
  now?: () => number
  limits?: Partial<typeof HOST_REQUEST_LIMITS>
}

/** Who asked, as the hello said it: never checked, only shown quoted */
export type RequestFrom = { client: string | null }

type Waiting = { request: HostRequest; settle: (answer: 'allow' | 'deny' | null, outcome: HostRequestOutcome) => void }

/** Why a host request ended without running, for a program to read (`data.refused`) */
export type RequestRefusal = 'no_window' | 'too_many_requests' | 'denied' | 'withdrawn' | 'expired'

export class HostRequests {
  private readonly open = new Map<string, Waiting>()
  private readonly limits: typeof HOST_REQUEST_LIMITS
  private readonly now: () => number

  constructor(private readonly deps: HostRequestsDeps) {
    this.limits = { ...HOST_REQUEST_LIMITS, ...deps.limits }
    this.now = deps.now ?? Date.now
  }

  /**
   * A limited call of an `asks` method: the card, then the call once allowed. Rejects with `data.refused` when it does
   * not run. `signal` is the calling socket's: it fires when the program disconnects.
   */
  async ask(method: string, params: unknown, from: RequestFrom, signal: AbortSignal): Promise<unknown> {
    if (this.open.size >= this.limits.maxOpen) {
      throw refused('too_many_requests', `${this.limits.maxOpen} requests already wait for the person in the Centralu window, so ${method} was not done.`)
    }
    if (!this.deps.canShow()) {
      throw refused('no_window', `No Centralu window is open to ask the person, so ${method} was not done. It needs the person's approval in the window.`)
    }
    const p = fields(params)
    switch (method) {
      case 'trash.purge':
        return this.viaTrash(method, from, signal, { action: 'delete', sessionId: str(p.sessionId), what: 'session' }, () => ({ ok: true }))
      case 'trash.purgeSubagentSteps':
        return this.viaTrash(method, from, signal, { action: 'delete', sessionId: str(p.sessionId), what: 'steps' }, () => ({ ok: true }))
      case 'trash.empty':
        return this.viaTrash(method, from, signal, { action: 'empty' }, (purged, text) => ({ purged, failed: [], text }))
      default: {
        const question =
          `Allow ${method}? A program on this computer called it with ${plainQuoted(JSON.stringify(params ?? {}), 300)}. ` +
          'It cannot be undone or widens what runs without asking, so it waits for you. Allow it only if you asked for this.'
        const answer = await this.card(method, question, from, signal)
        if (answer.decision !== 'allow') throw unanswered(method, answer.outcome)
        return this.deps.rpc(method, params)
      }
    }
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

  /** The host stops: every request ends unanswered, and its call runs nothing */
  closeAll(): void {
    for (const w of [...this.open.values()]) w.settle(null, 'withdrawn')
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
    result: (purged: number, text: string) => unknown,
  ): Promise<unknown> {
    /** How the card ended, once one was raised: the flow says only that it did not run */
    const asked: { decision: 'allow' | 'deny' | null; outcome: HostRequestOutcome }[] = []
    const flow = new TrashFlow({
      askHost: async (_caller, detail, cardSignal): Promise<HostAskAnswer> => {
        const answer = await this.card(method, 'raw' in detail ? detail.raw : '', from, cardSignal ?? signal)
        asked.push(answer)
        return answer.decision
      },
    })
    let purged = 0
    flow.useRpc(async (m, p) => {
      const r = await this.deps.rpc(m, p)
      if (m === 'trash.purge') purged++
      return r
    })
    const answer = await flow.run('', req, signal)
    if (!answer.ok) {
      // Not asked at all (nothing to delete, a bad id), or asked and not allowed, or allowed and then changed meanwhile
      const ended = asked.at(-1)
      throw rpcError(answer.error, 'internal', { data: { refused: ended && ended.decision !== 'allow' ? refusalOf(ended.outcome) : 'not_done' } })
    }
    return result(purged, answer.text)
  }

  /** Raises one card and waits for its answer, its time, or its caller going away */
  private card(method: string, question: string, from: RequestFrom, signal: AbortSignal): Promise<{ decision: 'allow' | 'deny' | null; outcome: HostRequestOutcome }> {
    if (signal.aborted) return Promise.resolve({ decision: null, outcome: 'withdrawn' })
    const createdAt = this.now()
    const request: HostRequest = {
      requestId: randomUUID(),
      method,
      question,
      client: from.client === null ? null : plainQuoted(from.client),
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

function refusalOf(outcome: HostRequestOutcome): RequestRefusal {
  return outcome === 'denied' ? 'denied' : outcome === 'expired' ? 'expired' : 'withdrawn'
}

function refused(why: RequestRefusal, message: string): Error {
  return rpcError(message, 'internal', { data: { refused: why } })
}

function unanswered(method: string, outcome: HostRequestOutcome): Error {
  const why = refusalOf(outcome)
  const message =
    why === 'denied'
      ? `The person did not allow ${method}, so it was not done.`
      : why === 'expired'
        ? `Nobody answered the card for ${method} in time, so it was not done.`
        : `The card for ${method} was withdrawn before the person answered, so it was not done.`
  return refused(why, message)
}
