import type { LocalUsage } from './contract.js'

/**
 * A usage read that is a command run (#1623): the plan a tool prints, or the totals it counts. Each run starts a process,
 * so one answer is kept, a read in flight is shared, and the asker is never kept waiting on a slow one.
 *
 * - A fresh answer is returned as it is. A stale one is returned at once and read again behind it, so a panel opened an
 *   hour later does not wait on the command.
 * - With no answer yet, the asker waits `softMs` at most, then gets `fallback()` marked `provisional` while the read goes on
 *   and fills the cache for the next ask. The panel never sits on a command that hangs. A provisional answer is never kept:
 *   only what the command read is.
 * - `settle: true` waits for the read in flight (it has its own ceiling, the command's timeout) and answers what it read:
 *   how an open panel receives the answer of a command that took longer than the soft wait, without polling.
 * - A read that failed is not run again for `failMs`: the asker gets the last good answer, or `fallback()`. That is final
 *   (not provisional): nothing is being read.
 */
export type SoftReadOptions<T> = {
  /** Runs the command and parses its output; throws when it cannot */
  read: () => Promise<T>
  /** What to answer when there is nothing better: the tool's plain "nothing known" answer */
  fallback: () => T
  /** How long an answer is fresh; a function when it depends on the answer (a logged-out account may log in the next minute) */
  freshMs: number | ((value: T) => number)
  /** How long a failure stands before the command is run again */
  failMs: number
  /** How long an asker with no answer yet waits for the command */
  softMs: number
  now?: () => number
  /** Where a failure is said (the host's stderr) */
  onFail?: (err: Error) => void
}

export type SoftAnswer<T> = { value: T; provisional: boolean }

export function softRead<T>(o: SoftReadOptions<T>): (ask?: { settle?: boolean }) => Promise<SoftAnswer<T>> {
  const now = o.now ?? Date.now
  const freshFor = (v: T) => (typeof o.freshMs === 'function' ? o.freshMs(v) : o.freshMs)
  let value: { at: number; v: T } | null = null
  let failedAt: number | null = null
  let inflight: Promise<T> | null = null

  const start = (): Promise<T> =>
    (inflight ??= o
      .read()
      .then(
        (v) => {
          value = { at: now(), v }
          failedAt = null
          return v
        },
        (e: unknown) => {
          failedAt = now()
          o.onFail?.(e instanceof Error ? e : new Error(String(e)))
          return value?.v ?? o.fallback()
        },
      )
      .finally(() => {
        inflight = null
      }))

  return async (ask = {}) => {
    const t = now()
    if (value && t - value.at < freshFor(value.v)) return { value: value.v, provisional: false }
    if (failedAt !== null && t - failedAt < o.failMs) return { value: value?.v ?? o.fallback(), provisional: false }
    const run = start()
    if (value) return { value: value.v, provisional: false }
    if (ask.settle) return { value: await run, provisional: false }
    let timer: ReturnType<typeof setTimeout> | undefined
    const soft = new Promise<SoftAnswer<T>>((resolve) => {
      timer = setTimeout(() => resolve({ value: o.fallback(), provisional: true }), o.softMs)
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
export function localUsageReader(o: SoftReadOptions<LocalUsage>): (ask?: { settle?: boolean }) => Promise<LocalUsage> {
  const read = softRead(o)
  return async (ask) => {
    const { value, provisional } = await read(ask)
    return provisional ? { ...value, provisional: true } : value
  }
}
