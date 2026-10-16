/**
 * Do not let a call that never answers hold the screen hostage.
 *
 * The `label` is the diagnosis. An unnamed timeout only ever surfaced as the outer RPC's 30-second
 * "RPC timed out: agents.resumeSession", and that message does not say **where** it stopped — when
 * an actual MGH session died that way, there was no way to find out after the fact. If each stage
 * fails carrying its own name, the next occurrence of the same incident is its own diagnosis.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label = 'A call'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not finish within ${Math.round(ms / 1000)}s`)), ms)
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
  const bound = new Promise<'bound'>((resolve) => (timer = setTimeout(() => resolve('bound'), ms)))
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
