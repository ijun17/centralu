import type { MockClock } from './clock.js'
import type { TerminalsMock } from './terminals.js'

/** Frequently used commands (#60), behind the `commands` port: one last run per command */
export class CommandsMock {
  /** Run state for frequently used commands (#60). The key is the same (projectId, command) pair as the real thing */
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
  private runKey(projectId: string, command: string): string {
    return `${projectId}\u0000${command}`
  }
  /** For tests: a running command produces output (goes out on the same lane as the terminal) */
  emitCommandOutput(projectId: string, command: string, data: string): void {
    const r = this.commandRuns.get(this.runKey(projectId, command))
    if (!r) return
    r.history += data
    for (const h of this.terminalsMock.termHandlers) h({ terminalId: r.runId, data })
  }
  /** For tests: a run finishes — the outcome of a one-shot command */
  exitCommand(projectId: string, command: string, exitCode: number): void {
    const r = this.commandRuns.get(this.runKey(projectId, command))
    if (!r || !r.running) return
    r.running = false
    r.exitCode = exitCode
    for (const h of this.terminalsMock.termExitHandlers) h({ terminalId: r.runId, exitCode })
  }

  // The same contract as the real thing (#60): one last run per command, a re-run kills and replaces it, and the log lives as long as the run does
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
      // In the real thing, onExit comes after kill — the mock produces that outcome immediately (130 = the SIGINT convention)
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
