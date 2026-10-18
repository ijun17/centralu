import { deliver } from '../deliver.js'
import type { TerminalPort } from '../ports/index.js'
import type { MockClock } from './clock.js'
import type { ProjectStore } from './project-store.js'
import { mockError } from './mock-error.js'

/** The mock terminal, behind the `terminal` port */
export class TerminalsMock {
  /**
   * The mock terminal. Does not spawn a real shell — it fakes only **the property of being
   * bound to a cwd**, since what is being verified is "does the same terminal carry over when
   * the session changes," not the shell itself.
   */
  terminalState: {
    byCwd: Map<string, { id: string; title: string; history: string; alive: boolean }[]>
    input: { terminalId: string; data: string }[]
    resized: { terminalId: string; cols: number; rows: number }[]
    closed: string[]
  } = { byCwd: new Map(), input: [], resized: [], closed: [] }
  termHandlers = new Set<(e: { terminalId: string; data: string }) => void>()
  termExitHandlers = new Set<(e: { terminalId: string; exitCode: number | null }) => void>()

  /** For tests: makes a terminal produce some output */
  emitTerminal(terminalId: string, data: string): void {
    for (const [, list] of this.terminalState.byCwd) {
      for (const t of list) if (t.id === terminalId) t.history += data
    }
    deliver(this.termHandlers, { terminalId, data })
  }

  /** For tests: the shell has died — an exit that is not a command run (runId) rides the same lane */
  emitTerminalExit(terminalId: string, exitCode: number | null): void {
    for (const [, list] of this.terminalState.byCwd) {
      for (const t of list) if (t.id === terminalId) t.alive = false
    }
    deliver(this.termExitHandlers, { terminalId, exitCode })
  }

  private cwdOf(projectId: string): string {
    return this.projectStore.list.find((p) => p.id === projectId)?.path ?? projectId
  }

  readonly terminal: TerminalPort = {
    list: async (projectId: string) => {
      const cwd = this.cwdOf(projectId)
      return (this.terminalState.byCwd.get(cwd) ?? []).map((t) => ({
        terminalId: t.id,
        cwd,
        title: t.title,
        history: t.history,
        alive: t.alive,
      }))
    },
    create: async (projectId: string) => {
      const cwd = this.cwdOf(projectId)
      const list = this.terminalState.byCwd.get(cwd) ?? []
      const t = {
        id: `mock-term-${this.clock.next()}`,
        title: `Terminal ${list.length + 1}`,
        history: '',
        alive: true,
      }
      list.push(t)
      this.terminalState.byCwd.set(cwd, list)
      return { terminalId: t.id, cwd, title: t.title, history: t.history, alive: true }
    },
    close: async (terminalId: string) => {
      this.terminalState.closed.push(terminalId)
      for (const [cwd, list] of this.terminalState.byCwd) {
        const next = list.filter((t) => t.id !== terminalId)
        if (next.length === list.length) continue
        next.forEach((t, i) => (t.title = `Terminal ${i + 1}`))
        if (next.length === 0) this.terminalState.byCwd.delete(cwd)
        else this.terminalState.byCwd.set(cwd, next)
      }
    },
    input: async (terminalId: string, data: string) => {
      this.terminalState.input.push({ terminalId, data })
    },
    resize: async (terminalId: string, cols: number, rows: number) => {
      this.terminalState.resized.push({ terminalId, cols, rows })
    },
    restart: async (terminalId: string) => {
      for (const [cwd, list] of this.terminalState.byCwd) {
        for (const t of list) {
          if (t.id !== terminalId) continue
          t.alive = true
          return { terminalId: t.id, cwd, title: t.title, history: t.history, alive: true }
        }
      }
      throw mockError('Terminal not found')
    },
    onOutput: (h: (e: { terminalId: string; data: string }) => void) => {
      this.termHandlers.add(h)
      return () => this.termHandlers.delete(h)
    },
    onExit: (h: (e: { terminalId: string; exitCode: number | null }) => void) => {
      this.termExitHandlers.add(h)
      return () => this.termExitHandlers.delete(h)
    },
  }

  constructor(
    private readonly clock: MockClock,
    private readonly projectStore: ProjectStore,
  ) {}
}
