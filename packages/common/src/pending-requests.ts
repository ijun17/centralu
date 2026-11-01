type Waiting<T> = { resolve: (v: T) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

/**
 * Requests sent and not yet answered, by id. Each waits at most its own bound, and its timer goes with
 * it however it settles: left running after an answer, every request kept a closure (and its answer's
 * caller) alive for the full bound. The timers are unref'd, so a wait never keeps the host running.
 */
export class PendingRequests<T = unknown> {
  private readonly waiting = new Map<string, Waiting<T>>()

  /**
   * The answer to `id`, or a rejection once `timeoutMs` has passed without one: an `Error` with `timeout` as its text, or
   * the error `timeout()` makes (one that carries a code or `retryable`)
   */
  wait(id: string | number, timeoutMs: number, timeout: string | (() => Error)): Promise<T> {
    const key = String(id)
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.waiting.delete(key)) reject(typeof timeout === 'string' ? new Error(timeout) : timeout())
      }, timeoutMs)
      timer.unref?.()
      this.waiting.set(key, { resolve, reject, timer })
    })
  }

  /** Settles `id` with its answer. False when nothing waits for it (answered already, timed out, or never asked) */
  resolve(id: string | number, value: T): boolean {
    const w = this.take(id)
    w?.resolve(value)
    return !!w
  }

  reject(id: string | number, error: Error): boolean {
    const w = this.take(id)
    w?.reject(error)
    return !!w
  }

  /** Every waiting request at once, with one reason: the other side is gone, or its answers can no longer be read */
  rejectAll(error: Error): void {
    const all = [...this.waiting.values()]
    this.waiting.clear()
    for (const w of all) {
      clearTimeout(w.timer)
      w.reject(error)
    }
  }

  get size(): number {
    return this.waiting.size
  }

  private take(id: string | number): Waiting<T> | undefined {
    const key = String(id)
    const w = this.waiting.get(key)
    if (!w) return undefined
    this.waiting.delete(key)
    clearTimeout(w.timer)
    return w
  }
}
