/**
 * A child's exit, reported once its output has all arrived (#428): an agent CLI started here
 * (`adapters/local-process.ts`) or in the keeper (`keeper/agent-process.ts`), a pty the keeper holds
 * (`keeper/keeper-pty.ts`), and an app process (`apps/external/app-process.ts`).
 *
 * 'exit' can arrive before the last of the output, and that last line is the one a reader needs: a
 * turn's result, a crash's reason. So the report waits for the output's end. A grandchild that
 * inherited the pipe can hold it open for as long as it runs, so the wait is capped: past `capMs`
 * after the exit, it is reported anyway.
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
