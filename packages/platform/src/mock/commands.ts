import type { MockClock } from './clock.js'
import type { TerminalsMock } from './terminals.js'

/** Frequently used commands (#60), behind the `commands` port: one last run per command */
export class CommandsMock {
  /** Keyed by (projectId, command), as on the host */
  commandRuns = new Map<
    string,
    {
      command: string
      runId: string
      running: boolean
      exitCode: number | null
      startedAt: number
      history: string
    }
  >()
  /** A test's switch: a stop that does not end the run, as a process ignoring it past the host's wait */
  stopDoesNotEnd = false
  private runKey(projectId: string, command: string): string {
    return `${projectId}\u0000${command}`
  }
  /** Output goes out on the terminal's lane */
  emitCommandOutput(projectId: string, command: string, data: string): void {
    const r = this.commandRuns.get(this.runKey(projectId, command))
    if (!r) return
    r.history += data
    for (const h of this.terminalsMock.termHandlers) h({ terminalId: r.runId, data })
  }
  exitCommand(projectId: string, command: string, exitCode: number): void {
    const r = this.commandRuns.get(this.runKey(projectId, command))
    if (!r || !r.running) return
    r.running = false
    r.exitCode = exitCode
    for (const h of this.terminalsMock.termExitHandlers) h({ terminalId: r.runId, exitCode })
  }

  /** As the host (#2472): a running command the saved list drops is stopped first, or the list is not saved */
  async stopDropped(projectId: string, keep: ReadonlySet<string>): Promise<void> {
    for (const [key, r] of this.commandRuns) {
      if (!key.startsWith(`${projectId}\u0000`) || !r.running || keep.has(r.command)) continue
      if (this.stopDoesNotEnd) throw new Error(`${r.command} did not stop, so it stays on the list`)
      await this.commands.stop(projectId, r.command)
    }
  }

  // As the host (#60): a re-run kills and replaces the last run, and the log lives as long as the run does
  readonly commands = {
    run: async (projectId: string, command: string, _cols: number, _rows: number) => {
      const r = {
        command,
        runId: `mock-run-${this.clock.next()}`,
        running: true,
        exitCode: null as number | null,
        startedAt: this.clock.now(),
        history: '',
      }
      this.commandRuns.set(this.runKey(projectId, command), r)
      const { history: _h, ...rest } = r
      return rest
    },
    stop: async (projectId: string, command: string) => {
      // On the host onExit follows the kill; the mock exits at once (130: the SIGINT convention)
      this.exitCommand(projectId, command, 130)
    },
    state: async (projectId: string) => {
      const out = []
      for (const [k, r] of this.commandRuns) {
        if (!k.startsWith(`${projectId}\u0000`)) continue
        const { history: _h, ...rest } = r
        out.push(rest)
      }
      return out
    },
    log: async (projectId: string, command: string) => {
      const r = this.commandRuns.get(this.runKey(projectId, command))
      return r ? { ...r } : null
    },
    resize: async () => {},
  }

  constructor(
    private readonly clock: MockClock,
    private readonly terminalsMock: TerminalsMock,
  ) {}
}
