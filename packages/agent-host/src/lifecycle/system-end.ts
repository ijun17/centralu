import { systemStoppingQueries } from '../os.js'
import { realOs } from '../os/real.js'

/**
 * That the system was ending (a shutdown, restart or sign-out) as the last host went, written by that host when it was told and read
 * by the next start (#1397). Told, not guessed: a boot time against a last-alive time cannot tell a quit from a shutdown, and Windows'
 * uptime does not even restart at a Fast Startup shutdown. Chrome keeps its profile's exit type the same way (`SessionEnded`).
 *
 * Written on a notice (the `system-ending` control line from the window or the keeper, or systemd answering `stopping` as the host
 * leaves, `askSystemStopping`), removed when the notice is called off or the host outlives it. Nothing else is recorded: any other
 * ending, a host killed with no notice included, leaves no file (the start before removed the last), and the next start finds a cut
 * turn a quit and a crash an error, as before. In the data folder beside `stopped.json`, which keeps its meaning for a hub; both are
 * read and written in stopped-mark.ts (`writeSystemEnd`, `takeSystemEnd`).
 */
export const SYSTEM_END_FILE = 'system-end.json'

/** When the last host was told the system was ending */
export type SystemEnd = { at: number }

/**
 * This host's notice, kept in the file. A notice it outlives by `SYSTEM_END_TAIL_MS` was no end (the system did not go), so a host
 * that runs on leaves none behind. `close`: the host let go of the data folder (a swap's successor owns it from then on)
 */
export class SystemEndNotice {
  private at: number | null = null
  /** Which notice an expiry belongs to: a later one is not called off by an earlier one's timer */
  private notices = 0
  private closed = false

  constructor(
    private readonly o: {
      write: (end: SystemEnd | null) => void
      now?: () => number
      /** Runs `f` after `ms`, without holding the process open */
      setTimer?: (f: () => void, ms: number) => void
      /** The host outlived a notice, which is called off */
      outlived?: () => void
    },
  ) {}

  /** The system said it is ending, at `at` */
  notice(at: number = (this.o.now ?? Date.now)()): void {
    if (this.at !== null) return
    this.at = at
    const n = ++this.notices
    this.flush()
    const setTimer = this.o.setTimer ?? ((f, ms) => void setTimeout(f, ms).unref())
    setTimer(() => {
      if (this.notices !== n || this.at === null) return
      this.o.outlived?.()
      this.cancel()
    }, SYSTEM_END_TAIL_MS)
  }

  /** The end was called off (Windows: another app refused it) */
  cancel(): void {
    if (this.at === null) return
    this.at = null
    this.flush()
  }

  close(): void {
    this.closed = true
  }

  private flush(): void {
    if (!this.closed) this.o.write(this.at === null ? null : { at: this.at })
  }
}

/** The file's text as written (`{"v":1,"at":…}`), or `null` for text that is not that (a host killed while it wrote, another version) */
export function parseSystemEnd(text: string): SystemEnd | null {
  let r: unknown
  try {
    r = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof r !== 'object' || r === null || !('v' in r) || r.v !== 1 || !('at' in r) || typeof r.at !== 'number') return null
  return { at: r.at }
}

export const systemEndText = (end: SystemEnd): string => `${JSON.stringify({ v: 1, at: end.at })}\n`

/**
 * How long before the notice an agent's exit is still the system's. Where the system ends every process at once (Linux's SIGTERM to
 * the whole session) the agent may exit, and the host write it, before the host's own signal is read
 */
export const SYSTEM_END_LEAD_MS = 30_000
/**
 * How long after the notice a host ended by it may still write. Bounded: the host's leave exits within `SHUTDOWN_BOUND_MS`, but a
 * Windows notice comes at the question, before the end, which a person may hold open on the "apps are preventing shutdown" screen.
 * A session with a row later than this was in a later host's life, such as one of an older build that does not read this file
 */
export const SYSTEM_END_TAIL_MS = 2 * 60_000

/** Whether something stamped `ts` happened in the system's end */
export const inSystemEnd = (end: SystemEnd | null | undefined, ts: number): boolean =>
  !!end && ts >= end.at - SYSTEM_END_LEAD_MS && ts <= end.at + SYSTEM_END_TAIL_MS

/**
 * Whether a turn the last host lost (a session left `working`) is the system's end's: its last row (`lastTs`) is no later than that
 * end. However long the turn ran before it, it was running when the system ended
 */
export const cutBySystemEnd = (end: SystemEnd | null | undefined, lastTs: number | undefined): boolean =>
  !!end && (lastTs === undefined || lastTs <= end.at + SYSTEM_END_TAIL_MS)

/** The `error.code` of a stored row that is an error event, or undefined for any other row */
function errorCodeOf(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null || !('type' in payload) || payload.type !== 'error') return undefined
  const error = 'error' in payload ? payload.error : undefined
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : ''
}

/**
 * Whether a session in `error` got there by its agent's exit in the system's end: the newest error among its last rows (`rows`,
 * oldest first) is an `adapter_crashed` stamped in it. An `internal` error after it is skipped: closing the handle says so for the
 * follow-ups still queued (`undeliveredError`, adapters/session-kit.ts), which is the crash's consequence, not a new failure
 */
export function crashedInSystemEnd(s: { state: string }, rows: readonly { ts: number; payload: unknown }[], end: SystemEnd | null | undefined): boolean {
  if (s.state !== 'error' || !end) return false
  const last = rows.findLast((r) => {
    const code = errorCodeOf(r.payload)
    return code !== undefined && code !== 'internal'
  })
  return !!last && errorCodeOf(last.payload) === 'adapter_crashed' && inSystemEnd(end, last.ts)
}

/** A query's process, as far as the question needs it: to end it */
type Query = { kill(signal?: NodeJS.Signals): boolean }
/** How a query runs (`OsProcesses.run`, which tests stand in for) */
type RunQuery = (command: string, args: readonly string[], options: { timeoutMs: number; onChild: (child: Query) => void }) => Promise<{ stdout: Buffer }>

/**
 * Asks whether the system says it is ending now, where it can say so (`systemStoppingQueries`: Linux's systemd, the manager or the
 * user's manager `stopping`; systemctl(1), is-system-running). `stopping` answers true as soon as one query says so, and false once
 * all said otherwise, or after `timeoutMs`; it is `null` where there is no question to ask. `end` ends the queries
 * still running: called as soon as it is answered, and by the host as it exits, whichever way it exits.
 */
export function askSystemStopping(
  o: { queries?: readonly (readonly string[])[] | null; run?: RunQuery; timeoutMs?: number } = {},
): { stopping: Promise<boolean> | null; end: () => void } {
  const queries = (o.queries === undefined ? systemStoppingQueries() : o.queries) ?? []
  const children = new Set<Query>()
  const end = () => {
    for (const child of children) child.kill('SIGKILL')
    children.clear()
  }
  if (queries.length === 0) return { stopping: null, end }
  const timeoutMs = o.timeoutMs ?? 1000
  const run: RunQuery = o.run ?? ((command, args, options) => realOs().processes.run(command, args, options))
  const stopping = new Promise<boolean>((resolve) => {
    let left = queries.length
    const answered = (yes: boolean) => {
      if (yes) resolve(true)
      else if (--left === 0) resolve(false)
    }
    for (const [command, ...args] of queries) {
      if (command === undefined) {
        answered(false)
        continue
      }
      // `is-system-running` exits non-zero for every state but `running`, with the word on stdout all the same
      run(command, args, { timeoutMs, onChild: (child) => void children.add(child) }).then(
        (r) => answered(String(r.stdout).trim() === 'stopping'),
        () => answered(false),
      )
    }
    setTimeout(() => resolve(false), timeoutMs).unref()
  })
  void stopping.then(end)
  return { stopping, end }
}
