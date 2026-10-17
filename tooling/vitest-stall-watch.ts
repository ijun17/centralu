/**
 * **A test that holds its worker's event loop is named, not guessed at** (#368).
 *
 * Vitest's worker sends the main process a report as tests run (`onTaskUpdate`) and gives up on the
 * answer after 60 s, a limit no option changes. The answer can only be read when the worker's event
 * loop gets a turn, so synchronous work in a test (SQLite writes, `execFileSync`, a big
 * `JSON.stringify`) that runs for about a minute fails the whole run with one unhandled
 * `Error: [vitest-worker]: Timeout calling "onTaskUpdate"`, printed after every test has passed and
 * naming none of them. On windows-2022 that was the most frequent red `windows tests` job in
 * October 2026: the heavy-store fixture's seeds alone held a worker for 45 to 62 s.
 *
 * This watch ticks once a second on timers captured before any test can fake them, and measures
 * how late each tick is. A gap is time the loop was held. A long one is written to stderr with the
 * test that was running, and one long enough to put the run at risk fails that test, so the failure
 * points at the code that blocked instead of at vitest.
 */

export interface Stall {
  ms: number
  /** The test running when the loop was let go, or the file while it is collected */
  where: string
}

export interface StallWatchOptions {
  /** A clock in milliseconds that tests cannot fake */
  now: () => number
  /** The test (or file) running right now */
  where: () => string
  /** How often the watch expects a turn */
  everyMs: number
  /** A gap at least this long is reported */
  reportMs: number
  /** A gap at least this long fails the test it happened in */
  failMs: number
  report: (stall: Stall) => void
}

export class StallWatch {
  private last: number
  private worst: Stall | undefined

  constructor(private readonly o: StallWatchOptions) {
    this.last = o.now()
  }

  /** One tick of the interval: how late it came is how long the loop was held */
  tick(): void {
    const now = this.o.now()
    const held = now - this.last - this.o.everyMs
    this.last = now
    if (held < this.o.reportMs) return
    const stall = { ms: held, where: this.o.where() }
    this.o.report(stall)
    if (held >= this.o.failMs && (!this.worst || held > this.worst.ms)) this.worst = stall
  }

  /** Called after each test: the stall that should fail it, once */
  take(): Stall | undefined {
    // A stall that ended with this test's last synchronous step has not ticked yet
    this.tick()
    const worst = this.worst
    this.worst = undefined
    return worst
  }
}

export const STALL_REPORT_MS = 15_000
/** Vitest gives up at 60 s; failing here leaves room for the answer to be late for other reasons */
export const STALL_FAIL_MS = 45_000

export function stallMessage(s: Stall): string {
  return (
    `the worker's event loop was held for ${(s.ms / 1000).toFixed(1)} s at once in ${s.where}. ` +
    `Vitest stops waiting for its own messages after 60 s ("Timeout calling onTaskUpdate", #368): ` +
    'give the loop a turn (await a setImmediate) between long synchronous steps.'
  )
}
