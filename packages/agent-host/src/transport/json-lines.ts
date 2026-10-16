import type { Readable } from 'node:stream'
import { lineSplitter } from '../stream-text.js'

/**
 * Newline-delimited JSON, as codex's app-server, the keeper's child service and the keeper's swap
 * control speak it, and as codex writes its rollout files (#428).
 *
 * **Split at `\n` only, never with `readline`.** readline also ends a line at U+2028 and U+2029, which
 * JSON leaves raw inside a string (measured, Node 26: a `compacted` rollout line holding one came out
 * as two lines, neither of them JSON). It is also what cut codex's 23,244,422-byte `thread/resume`
 * answer into 22,049,101 bytes plus the rest (`codex/client.ts`). Every reader here splits with
 * `lineSplitter`, which also decodes the bytes as one stream.
 */
export { lineSplitter, type LineSplitter } from '../stream-text.js'

/** The lines of a stream, split at `\n` only (see the file header), as an async iterator, e.g. over a file */
export async function* readLines(stream: Readable): AsyncGenerator<string> {
  const ready: string[] = []
  const split = lineSplitter((line) => ready.push(line))
  for await (const chunk of stream) {
    split.push(chunk as Buffer | string)
    while (ready.length > 0) yield ready.shift()!
  }
  split.flush()
  while (ready.length > 0) yield ready.shift()!
}

type Waiting<T> = { resolve: (v: T) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

/**
 * Requests sent and not yet answered, by id. Each waits at most its own bound, and its timer goes with
 * it however it settles: left running after an answer, every request kept a closure (and its answer's
 * caller) alive for the full bound. The timers are unref'd, so a wait never keeps the host running.
 */
export class PendingRequests<T = unknown> {
  private readonly waiting = new Map<string, Waiting<T>>()

  /** The answer to `id`, or a rejection with `timeoutMessage` once `timeoutMs` has passed without one */
  wait(id: string | number, timeoutMs: number, timeoutMessage: string): Promise<T> {
    const key = String(id)
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.waiting.delete(key)) reject(new Error(timeoutMessage))
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
