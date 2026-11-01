import { useEffect, useRef, type DependencyList } from 'react'

/** When the window comes back in view: `late` asks only if a tick was skipped meanwhile, `always` asks every time */
export type OnReturn = 'late' | 'always'

/**
 * The rules of `useWhileVisible` without a window, so they are tested on their own. `run` is what the caller wants done.
 * - A tick asks only while the window is in view: a hidden window shows nothing, and asking can start a process for nobody.
 * - Coming back asks at once, so what is shown is not stale until the next tick: always, or only when a whole period passed
 *   since the last ask (a tick was skipped, or the window was hidden long enough to have missed one).
 */
export function createVisibleTicker(env: { hidden: () => boolean; now: () => number }, everyMs: number, onReturn: OnReturn, run: () => void) {
  let last = env.now()
  const ask = () => {
    last = env.now()
    run()
  }
  return {
    /** Asks now, whether or not the window is in view (the first read) */
    ask,
    tick: () => {
      if (!env.hidden()) ask()
    },
    back: () => {
      if (env.hidden()) return
      if (onReturn === 'always' || env.now() - last >= everyMs) ask()
    },
  }
}

/**
 * Asks `fn` every `everyMs` while the window is in view, and again at once when it comes back (#1143). One place for the
 * pause-while-hidden rule that the usage meter, the update check and a linked machine's install watch each wrote.
 *
 * `fn` is the latest one passed; it is told whether this run of the effect is still the current one (`live`), for an answer
 * that arrives after `restartOn` changed or the component left. `restartOn` restarts the clock, as an effect's list does.
 * - `immediate`: asks once when it starts, in view or not.
 * - `onReturn`: see `OnReturn`; `late` by default.
 * - `onFocus`: the window gaining focus counts as coming back.
 * - `enabled`: false stops it altogether.
 */
export function useWhileVisible(
  fn: (live: () => boolean) => void,
  everyMs: number,
  { immediate = false, onReturn = 'late', onFocus = false, enabled = true }: { immediate?: boolean; onReturn?: OnReturn; onFocus?: boolean; enabled?: boolean } = {},
  restartOn: DependencyList = [],
): void {
  const latest = useRef(fn)
  latest.current = fn
  useEffect(() => {
    if (!enabled) return
    let live = true
    const ticker = createVisibleTicker({ hidden: () => document.hidden, now: () => Date.now() }, everyMs, onReturn, () => latest.current(() => live))
    if (immediate) ticker.ask()
    const timer = setInterval(ticker.tick, everyMs)
    document.addEventListener('visibilitychange', ticker.back)
    if (onFocus) window.addEventListener('focus', ticker.back)
    return () => {
      live = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', ticker.back)
      window.removeEventListener('focus', ticker.back)
    }
    // `restartOn` is the caller's list, as for an effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, everyMs, immediate, onReturn, onFocus, ...restartOn])
}
