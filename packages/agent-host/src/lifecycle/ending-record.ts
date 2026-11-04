import { systemStoppingQueries } from '../os.js'
import type { OsProcesses } from '../os/port.js'
import { realOs } from '../os/real.js'

/**
 * Why the last host ended, written by that host as it went and read by the next start (#1397). The cause is recorded at the moment,
 * not guessed afterwards: a boot time against a last-alive time cannot tell a quit from a shutdown, and Windows' uptime does not even
 * restart at a Fast Startup shutdown. Chrome does the same with its profile's exit type (`Normal`, `SessionEnded`, `Crashed`).
 *
 * Every way a host leaves on purpose writes what stopped it (a quit, a stop, an update's stop, a swap, its parent going, a signal, a
 * crash it caught), in every mode. A notice that the system is ending (shutdown, restart, sign-out) writes `system` with its time. A
 * host killed with no notice writes nothing, and the start before it removed the last record: the next start then knows nothing, and
 * a turn it finds cut stays a quit and a crash an error, as before. Only a recorded `system` makes a cut turn a `shutdown`.
 *
 * In the data folder beside `stopped.json`, which is the person's stop for a linked hub and is left as it was: both are read and
 * written in stopped-mark.ts (`writeEndingRecord`, `takeEndingRecord`).
 */
export const ENDING_FILE = 'ended.json'

/**
 * Why a host left on purpose. `quit`: the keeper stopped it for good. `stop`: `host.stop` (`centralu serve --stop`, a hub) or the
 * window's stop line. `update`: either of those for an update. `swap`: the keeper's drain. `parent`: its parent's pipe closed (in
 * direct mode the window quitting, or the window gone). `signal`: SIGINT, SIGTERM or SIGHUP. `crash`: an uncaught exception
 */
export type LeaveCause = 'quit' | 'stop' | 'update' | 'swap' | 'parent' | 'signal' | 'crash'

/** What the file holds. `system`: the system said it was ending, at `systemAt`, before or as the host left */
export type EndingRecord = { v: 1; by: LeaveCause | 'system'; at: number; systemAt?: number; detail?: string }

/** The system's end the last host recorded: when it was told */
export type SystemEnd = { at: number }

const CAUSES = ['quit', 'stop', 'update', 'swap', 'parent', 'signal', 'crash', 'system'] as const
const isCause = (x: unknown): x is EndingRecord['by'] => typeof x === 'string' && (CAUSES as readonly string[]).includes(x)

/**
 * One host's record, kept as it learns why it is leaving. The first cause stands. A notice that the system is ending makes it
 * `system`, whatever cause came before or after: a stop asked for as the system ends (the keeper stopping its host as it gets the
 * system's SIGTERM, a Mac quitting its apps as it shuts down) is the system's too. A notice the host outlives by
 * `SYSTEM_END_TAIL_MS` was no end: the system did not go. `close` is called when the host lets go of the data folder (a swap's
 * successor owns it from then on).
 */
export class EndingRecorder {
  private cause: { by: LeaveCause; at: number; detail?: string } | null = null
  private systemAt: number | null = null
  private closed = false

  /** `write(null)`: there is nothing to say (an end called off before any leave), so no record is left */
  constructor(
    private readonly o: {
      write: (r: EndingRecord | null) => void
      now?: () => number
      /** Runs `f` after `ms`, without holding the process open */
      setTimer?: (f: () => void, ms: number) => void
      /** The host outlived a notice: it is called off (`systemEndingCancelled`), and this says so */
      outlived?: () => void
    },
  ) {}

  private now(): number {
    return (this.o.now ?? Date.now)()
  }

  /** A way this host is leaving. Only the first counts: the leave it starts is the one that runs (shutdown.ts) */
  leaving(by: LeaveCause, detail?: string): void {
    if (this.cause) return
    this.cause = { by, at: this.now(), ...(detail ? { detail } : {}) }
    this.flush()
  }

  /** The system said it is ending (a shutdown, restart or sign-out), told at `at` */
  systemEnding(at: number = this.now()): void {
    if (this.systemAt !== null) return
    this.systemAt = at
    this.flush()
    const setTimer = this.o.setTimer ?? ((f, ms) => void setTimeout(f, ms).unref())
    setTimer(() => {
      if (this.systemAt !== at) return
      this.o.outlived?.()
      this.systemEndingCancelled()
    }, SYSTEM_END_TAIL_MS)
  }

  /** The system's end was called off (Windows: another app refused it) */
  systemEndingCancelled(): void {
    if (this.systemAt === null) return
    this.systemAt = null
    this.flush()
  }

  /** The data folder is no longer this host's to write in */
  close(): void {
    this.closed = true
  }

  /** What the file says now; `null` while there is nothing to say */
  record(): EndingRecord | null {
    if (this.systemAt !== null) {
      return { v: 1, by: 'system', at: this.cause?.at ?? this.systemAt, systemAt: this.systemAt, ...(this.cause ? { detail: this.cause.by } : {}) }
    }
    if (!this.cause) return null
    return { v: 1, by: this.cause.by, at: this.cause.at, ...(this.cause.detail ? { detail: this.cause.detail } : {}) }
  }

  private flush(): void {
    if (!this.closed) this.o.write(this.record())
  }
}

export function parseEndingRecord(text: string): EndingRecord | null {
  let r: unknown
  try {
    r = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof r !== 'object' || r === null) return null
  const v: unknown = 'v' in r ? r.v : undefined
  const by: unknown = 'by' in r ? r.by : undefined
  const at: unknown = 'at' in r ? r.at : undefined
  const systemAt: unknown = 'systemAt' in r ? r.systemAt : undefined
  const detail: unknown = 'detail' in r ? r.detail : undefined
  if (v !== 1 || !isCause(by) || typeof at !== 'number') return null
  if (by === 'system' && typeof systemAt !== 'number') return null
  return { v: 1, by, at, ...(typeof systemAt === 'number' ? { systemAt } : {}), ...(typeof detail === 'string' ? { detail } : {}) }
}

/** The system's end the record says the last host went in, or `null` when it went for any other reason, or none is known */
export const systemEndOf = (r: EndingRecord | null): SystemEnd | null => (r?.by === 'system' && r.systemAt !== undefined ? { at: r.systemAt } : null)

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

/**
 * Whether the system says it is ending now (a shutdown, restart or sign-out), where it can say so (`systemStoppingQueries`: Linux's
 * systemd, the manager or the user's manager `stopping`; systemctl(1), is-system-running). Elsewhere, and when it does not answer
 * within `timeoutMs`, false: a signal alone does not say who sent it (the keeper's restart is one too).
 */
export function systemIsStopping(
  o: { queries?: readonly (readonly string[])[] | null; run?: OsProcesses['run']; timeoutMs?: number } = {},
): Promise<boolean> {
  const queries = o.queries === undefined ? systemStoppingQueries() : o.queries
  if (!queries || queries.length === 0) return Promise.resolve(false)
  const timeoutMs = o.timeoutMs ?? 1000
  const run: OsProcesses['run'] = o.run ?? ((command, args, options) => realOs().processes.run(command, args, options))
  // `is-system-running` exits non-zero for every state but `running`, with the word on stdout all the same
  const one = ([command, ...args]: readonly string[]) =>
    command === undefined
      ? Promise.resolve(false)
      : Promise.race([
          run(command, args, { timeoutMs }).then((r) => String(r.stdout).trim() === 'stopping', () => false),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs).unref()),
        ])
  return Promise.all(queries.map(one)).then((answers) => answers.some(Boolean))
}
