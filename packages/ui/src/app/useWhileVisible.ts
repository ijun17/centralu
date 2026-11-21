import { useEffect, useRef, type DependencyList } from 'react'

/** When the window comes back in view: `late` asks only if a tick was skipped meanwhile, `always` asks every time */
export type OnReturn = 'late' | 'always'

/**
 * The rules of `useWhileVisible` without a window. A tick asks only while in view (asking can start a process for
 * nobody); coming back asks at once, under `late` only when a whole period passed since the last ask.
 */
export function createVisibleTicker(env: { hidden: () => boolean; now: () => number }, everyMs: number, onReturn: OnReturn, run: () => void) {
  let last = env.now()
  const ask = () => {
    last = env.now()
    run()
  }
  return {
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
 * Asks `fn` every `everyMs` while the window is in view, and at once when it comes back (#1143). `live` says whether
 * this run is still current (`restartOn` changed or the component left). `immediate` asks once at start, in view or
 * not; with `onFocus`, focus counts as coming back.
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
