import { raceTimeout } from './timing.js'

/**
 * Calls the host serves itself, and how a stop waits for them: work it is doing **itself** on someone's behalf, a
 * WebSocket RPC (the UI, the Codex bridge) and an in-process MCP tool call (the Centralu tools, the app-tool proxy).
 *
 * Built for the blue-green swap (#280 step 3), which drained the old host while its agents kept going; no host swaps
 * since #1895. What begins a drain now is `host.stop {ifIdle}` (lifecycle/stop-gate.ts): from the moment it finds the
 * host idle, every new call is refused as retryable, so nothing starts on a host that is going.
 *
 * Measured on a real store (2026-10-04, #280 "Measurements for option C" §2): Centralu tools
 * took at most 0.2 s, app tools at most 5.6 s (GitHub round trips), over 88 calls. A bound of about
 * 10 s covers every recorded call with margin; past it the call is cut and the model is told to try
 * again, rather than the stop waiting on an app that may never answer. Draining every tool was never
 * an option: p99 over all tools is 78 s and the longest ran 4.5 h.
 */

/**
 * A call refused or cut because the host is stopping. `retryable`: the same call made again reaches the host that
 * starts next.
 */
export class DrainCut extends Error {
  readonly retryable = true
  constructor(message: string) {
    super(message)
    this.name = 'DrainCut'
  }
}

/** Said to a call that arrives once the drain has begun */
export const REFUSED_MESSAGE =
  'Centralu is restarting the agent host and is not taking new calls for a moment. Try again in a few seconds.'

/**
 * Said to a call still running when the bound passes. The work itself may still finish (the host
 * cannot take back a request an app already received), so the model is told to check before it
 * repeats anything that is not safe to repeat.
 */
export function cutMessage(boundMs: number): string {
  const s = Math.round(boundMs / 100) / 10
  return (
    `Centralu restarted the agent host and stopped waiting for this call after ${s}s. ` +
    'It may or may not have finished. Check its effect, then call it again if it is needed.'
  )
}

type Entry = { label: string; cut: (e: DrainCut) => void }

export type DrainReport = {
  /** Calls running when the drain began */
  waitedFor: number
  /** Labels of the calls still running at the bound, which were cut */
  cut: string[]
  /** How long the wait took */
  ms: number
}

export class Drain {
  private readonly inflight = new Set<Entry>()
  private refusing = false
  private idle: (() => void)[] = []

  /** True once a drain has begun: new calls are refused from then on, for the rest of this host's life */
  get draining(): boolean {
    return this.refusing
  }

  /** Calls running right now */
  get running(): number {
    return this.inflight.size
  }

  /**
   * Runs `run` as a call this host serves.
   *
   * While draining, a new call is refused at once. A call still running when the drain's bound
   * passes is cut: its caller gets a `DrainCut` and the host stops waiting for it. `run` is not
   * aborted (a promise cannot be), but the host exits soon after, which ends it.
   */
  track<T>(label: string, run: () => Promise<T>): Promise<T> {
    if (this.refusing) return Promise.reject(new DrainCut(REFUSED_MESSAGE))
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const settle = (): boolean => {
        if (settled) return false
        settled = true
        this.inflight.delete(entry)
        if (this.inflight.size === 0) for (const r of this.idle.splice(0)) r()
        return true
      }
      const entry: Entry = { label, cut: (e) => settle() && reject(e) }
      this.inflight.add(entry)
      Promise.resolve()
        .then(run)
        .then(
          (v) => settle() && resolve(v),
          (e: unknown) => settle() && reject(e),
        )
    })
  }

  /**
   * Stops taking calls, waits up to `boundMs` for the running ones, then cuts whatever is left.
   * Resolves once nothing this host serves is running.
   */
  async drain(boundMs: number): Promise<DrainReport> {
    this.refusing = true
    const t0 = Date.now()
    const waitedFor = this.inflight.size
    if (waitedFor === 0) return { waitedFor, cut: [], ms: 0 }
    const finished = await raceTimeout(
      new Promise<true>((r) => this.idle.push(() => r(true))),
      boundMs,
      false,
    )
    const cut: string[] = []
    if (!finished) {
      for (const e of [...this.inflight]) {
        cut.push(e.label)
        e.cut(new DrainCut(cutMessage(boundMs)))
      }
    }
    return { waitedFor, cut, ms: Date.now() - t0 }
  }
}

/**
 * The host's one drain. A module-level instance rather than a parameter: the calls it tracks start
 * deep inside the adapters (an MCP handler the SDK calls), and threading one object through every
 * constructor on the way would touch a dozen signatures for a value that is one per process anyway.
 */
export const hostDrain = new Drain()

/** An MCP tool result saying the call was refused or cut, so the model reads why instead of a crash */
export function drainToolResult(e: DrainCut): { content: { type: 'text'; text: string }[]; isError: true } {
  return { content: [{ type: 'text', text: e.message }], isError: true }
}
