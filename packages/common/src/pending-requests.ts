type Waiting<T> = { resolve: (v: T) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

/**
 * Requests waiting for an answer, by id. A timer goes with its request however it settles, or it keeps a closure alive
 * for the full bound. Timers are unref'd:
 * a wait never keeps the host running.
 */
export class PendingRequests<T = unknown> {
  private readonly waiting = new Map<string, Waiting<T>>()

  /** `timeout` as a function makes an error that can carry a code or `retryable` */
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

  /** False when nothing waits for it (answered, timed out, or never asked) */
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
