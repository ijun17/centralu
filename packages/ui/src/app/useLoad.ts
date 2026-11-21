import { errorMessage } from '@cc/protocol/client'
import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react'

export type Loaded<T> = {
  /** Undefined while a new subject is read or after it failed; a failed refresh keeps it beside `error` */
  data: T | undefined
  error: string | null
  loading: boolean
}

export type Load<T> = Loaded<T> & {
  /** Keeps what is shown until the answer; never rejects */
  reload: () => Promise<void>
}

const IDLE: Loaded<never> = { data: undefined, error: null, loading: false }

export function loadErrorText(e: unknown): string {
  const text = errorMessage(e)
  return text.trim() || 'Unknown error'
}

/** The rules of `useLoad` without React, so they are tested on their own */
export function createLoader<T>(show: (update: (shown: Loaded<T>) => Loaded<T>) => void) {
  let current = 0
  return {
    /** `keep`: the same subject, shown until the answer. A null `ask` leaves the load idle. Never rejects */
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
        // A failed refresh keeps the last answer beside its error; a new subject has none to keep
        if (id === current) show((s) => ({ data: keep ? s.data : undefined, error: loadErrorText(e), loading: false }))
      }
    },
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
 * - `keepLast` leaves the last answer on screen while `deps` change and the new one is read, as a refresh does: for a
 *   question that is typed or toggled (a search box, a grouping), not one about another subject.
 * - `delayMs` waits that long before each read starts and starts it only if nothing changed meanwhile (a search box asks
 *   when the typing pauses).
 *
 * An answer to an older question (the subject changed, the screen went away, a newer read started) is dropped.
 */
export function useLoad<T>(
  read: () => Promise<T> | null,
  deps: DependencyList,
  refresh: DependencyList = [],
  { delayMs = 0, keepLast = false }: { delayMs?: number; keepLast?: boolean } = {},
): Load<T> {
  // Loading until the first read says otherwise: it runs before anything reads `data` past the first render
  const [shown, setShown] = useState<Loaded<T>>({ data: undefined, error: null, loading: true })
  const [loader] = useState(() => createLoader<T>(setShown))
  const latest = useRef(read)
  latest.current = read

  const start = (keep: boolean) => {
    if (delayMs <= 0) {
      void loader.read(latest.current, keep)
      return () => {}
    }
    const t = setTimeout(() => void loader.read(latest.current, keep), delayMs)
    return () => clearTimeout(t)
  }

  useEffect(() => {
    const cancel = start(keepLast)
    return () => {
      cancel()
      loader.drop()
    }
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
    return start(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, refresh)

  const reload = useCallback(() => loader.read(latest.current, true), [loader])
  return { ...shown, reload }
}
