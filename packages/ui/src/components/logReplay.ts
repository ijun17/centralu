/**
 * Joins a command's stored log and its live output into one stream for a log view.
 *
 * The view subscribes to live output first and reads the stored log second, so nothing falls
 * between the two; live chunks that arrive before the stored log are held until it lands. The hold
 * must end on **every** answer, not only a good one. While it ended only on success, a read that
 * failed (a timeout, the connection dropping mid-reconnect) or answered for another run left every
 * later chunk of a running dev server held in memory for as long as the panel stayed open, and the
 * pane stayed blank.
 *
 * A failed read is said on screen: a dim line stands where the stored log would be, so output that
 * starts mid-run is not mistaken for the whole log.
 *
 * The exit line is part of the output and takes the same hold: a run that ends before the stored log answers (a
 * typo'd script, a slow linked machine) used to have its live exit line drawn first, above the log it ends, and then
 * again once the log said the run had ended (#1143 U18). It is drawn once, after everything it ends.
 */
export type LogReplay = {
  /** A live chunk of this run's output */
  chunk(data: string): void
  /** The run ended (its live exit event): drawn after the output so far, once */
  exit(code: number | null): void
  /**
   * The stored log arrived: draw it, then what was held. `exitCode` is the stored run's, when it had already ended
   * with one: its exit line is drawn unless the live event already drew it
   */
  replay(history: string, exitCode?: number | null): void
  /** The stored log cannot be read: say so, draw what was held and carry on live */
  fail(): void
  /** The log belongs to another run (this view is about to be replaced): nothing held is drawn */
  drop(): void
}

/** Where the stored log would be when it could not be read — dim, like the exit line */
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
