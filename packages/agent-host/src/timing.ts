/**
 * Bounded waits, in one place (#428).
 *
 * A wait written by hand as `Promise.race([p, new Promise((r) => setTimeout(r, ms))])` drifted three
 * ways: its timer was not cleared once `p` won, so every finished wait kept a timer (and what its
 * closure held) for the full bound, and a referenced one kept a leaving process alive that long; `unref`
 * was applied in some copies and not others; and the timeout's words differed. Each helper here clears
 * its timer however the race ends, and unrefs it: a bound is never what keeps the host running.
 */

/** A duration as a timeout message says it: `150ms`, `20s` */
export function durationText(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`
}

/** Blocks this thread for `ms` without spinning: for a start with nothing to serve yet, and a few-millisecond retry at a hello */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** A timer that never holds the process open */
function unrefTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
  const t = setTimeout(fn, ms)
  t.unref?.()
  return t
}

/**
 * Do not let a call that never answers hold the screen hostage.
 *
 * The `label` is the diagnosis. An unnamed timeout only ever surfaced as the outer RPC's 30-second
 * "RPC timed out: agents.resumeSession", and that message does not say **where** it stopped — when
 * an actual session died that way, there was no way to find out after the fact. If each stage
 * fails carrying its own name, the next occurrence of the same incident is its own diagnosis.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label = 'A call'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = unrefTimer(() => reject(new Error(`${label} did not finish within ${durationText(ms)}`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/** `p`'s value, or `fallback` once `ms` has passed without one. A rejection of `p` is passed on */
export function raceTimeout<T, F>(p: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    p,
    new Promise<F>((resolve) => {
      timer = unrefTimer(() => resolve(fallback), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/**
 * Waits on `outcome` for at most `ms`, and no longer than `signal` lets it (#428): the outcome's value, `'bound'`,
 * `'aborted'` (also for a signal aborted before the call), or what one of `wakes` resolved with first. It never
 * rejects on its own, unlike `withTimeout`: a bound here is an answer ("still working"), not a failure. Its timer and
 * listener are gone once it settles. The waits on a delegation, a child, a start request and a handoff each wrote this
 * race themselves, and one lacked the check for a signal already aborted, so a cancelled wait sat out its whole bound.
 */
export async function raceBound<T, W extends unknown[] = []>(
  outcome: Promise<T>,
  ms: number,
  signal?: AbortSignal,
  ...wakes: { [K in keyof W]: Promise<W[K]> }
): Promise<T | W[number] | 'bound' | 'aborted'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const bound = new Promise<'bound'>((resolve) => (timer = unrefTimer(() => resolve('bound'), ms)))
  const aborted = new Promise<'aborted'>((resolve) => {
    if (!signal) return
    onAbort = () => resolve('aborted')
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([outcome, bound, aborted, ...wakes])
  } finally {
    clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
}

/** What a wait needs of an emitter: an `EventEmitter`, a socket, an `AgentProcess` */
type Emitter<E extends string> = {
  once(event: E, listener: () => void): unknown
  off(event: E, listener: () => void): unknown
}

/** Whether one of `events` fired within `ms`. Its listeners go with the wait however it ends */
export function waitForEvent<E extends string>(emitter: Emitter<E>, events: E | readonly E[], ms: number): Promise<boolean> {
  const names: readonly E[] = typeof events === 'string' ? [events as E] : (events as readonly E[])
  return new Promise((resolve) => {
    const done = (fired: boolean) => {
      clearTimeout(timer)
      for (const e of names) emitter.off(e, onEvent)
      resolve(fired)
    }
    const onEvent = () => done(true)
    const timer = unrefTimer(() => done(false), ms)
    for (const e of names) emitter.once(e, onEvent)
  })
}

/** A process as far as its ending goes: a `ChildProcess`, an `AgentProcess` */
export type Exiting = Emitter<'exit'> & { readonly exitCode: number | null; readonly signalCode?: NodeJS.Signals | null }

/**
 * Whether the process has ended, or ends within `ms`. Ended is ended, by code or by signal: a process
 * killed by a signal has no exit code, only a signal code, and checking the exit code alone made a
 * signalled process wait out the whole bound as if it were still running.
 */
export function waitForExit(proc: Exiting, ms: number): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode != null) return Promise.resolve(true)
  return waitForEvent(proc, 'exit', ms)
}
