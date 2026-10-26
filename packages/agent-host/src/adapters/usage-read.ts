/**
 * A usage read that is a command run (#1623): the plan a tool prints, or the totals it counts. Each run starts a process,
 * so one answer is kept, a read in flight is shared, and the asker is never kept waiting on a slow one.
 *
 * - A fresh answer is returned as it is. A stale one is returned at once and read again behind it, so a panel opened an
 *   hour later does not wait on the command.
 * - With no answer yet, the asker waits `softMs` at most, then gets `fallback()` while the read goes on and fills the
 *   cache for the next ask. The panel never sits on a command that hangs.
 * - A read that failed is not run again for `failMs`: the asker gets the last good answer, or `fallback()`.
 */
export type SoftReadOptions<T> = {
  /** Runs the command and parses its output; throws when it cannot */
  read: () => Promise<T>
  /** What to answer when there is nothing better: the tool's plain "no limits" snapshot */
  fallback: () => T
  /** How long an answer is fresh */
  freshMs: number
  /** How long a failure stands before the command is run again */
  failMs: number
  /** How long an asker with no answer yet waits for the command */
  softMs: number
  now?: () => number
  /** Where a failure is said (the host's stderr) */
  onFail?: (err: Error) => void
}

export function softRead<T>(o: SoftReadOptions<T>): () => Promise<T> {
  const now = o.now ?? Date.now
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

  return async () => {
    const t = now()
    if (value && t - value.at < o.freshMs) return value.v
    if (failedAt !== null && t - failedAt < o.failMs) return value?.v ?? o.fallback()
    const run = start()
    if (value) return value.v
    let timer: ReturnType<typeof setTimeout> | undefined
    const soft = new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(o.fallback()), o.softMs)
      timer.unref?.()
    })
    try {
      return await Promise.race([run, soft])
    } finally {
      clearTimeout(timer)
    }
  }
}
