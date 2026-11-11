import { errorMessage } from '@cc/protocol'
import { isObj } from '../json-value.js'
import type { OsFiles } from '../os/port.js'

/**
 * The terminals and Run commands an update's stop ends (#1902 part B, docs/agent-host/lifecycle/continue-after-update.md), kept in the update-resume list
 * beside the turns (`update-resume.ts`) so the next host brings them back. Recorded by the stopping host in its first step, before
 * the shells are killed (`stopPlan`); they are no session's, so there is no conversation mark: the list is the host's own and is
 * taken whole, once, by the first host that starts after it (`UpdateResumeLists.takeEnded`). Only what opening them again needs is
 * kept: nothing a shell printed, nothing a person typed.
 */
export type EndedTerminal = {
  /** The folder of the project the terminal is in: terminals are kept by folder */
  cwd: string
  /** The size of its screen when it was recorded */
  cols: number
  rows: number
}

/** A Run command that was running: its folder and the command (the definition) */
export type EndedRun = { cwd: string; command: string }

export type Ended = { terminals: EndedTerminal[]; runs: EndedRun[] }

/**
 * How long after the stop a list is still used. A start that follows an update is seconds to minutes after its stop; a list that
 * is older was left by a stop whose host never came (a rollback to a host from before this does not read it), and what it
 * names is not what anyone expects at a start days later
 */
export const ENDED_MAX_AGE_MS = 10 * 60_000

const MAX_ENTRIES = 100
const MAX_COMMAND = 4000

/** A string of at most `max` characters, else null: a longer one is not cut, since half a command is another command */
const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length <= max ? v : null)
const size = (v: unknown, fallback: number): number => (typeof v === 'number' && v >= 2 && v <= 1000 ? Math.floor(v) : fallback)

/** The entries of a list's text that this build can read whole; another shape is skipped, not guessed */
export function readEnded(o: unknown): Ended {
  const list = (key: 'terminals' | 'runs'): unknown[] => (isObj(o) && Array.isArray(o[key]) ? (o[key] as unknown[]).slice(0, MAX_ENTRIES) : [])
  const terminals: EndedTerminal[] = []
  for (const t of list('terminals')) {
    const cwd = isObj(t) ? text(t.cwd, 4096) : null
    if (isObj(t) && cwd) terminals.push({ cwd, cols: size(t.cols, 80), rows: size(t.rows, 24) })
  }
  const runs: EndedRun[] = []
  for (const r of list('runs')) {
    const cwd = isObj(r) ? text(r.cwd, 4096) : null
    const command = isObj(r) ? text(r.command, MAX_COMMAND) : null
    if (cwd && command) runs.push({ cwd, command })
  }
  return { terminals, runs }
}

/** The first line of a Run command's log when it starts again after an update (the owner chose a log line and no badge, #1902) */
export const RUN_RESTARTED_LINE = 'Started again after the update.'

/**
 * Brings back what an update's stop listed (#1902): each terminal as a fresh shell in its folder, each Run command that was running
 * started again. Nothing is typed into a shell and nothing that ran in a terminal runs again. One whose folder is no longer a
 * project's, or is gone from the disk, is skipped and said in the log; one that fails to open does not stop the rest.
 */
export function restartEnded(
  e: Ended,
  host: {
    /** The folders of the projects that exist now */
    projectFolders: ReadonlySet<string>
    terminals: { create(cwd: string, cols: number, rows: number): unknown }
    runs: { run(cwd: string, command: string, cols: number, rows: number, before: string): unknown }
    log(line: string): void
  },
  /** Where the folders are looked for */
  os: { files: Pick<OsFiles, 'existsSync'> },
): void {
  const there = (cwd: string) => host.projectFolders.has(cwd) && os.files.existsSync(cwd)
  for (const t of e.terminals) {
    if (!there(t.cwd)) {
      host.log(`[agent-host] a terminal an update ended is not reopened: its folder is no project's or is gone (${t.cwd})`)
      continue
    }
    try {
      host.terminals.create(t.cwd, t.cols, t.rows)
    } catch (err) {
      host.log(`[agent-host] a terminal an update ended could not be reopened: ${errorMessage(err)}`)
    }
  }
  for (const r of e.runs) {
    if (!there(r.cwd)) {
      host.log(`[agent-host] a command an update ended is not started again: its folder is no project's or is gone (${r.cwd})`)
      continue
    }
    try {
      // The size is measured again once a window attaches to the log, as for any run
      host.runs.run(r.cwd, r.command, 100, 30, `${RUN_RESTARTED_LINE}\r\n`)
    } catch (err) {
      host.log(`[agent-host] a command an update ended could not be started again: ${errorMessage(err)}`)
    }
  }
}
