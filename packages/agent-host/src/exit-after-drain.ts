/**
 * A child's exit reported once its output has all arrived (#428), for agent CLIs (`adapters/local-process.ts`) and app
 * processes: 'exit' can come before the last output, the line a reader needs, and a grandchild that inherited the pipe can hold
 * it open, so the wait is capped at `capMs`
 */

/** How long an exit waits for the last of the output before it is reported anyway */
export const EXIT_AFTER_OUTPUT_MS = 1000

export class ExitAfterDrain {
  private exitKnown = false
  private outputDrained = false
  private reported = false
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly report: () => void,
    private readonly capMs = EXIT_AFTER_OUTPUT_MS,
  ) {}

  /** The process has exited. `drained`: its output is already known to be all here */
  exited(drained = false): void {
    if (this.reported) return
    this.exitKnown = true
    if (drained) this.outputDrained = true
    if (this.outputDrained) return this.fire()
    this.timer ??= setTimeout(() => this.fire(), this.capMs)
    this.timer.unref?.()
  }

  /** The output has ended. Before the exit, the report waits for it; after it, the report goes now */
  drained(): void {
    this.outputDrained = true
    if (this.exitKnown) this.fire()
  }

  /** Reports nothing, ever: the process was let go of */
  cancel(): void {
    this.reported = true
    this.clear()
  }

  get done(): boolean {
    return this.reported
  }

  private fire(): void {
    if (this.reported) return
    this.reported = true
    this.clear()
    this.report()
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
