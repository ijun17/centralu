/**
 * Joins a command's stored log and its live output into one stream for a log view. The view subscribes to live output
 * first and reads the log second; live chunks and the exit line (#1143 U18) are held until the log answers, so nothing
 * falls between or shows twice. A failed read ends the hold and leaves a dim line, so mid-run output is not taken for all.
 */
export type LogReplay = {
  /** A live chunk of this run's output */
  chunk(data: string): void
  /** The run ended (its live exit event): drawn after the output so far, once */
  exit(code: number | null): void
  /** The stored log arrived: draw it, then what was held; `exitCode` (a run that had ended) unless already drawn */
  replay(history: string, exitCode?: number | null): void
  /** The stored log cannot be read: say so, draw what was held and carry on live */
  fail(): void
  /** The log belongs to another run (this view is about to be replaced): nothing held is drawn */
  drop(): void
}

/** Where the stored log would be when it could not be read, dim like the exit line */
export const UNREAD_LOG_LINE = '\x1b[2m— earlier output could not be read —\x1b[0m\r\n'

/** The dim line that ends a run's output, with the exit code in brackets when there is one */
export function exitLine(code: number | null): string {
  return `\r\n\x1b[2m— exited${code !== null ? ` (${code})` : ''} —\x1b[0m\r\n`
}

export function logReplay(write: (data: string) => void): LogReplay {
  let held: string[] | null = []
  let exited = false
  const drawExit = (code: number | null) => {
    if (exited) return
    exited = true
    if (held) held.push(exitLine(code))
    else write(exitLine(code))
  }
  const release = (history: string | null, draw: boolean) => {
    const chunks = held
    held = null
    if (!chunks || !draw) return
    write(history ?? UNREAD_LOG_LINE)
    for (const chunk of chunks) write(chunk)
  }
  return {
    chunk(data) {
      if (held) held.push(data)
      else write(data)
    },
    exit: drawExit,
    replay(history, exitCode = null) {
      release(history, true)
      if (exitCode !== null) drawExit(exitCode)
    },
    fail: () => release(null, true),
    drop: () => release(null, false),
  }
}
