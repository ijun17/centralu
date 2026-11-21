import { raceTimeout } from './timing.js'

/**
 * Calls the host serves itself (WebSocket RPCs, in-process MCP tool calls) and how a stop waits for them. `host.stop {ifIdle}`
 * (lifecycle/stop-gate.ts) begins a drain: from when it finds the host idle, every new call is refused as retryable. Measured
 * on a real store (2026-10-04, #280): Centralu tools took at most 0.2 s, app tools 5.6 s (GitHub round trips) over 88 calls, so
 * a bound of about 10 s covers every recorded call and past it the call is cut and the model told to try again; draining every
 * tool was never an option (p99 78 s, longest 4.5 h)
 */

/** A call refused or cut because the host is stopping; `retryable`: the same call made again reaches the host that starts next */
export class DrainCut extends Error {
  readonly retryable = true
  constructor(message: string) {
    super(message)
    this.name = 'DrainCut'
  }
}

export const REFUSED_MESSAGE =
  'Centralu is restarting the agent host and is not taking new calls for a moment. Try again in a few seconds.'

/**
 * Said to a call still running when the bound passes: the work may still finish (a request an app already received cannot be
 * taken back), so the model is told to check before repeating anything unsafe to repeat
 */
function cutMessage(boundMs: number): string {
  const s = Math.round(boundMs / 100) / 10
  return (
    `Centralu restarted the agent host and stopped waiting for this call after ${s}s. ` +
    'It may or may not have finished. Check its effect, then call it again if it is needed.'
  )
}

type Entry = { label: string; cut: (e: DrainCut) => void }

export type DrainReport = {
  waitedFor: number
  cut: string[]
  ms: number
}

export class Drain {
  private readonly inflight = new Set<Entry>()
  private refusing = false
  private idle: (() => void)[] = []

  get draining(): boolean {
    return this.refusing
  }

  get running(): number {
    return this.inflight.size
  }

  /**
   * Runs `run` as a call this host serves: refused at once while draining, and cut when the drain's bound passes (its caller gets
   * a `DrainCut`; `run` is not aborted, as a promise cannot be, but the host exits soon after)
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

  /** Stops taking calls, waits up to `boundMs` for the running ones, then cuts what is left; resolves once nothing this host serves is running */
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
 * The host's one drain, module-level rather than a parameter: the calls it tracks start deep inside adapters (an MCP handler
 * the SDK calls), and threading one object through every constructor would touch a dozen signatures
 */
export const hostDrain = new Drain()

export function drainToolResult(e: DrainCut): { content: { type: 'text'; text: string }[]; isError: true } {
  return { content: [{ type: 'text', text: e.message }], isError: true }
}
