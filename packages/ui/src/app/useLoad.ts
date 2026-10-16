import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react'

/** What a screen knows about something it reads when it shows (`useLoad`) */
export type Loaded<T> = {
  /**
   * The last answer; undefined before the first one arrives, while a new subject is read, and after a new subject
   * failed. A failed refresh keeps it, beside `error`
   */
  data: T | undefined
  /** Why the last read failed; null when it did not. Set together with `data` when a refresh failed */
  error: string | null
  /** A read is in flight */
  loading: boolean
}

export type Load<T> = Loaded<T> & {
  /** Reads again now, keeping what is shown until the answer arrives; settles once that read is over, never rejects */
  reload: () => Promise<void>
}

const IDLE: Loaded<never> = { data: undefined, error: null, loading: false }

/** A failure's reason as a line a screen can print */
export function loadErrorText(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e)
  return text.trim() || 'Unknown error'
}

/**
 * The rules of `useLoad` without React, so they are tested on their own: which answer counts, and what a failure or
 * a new subject leaves on screen. `show` receives each change as an update of what is shown.
 */
export function createLoader<T>(show: (update: (shown: Loaded<T>) => Loaded<T>) => void) {
  /** The number of the read whose answer counts; any other answer is late */
  let current = 0
  return {
    /**
     * Asks `ask`. `keep` leaves what is shown on screen until the answer (the same subject read again); without it
     * what was shown goes at once (a new subject). An `ask` that returns null has nothing to ask: the load is idle.
     * Never rejects.
     */
    async read(ask: () => Promise<T> | null, keep: boolean): Promise<void> {
      const id = ++current
      let pending: Promise<T> | null
      try {
        pending = ask()
      } catch (e) {
        show(() => ({ data: undefined, error: loadErrorText(e), loading: false }))
        return
      }
      if (!pending) {
        show(() => IDLE)
        return
      }
      show((s) => (keep ? { ...s, loading: true } : { data: undefined, error: null, loading: true }))
      try {
        const data = await pending
        if (id === current) show(() => ({ data, error: null, loading: false }))
      } catch (e) {
        // A refresh that failed leaves the last answer beside its error (#850 review); a new subject has none to keep
        if (id === current) show((s) => ({ data: keep ? s.data : undefined, error: loadErrorText(e), loading: false }))
      }
    },
    /** Makes every answer still on its way late (the subject changed, the screen went away) */
    drop(): void {
      current++
    },
  }
}

/**
 * Reads something when a screen shows it, and again when what it is about changes (#850 item 8).
 *
 * About thirty components wrote this by hand: a state, an effect, an `alive` flag against a late answer, and a
 * `.catch` that most often set an empty list. That last part is why a failed read looked like an empty one: the
 * evidence panel said "No changes" and "No commits yet", and settings said "No saved rules", when the host had not
 * answered at all. Here a failure is an `error`, never an empty `data`, and the screen says what failed
 * (`LoadFailed`). A refresh that fails keeps what was shown, with the error beside it: the list is still what it was
 * a moment ago, and the line says it may be out of date.
 *
 * - `read` asks the question; when it returns null there is nothing to ask (yet), and the load is idle. Written
 *   inline, so `exhaustive-deps` sees what it uses.
 * - `deps` are what the question is about (a project, a session): when one changes, what was shown goes and the new
 *   subject is read. `exhaustive-deps` checks them as it does an effect's (eslint.config.js).
 * - `refresh` are signals that the same subject changed (a file touched, a version bumped): it is read again while the
 *   last answer stays on screen, so a list does not blink on every refresh.
 *
 * An answer to an older question (the subject changed, the screen went away, a newer read started) is dropped.
 */
export function useLoad<T>(read: () => Promise<T> | null, deps: DependencyList, refresh: DependencyList = []): Load<T> {
  // Loading until the first read says otherwise: it runs before anything reads `data` past the first render
  const [shown, setShown] = useState<Loaded<T>>({ data: undefined, error: null, loading: true })
  const [loader] = useState(() => createLoader<T>(setShown))
  const latest = useRef(read)
  latest.current = read

  useEffect(() => {
    void loader.read(latest.current, false)
    // The subject changed or the screen went away: an answer still on its way is late
    return () => loader.drop()
    // `deps` is the caller's list, checked where it is written
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  // The first run of this effect is the read above; only a later change of `refresh` reads again
  const refreshed = useRef(false)
  useEffect(() => {
    if (!refreshed.current) {
      refreshed.current = true
      return
    }
    void loader.read(latest.current, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, refresh)

  const reload = useCallback(() => loader.read(latest.current, true), [loader])
  return { ...shown, reload }
}
