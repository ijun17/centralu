import type {
  TerminalInfo,
  CommandRunInfo,
} from '@cc/protocol/client'
import type { Unsubscribe } from './common.js'

/**
 * Project terminal.
 *
 * **Its identity is the cwd** — not the session. The same terminals carry over even when the
 * session changes within the same project, and a git worktree session automatically gets its
 * own terminal because its cwd is different.
 */
export interface TerminalPort {
  /** That project's terminal list (the screen is restored from history) */
  list(projectId: string): Promise<TerminalInfo[]>
  /** Opens one more terminal */
  create(projectId: string, cols: number, rows: number): Promise<TerminalInfo>
  /** Closes one terminal */
  close(terminalId: string): Promise<void>
  input(terminalId: string, data: string): Promise<void>
  resize(terminalId: string, cols: number, rows: number): Promise<void>
  /** Restarts it when the shell hangs (the record stays) */
  restart(terminalId: string, cols: number, rows: number): Promise<TerminalInfo>
  onOutput(handler: (e: { terminalId: string; data: string }) => void): Unsubscribe
  onExit(handler: (e: { terminalId: string; exitCode: number | null }) => void): Unsubscribe
}

/**
 * Runner for frequently used commands (#60). A separate execution path from terminal tabs —
 * one process per command, one last-run log (for the lifetime of the host).
 * The output stream rides on terminal.onOutput/onExit as is (runId takes the place of
 * terminalId).
 */
export interface CommandRunPort {
  /** Runs it. If the same command is already running, kills it and starts fresh */
  run(projectId: string, command: string, cols: number, rows: number): Promise<CommandRunInfo>
  /** Stops the dev server. The log stays */
  stop(projectId: string, command: string): Promise<void>
  /** The status of commands that have run before (for the list badges) */
  state(projectId: string): Promise<CommandRunInfo[]>
  /** The last run, log included. Null if it has never run */
  log(projectId: string, command: string): Promise<(CommandRunInfo & { history: string }) | null>
  resize(projectId: string, command: string, cols: number, rows: number): Promise<void>
}
