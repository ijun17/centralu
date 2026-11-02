import { errorMessage } from '@cc/protocol'
import { isObj } from '../json-value.js'

/**
 * The terminals and Run commands an update's stop ends (#1902 part B, docs/agent-host.md §4.8), kept in the update-resume list
 * beside the turns (`update-resume.ts`) so the next host brings them back. Recorded by the stopping host in its first step, before
 * the shells are killed (`stopPlan`); they are no session's, so there is no conversation mark: the list is the host's own and is
 * taken whole, once, by the first host that starts after it. Only what opening them again needs is kept: nothing a shell printed,
 * nothing a person typed.
 */
export type EndedTerminal = {
  /** The project the terminal belongs to, when its folder is one; the screen asks for terminals by project */
  projectId: string | null
  cwd: string
  /** The size of its screen when it was recorded */
  cols: number
  rows: number
}

/** A Run command that was running: the project, its folder and the command (the definition) */
export type EndedRun = { projectId: string | null; cwd: string; command: string }

export type Ended = { terminals: EndedTerminal[]; runs: EndedRun[] }

const MAX_ENTRIES = 100
const MAX_LINE = 1000

const text = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.slice(0, max) : null)
const size = (v: unknown, fallback: number): number => (typeof v === 'number' && v >= 2 && v <= 1000 ? Math.floor(v) : fallback)

/** A terminal as a list holds it, or null when it is not one this build can read */
function readTerminal(o: unknown): EndedTerminal | null {
  if (!isObj(o)) return null
  const cwd = text(o.cwd, 4096)
  return cwd ? { projectId: text(o.projectId, 200), cwd, cols: size(o.cols, 80), rows: size(o.rows, 24) } : null
}

/** A run as a list holds it, or null when it is not one this build can read */
function readRun(o: unknown): EndedRun | null {
  if (!isObj(o)) return null
  const cwd = text(o.cwd, 4096)
  const command = text(o.command, MAX_LINE)
  return cwd && command ? { projectId: text(o.projectId, 200), cwd, command } : null
}

export function readEnded(o: unknown): Ended {
  const list = (key: 'terminals' | 'runs'): unknown[] => (isObj(o) && Array.isArray(o[key]) ? (o[key] as unknown[]).slice(0, MAX_ENTRIES) : [])
  return {
    terminals: list('terminals').map(readTerminal).filter((t): t is EndedTerminal => t !== null),
    runs: list('runs').map(readRun).filter((r): r is EndedRun => r !== null),
  }
}

/** What fits in a list */
export const clipEnded = (e: Ended): Ended => ({ terminals: e.terminals.slice(0, MAX_ENTRIES), runs: e.runs.slice(0, MAX_ENTRIES) })

/** The first line of a Run command's log when it starts again after an update (the owner chose a log line and no badge, #1902) */
export const RUN_RESTARTED_LINE = 'Started again after the update.'

/**
 * Brings back what an update's stop listed (#1902): each terminal as a fresh shell in its folder, each Run command that was running
 * started again. Nothing is typed into a shell and nothing that ran in a terminal runs again. One whose project or folder is gone is
 * skipped and said in the log; one that fails to open does not stop the rest.
 */
export function restartEnded(
  e: Ended,
  host: {
    /** The folder of a project that still exists with that folder on disk, else null */
    cwdOf(projectId: string | null, cwd: string): string | null
    terminals: { create(cwd: string, cols: number, rows: number): unknown }
    runs: { run(cwd: string, command: string, cols: number, rows: number, before: string): unknown }
    log(line: string): void
  },
): void {
  for (const t of e.terminals) {
    const cwd = host.cwdOf(t.projectId, t.cwd)
    if (!cwd) {
      host.log(`[agent-host] a terminal an update ended is not reopened: its folder or project is gone (${t.cwd})`)
      continue
    }
    try {
      host.terminals.create(cwd, t.cols, t.rows)
    } catch (err) {
      host.log(`[agent-host] a terminal an update ended could not be reopened: ${errorMessage(err)}`)
    }
  }
  for (const r of e.runs) {
    const cwd = host.cwdOf(r.projectId, r.cwd)
    if (!cwd) {
      host.log(`[agent-host] a command an update ended is not started again: its folder or project is gone (${r.cwd})`)
      continue
    }
    try {
      host.runs.run(cwd, r.command, 100, 30, `${RUN_RESTARTED_LINE}\r\n`)
    } catch (err) {
      host.log(`[agent-host] a command an update ended could not be started again: ${errorMessage(err)}`)
    }
  }
}
