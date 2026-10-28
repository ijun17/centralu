import { isFromTheFuture } from '../usage-clock.js'
import type { LocalUsage } from './contract.js'

/**
 * A usage read that is a command run (#1623): the plan a tool prints, or the totals it counts. Each run starts a process,
 * so one answer is kept, a read in flight is shared, and the asker is never kept waiting on a slow one.
 *
 * - A fresh answer is returned as it is. A stale one is returned at once and read again behind it, so a panel opened an
 *   hour later does not wait on the command (unless `staleOk` says that kind of answer may not stand in). It is marked
 *   `provisional`: it stands in for the read going on behind it, so the screen that shows it can ask once more with `settle`
 *   and receive the new answer when the read lands, without polling.
 * - With no answer yet, the asker waits `softMs` at most, then gets `fallback()` marked `provisional` while the read goes on
 *   and fills the cache for the next ask. The panel never sits on a command that hangs. A provisional answer is never kept:
 *   only what the command read is.
 * - `settle: true` waits for the read in flight, at most `settleMs`, and answers what it read: how an open panel receives the
 *   answer of a command that took longer than the soft wait, or the new answer behind a stale one it shows, without polling.
 *   Past `settleMs` the answer is provisional again (the stale one, if there was one) and the run goes on; what it reads is
 *   kept for the next ask.
 * - A read that failed is not run again for `failMs`: the asker gets the last good answer, or `fallback()`. That is final
 *   (not provisional): nothing is being read.
 */
export type SoftReadOptions<T> = {
  /** Runs the command and parses its output; throws when it cannot */
  read: () => Promise<T>
  /** What to answer when there is nothing better: the tool's plain "nothing known" answer */
  fallback: () => T
  /**
   * How long an answer is fresh; a function when it depends on the answer (a logged-out account may log in the next minute)
   * or on how long the read took (`tookMs`): a command that takes twelve seconds is not run again every minute
   */
  freshMs: number | ((value: T, tookMs: number) => number)
  /**
   * Whether a stale answer may be returned while it is read again. Default: yes. An answer that says "nobody is logged in"
   * may not: the person may have logged in since, and it would be shown as final; the asker waits for the new read instead
   */
  staleOk?: (value: T) => boolean
  /** How long a failure stands before the command is run again */
  failMs: number
  /** How long an asker with no answer yet waits for the command */
  softMs: number
  /**
   * How long a `settle` waits for the run in flight before it answers provisionally again. The run itself is not cut short
   * by it (a command on a large database may take a minute): only the asker stops waiting, and the next ask finds the answer.
   * Default 20 s, under the screen's own 30 s bound on a call
   */
  settleMs?: number
  now?: () => number
  /** Where a failure is said (the host's stderr) */
  onFail?: (err: Error) => void
}

export type SoftAnswer<T> = { value: T; provisional: boolean }

/** What an ask may carry: `settle` as above, and the last answer a former process read (`at`: when), for a reader with none of its own */
export type SoftAsk<T> = { settle?: boolean; seed?: { value: T; at: number } }

export function softRead<T>(o: SoftReadOptions<T>): (ask?: SoftAsk<T>) => Promise<SoftAnswer<T>> {
  const now = o.now ?? Date.now
  const freshFor = (e: { v: T; tookMs: number }) => (typeof o.freshMs === 'function' ? o.freshMs(e.v, e.tookMs) : o.freshMs)
  let value: { at: number; v: T; tookMs: number } | null = null
  let failedAt: number | null = null
  let inflight: Promise<T> | null = null
  /** The last answer when it may stand in for a read that did not come (a logged-out one may not, also after a failure), else the fallback */
  const standIn = (): T => (value && (o.staleOk?.(value.v) ?? true) ? value.v : o.fallback())

  const start = (): Promise<T> => {
    const began = now()
    return (inflight ??= o
      .read()
      .then(
        (v) => {
          value = { at: now(), v, tookMs: now() - began }
          failedAt = null
          return v
        },
        (e: unknown) => {
          failedAt = now()
          o.onFail?.(e instanceof Error ? e : new Error(String(e)))
          return standIn()
        },
      )
      .finally(() => {
        inflight = null
      }))
  }

  return async (ask = {}) => {
    const t = now()
    // Nothing read in this process yet: the answer a former one kept stands in, as a stale one does (read again behind it)
    if (!value && ask.seed) value = { at: ask.seed.at, v: ask.seed.value, tookMs: 0 }
    if (value && !isFromTheFuture(value.at, t) && t - value.at < freshFor(value)) return { value: value.v, provisional: false }
    if (failedAt !== null && t - failedAt < o.failMs) return { value: standIn(), provisional: false }
    const run = start()
    // The last answer, when it may stand in while the read goes on: returned at once, as provisional, unless the asker settles
    const held = value && (o.staleOk?.(value.v) ?? true) ? { v: value.v } : null
    if (held && !ask.settle) return { value: held.v, provisional: true }
    let timer: ReturnType<typeof setTimeout> | undefined
    const soft = new Promise<SoftAnswer<T>>((resolve) => {
      timer = setTimeout(() => resolve({ value: held ? held.v : o.fallback(), provisional: true }), ask.settle ? (o.settleMs ?? 20_000) : o.softMs)
      timer.unref?.()
    })
    try {
      return await Promise.race([run.then((v): SoftAnswer<T> => ({ value: v, provisional: false })), soft])
    } finally {
      clearTimeout(timer)
    }
  }
}

/** `softRead` for what `AgentAdapter.localUsage` answers: the soft wait's fallback is marked `provisional` on the answer */
export function localUsageReader(o: SoftReadOptions<LocalUsage>): (ask?: { settle?: boolean; seed?: LocalUsage }) => Promise<LocalUsage> {
  const read = softRead(o)
  return async (ask) => {
    // The seed's age is when its totals were read; one without that is no seed (nothing says how old it is)
    const at = ask?.seed?.totals?.asOf
    const { value, provisional } = await read({ settle: ask?.settle, ...(ask?.seed && at !== undefined ? { seed: { value: ask.seed, at } } : {}) })
    return provisional ? { ...value, provisional: true } : value
  }
}
