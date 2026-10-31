/** What a window tells the host when its screen crashed (`ui.reportCrash`): one capped line on stderr, and no more than a few a minute */

const MESSAGE_MAX = 500
const STACK_MAX = 3000
const COMPONENT_STACK_MAX = 3000
export const CRASH_LINES_PER_WINDOW = 5
export const CRASH_WINDOW_MS = 60_000

export type UiCrash = { message: string; stack: string; componentStack: string; version?: string }

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…(+${s.length - max})` : s)

/** JSON leaves U+2028, U+2029 and U+0085 as they are, and a viewer may break the line there: a fake log line */
const LINE_BREAKS = new RegExp(`[${String.fromCharCode(0x85, 0x2028, 0x2029)}]`, 'g')
const oneLine = (json: string) => json.replace(LINE_BREAKS, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)

/**
 * The line is JSON after a fixed prefix, so the stack's own newlines stay on the one line. A crash that repeats (a
 * render loop that remounts the error screen) must not flood the log: past the cap the lines are counted, and the next
 * line after the window says how many were left out.
 */
export function createUiCrashLog(write: (line: string) => void, now: () => number = Date.now): (c: UiCrash) => void {
  let windowStart = 0
  let written = 0
  let dropped = 0
  return (c) => {
    const t = now()
    if (written === 0 || t - windowStart >= CRASH_WINDOW_MS) {
      windowStart = t
      written = 0
    }
    if (written >= CRASH_LINES_PER_WINDOW) {
      dropped++
      return
    }
    written++
    const skipped = dropped
    dropped = 0
    write(
      `[ui-crash] ${oneLine(JSON.stringify({
        message: cut(c.message, MESSAGE_MAX),
        stack: cut(c.stack, STACK_MAX),
        componentStack: cut(c.componentStack, COMPONENT_STACK_MAX),
        ...(c.version ? { version: c.version } : {}),
        ...(skipped > 0 ? { skipped } : {}),
      }))}`,
    )
  }
}
