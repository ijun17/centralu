import type {
  TerminalInfo,
  CommandRunInfo,
} from '@cc/protocol/client'
import type { Unsubscribe } from './common.js'

/** Keyed by cwd, not session: terminals carry across sessions of a project, and a worktree session gets its own */
export interface TerminalPort {
  /** Restored from history */
  list(projectId: string): Promise<TerminalInfo[]>
  create(projectId: string, cols: number, rows: number): Promise<TerminalInfo>
  close(terminalId: string): Promise<void>
  input(terminalId: string, data: string): Promise<void>
  resize(terminalId: string, cols: number, rows: number): Promise<void>
  /** For a hung shell; the record stays */
  restart(terminalId: string, cols: number, rows: number): Promise<TerminalInfo>
  onOutput(handler: (e: { terminalId: string; data: string }) => void): Unsubscribe
  onExit(handler: (e: { terminalId: string; exitCode: number | null }) => void): Unsubscribe
}

/**
 * Saved commands (#60), apart from terminal tabs: one process and one last-run log per command, for the host's
 * lifetime. Output rides on `TerminalPort.onOutput`/`onExit`, `runId` as `terminalId`.
 */
export interface CommandRunPort {
  /** Kills a running copy of the same command and starts fresh */
  run(projectId: string, command: string, cols: number, rows: number): Promise<CommandRunInfo>
  /** The log stays */
  stop(projectId: string, command: string): Promise<void>
  /** For the list badges */
  state(projectId: string): Promise<CommandRunInfo[]>
  /** Null if it never ran */
  log(projectId: string, command: string): Promise<(CommandRunInfo & { history: string }) | null>
  resize(projectId: string, command: string, cols: number, rows: number): Promise<void>
}
