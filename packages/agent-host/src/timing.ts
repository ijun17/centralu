/**
 * Bounded waits in one place (#428): a hand-written `Promise.race` with a timer drifted (timer not cleared once `p` won,
 * `unref` in some copies only, differing words), so each helper clears and unrefs its timer however the race ends, and a bound
 * never keeps the host running
 */

/**
 * A duration as a sentence says it, in full words (ux-writing.md §1): `20 milliseconds`, `2 minutes`, `4 hours`; seconds up to
 * three minutes unless it is whole minutes, then minutes up to three hours, then hours. Compact units (`20 s`) are for labels
 * and logs, not host messages
 */
export function durationText(ms: number): string {
  const unit = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`
  if (ms === 0) return '0 seconds'
  if (ms < 1000) return unit(ms, 'millisecond')
  const s = Math.round(ms / 1000)
  if (s <= 180 && (s < 60 || s % 60 !== 0)) return unit(s, 'second')
  const min = Math.round(s / 60)
  return min <= 180 ? unit(min, 'minute') : unit(Math.round(min / 60), 'hour')
}

/** Blocks this thread for `ms` without spinning: for a start with nothing to serve yet, and a few-millisecond retry at a hello */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Waits `ms`, or until `signal` aborts (rejecting with its reason as an Error; an already aborted signal rejects at once). The
 * timer holds the process open unless `unref`: a settle before a shutdown step must not let it leave first, while a poll that
 * only matters to a live host need not
 */
export function sleep(ms: number, signal?: AbortSignal, opts: { unref?: boolean } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const why = () => (signal?.reason instanceof Error ? signal.reason : new Error(String(signal?.reason)))
    if (signal?.aborted) return reject(why())
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (opts.unref) timer.unref?.()
    function onAbort() {
      clearTimeout(timer)
      reject(why())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** A timer that never holds the process open */
function unrefTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
  const t = setTimeout(fn, ms)
  t.unref?.()
  return t
}

/**
 * Bounds a call that never answers. The `label` is the diagnosis (or a function of the bound that words the whole message): an
 * unnamed timeout surfaced only as the outer RPC's 30-second "RPC timed out: agents.resumeSession", which does not say where it
 * stopped when a session died that way
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string | ((ms: number) => string) = 'A call'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = unrefTimer(() => reject(new Error(typeof label === 'string' ? `${label} did not finish within ${durationText(ms)}` : label(ms))), ms)
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
 * Waits on `outcome` for at most `ms` and no longer than `signal` lets it (#428): the value, `'bound'`, `'aborted'` (also for a
 * signal aborted before the call) or what one of `wakes` resolved with first. It never rejects on its own, as a bound here is
 * an answer ("still working"). The waits on a delegation, a child, a start request and a handoff each wrote this race, and one
 * lacked the already-aborted check, so a cancelled wait sat out its bound
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
 * Whether the process has ended, or ends within `ms`, by code or by signal: a signalled process has no exit code, and checking
 * the code alone made it wait out the bound
 */
export function waitForExit(proc: Exiting, ms: number): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode != null) return Promise.resolve(true)
  return waitForEvent(proc, 'exit', ms)
}
