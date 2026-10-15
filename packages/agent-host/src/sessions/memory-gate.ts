import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { freemem } from 'node:os'
import { promisify } from 'node:util'
import { availableMemorySource } from '../os.js'

/**
 * The start gate for new agent sessions (#686): a child is started only while the machine has room for it.
 *
 * Each Claude child with code intelligence can run its own language server (0.5–1.1 GB measured), and the CLI itself
 * takes another 0.3–0.5 GB. Ten children at once on a 24 GB Mac can push the machine into swap, which slows every
 * session and the person's own apps. So a start below the floor is **queued, not refused** (owner decision
 * 2026-10-15): the caller gets a handle, the person sees a notice, and the start goes ahead once memory recovers.
 *
 * Starts the person makes by hand are not gated: they chose to start one, and they can see the machine.
 */

/** The floor (owner decision 2026-10-15): 2 GB free plus reclaimable */
export const MEMORY_FLOOR_BYTES = 2 * 1024 ** 3
/** How often a queued start reads memory again */
export const MEMORY_RECHECK_MS = 15_000
/**
 * How long a queued start waits before it gives up (CONTRIBUTING: "Can it wait forever?"). Half an hour: long enough for
 * a build or another agent's language server to finish, short enough that a start nobody remembers does not fire
 * hours later into a different situation.
 */
export const MEMORY_WAIT_MAX_MS = 30 * 60_000

/**
 * Free plus reclaimable bytes from `vm_stat` (macOS): free, inactive and speculative pages times the page size the
 * header states. Inactive pages are what the kernel takes back first under pressure (file cache, and anonymous pages it
 * compresses); purgeable pages are left out since they are already counted inside active and inactive.
 */
export function parseVmStat(text: string): number | null {
  const size = /page size of (\d+) bytes/.exec(text)
  if (!size) return null
  const pages = (name: string): number | null => {
    const m = new RegExp(`^Pages ${name}:\\s+(\\d+)\\.?\\s*$`, 'm').exec(text)
    return m ? Number(m[1]) : null
  }
  const free = pages('free')
  const inactive = pages('inactive')
  if (free === null || inactive === null) return null
  return (free + inactive + (pages('speculative') ?? 0)) * Number(size[1])
}

/** `MemAvailable` from `/proc/meminfo` (Linux): the kernel's own estimate of memory available without swapping */
export function parseMemInfo(text: string): number | null {
  const m = /^MemAvailable:\s+(\d+)\s*kB\s*$/m.exec(text)
  return m ? Number(m[1]) * 1024 : null
}

const run = promisify(execFile)

/** What `readAvailableMemory` reads with; a test passes its own */
export type MemoryReadDeps = {
  source?: ReturnType<typeof availableMemorySource>
  exec?: (file: string, args: string[]) => Promise<{ stdout: string }>
  readText?: (path: string) => Promise<string>
  free?: () => number
}

/**
 * Free plus reclaimable memory on this machine, in bytes; null when it could not be read, which lets the start go
 * (`MemoryGate.short`). A failed `vm_stat` or `/proc/meminfo` read is **not** replaced with `os.freemem()`: there it
 * counts only the free pages (0.08 GB on a 24 GB Mac with 9 GB reclaimable), so the gate would never open and every
 * child would wait out the bound (#695 review). Only Windows, where `os.freemem()` is the source, reads it.
 */
export async function readAvailableMemory(deps: MemoryReadDeps = {}): Promise<number | null> {
  const source = deps.source ?? availableMemorySource()
  const free = deps.free ?? freemem
  if (source.kind === 'freemem') return free()
  const what = source.kind === 'command' ? source.file : source.path
  try {
    const value =
      source.kind === 'command'
        ? parseVmStat((await (deps.exec ?? ((f, a) => run(f, a, { timeout: 5_000 })))(source.file, source.args)).stdout)
        : parseMemInfo(await (deps.readText ?? ((p) => readFile(p, 'utf8')))(source.path))
    if (value !== null) return value
    console.error(`[memory-gate] could not parse ${what}; letting agent starts through`)
  } catch (e) {
    console.error(`[memory-gate] could not read ${what} (${(e as Error).message}); letting agent starts through`)
  }
  return null
}

/** A reading below the floor: what was available, and what is needed */
export type MemoryShortfall = { available: number; floor: number }

/** "1.4 GB": a byte count as the person and the model read it */
export function gigabytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

export type MemoryWaitOutcome = 'ready' | 'timeout' | 'aborted'

type Waiter = { resolve: (o: MemoryWaitOutcome) => void; deadline: number; signal?: AbortSignal; onAbort?: () => void }

/**
 * The gate itself. `short()` answers whether a start may go now; `wait()` queues one until memory recovers.
 *
 * **One start per check.** When memory comes back, the queued starts do not all go at once: a child takes its memory
 * over the first seconds of its turn, so ten released together would find the same free memory and sink the machine
 * again. The oldest goes, and the next one reads memory again at the next check.
 */
export class MemoryGate {
  private readonly read: () => Promise<number | null>
  readonly floor: number
  private readonly recheckMs: number
  private readonly maxWaitMs: number
  private readonly now: () => number
  private waiters: Waiter[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private closed = false

  constructor(
    opts: { read?: () => Promise<number | null>; floor?: number; recheckMs?: number; maxWaitMs?: number; now?: () => number } = {},
  ) {
    this.read = opts.read ?? readAvailableMemory
    this.floor = opts.floor ?? MEMORY_FLOOR_BYTES
    this.recheckMs = opts.recheckMs ?? MEMORY_RECHECK_MS
    this.maxWaitMs = opts.maxWaitMs ?? MEMORY_WAIT_MAX_MS
    this.now = opts.now ?? Date.now
  }

  /** How long a queued start waits at most, for the words the caller and the person read */
  get maxWaitMinutes(): number {
    return Math.round(this.maxWaitMs / 60_000)
  }

  /**
   * null when a start may go now; otherwise the reading. A read that fails (throws, or answers null) lets the start go:
   * the gate never blocks on itself
   */
  async short(): Promise<MemoryShortfall | null> {
    let available: number | null
    try {
      available = await this.read()
    } catch {
      return null
    }
    return available !== null && available < this.floor ? { available, floor: this.floor } : null
  }

  /** Starts waiting now (oldest first), until memory is back, the bound passes, or `signal` aborts */
  wait(signal?: AbortSignal): Promise<MemoryWaitOutcome> {
    if (this.closed || signal?.aborted) return Promise.resolve('aborted')
    return new Promise<MemoryWaitOutcome>((resolve) => {
      const w: Waiter = { resolve, deadline: this.now() + this.maxWaitMs, ...(signal ? { signal } : {}) }
      if (signal) {
        w.onAbort = () => this.settle(w, 'aborted')
        signal.addEventListener('abort', w.onAbort, { once: true })
      }
      this.waiters.push(w)
      this.schedule()
    })
  }

  /** How many starts are queued */
  get queued(): number {
    return this.waiters.length
  }

  /** The host is leaving: every queued start ends without starting (a stored request is resumed by the next host) */
  close(): void {
    this.closed = true
    clearTimeout(this.timer)
    this.timer = undefined
    for (const w of [...this.waiters]) this.settle(w, 'aborted')
  }

  private settle(w: Waiter, outcome: MemoryWaitOutcome): void {
    const i = this.waiters.indexOf(w)
    if (i < 0) return
    this.waiters.splice(i, 1)
    if (w.onAbort) w.signal?.removeEventListener('abort', w.onAbort)
    w.resolve(outcome)
    if (!this.waiters.length) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private schedule(): void {
    if (this.timer || this.closed || !this.waiters.length) return
    this.timer = setTimeout(() => void this.tick(), this.recheckMs)
    this.timer.unref?.()
  }

  private async tick(): Promise<void> {
    this.timer = undefined
    const now = this.now()
    for (const w of [...this.waiters]) if (w.deadline <= now) this.settle(w, 'timeout')
    const head = this.waiters[0]
    if (head && !(await this.short())) this.settle(head, 'ready')
    this.schedule()
  }
}
