import { PROTOCOL_VERSION, type HostBuild, type SessionInfo, type SessionState } from '@cc/protocol'

/**
 * What the host tells the keeper, and what it says about its own build (#280, option C step 1).
 *
 * The keeper is the Centralu executable run as `centralu --keeper`. It launches this host from a
 * per-build copy under the data folder and passes the record of where that copy came from in
 * `CC_HOST_SOURCE`. The host does not parse the keeper's protocol and the keeper does not parse
 * the host's; the only things that cross are this record (in) and one activity line (out).
 */

/**
 * Which build this host is: the commit compiled in, plus where the keeper copied it from.
 *
 * The commit is the host's own (`__CC_BUILD__`), never the keeper's word for it, so a record
 * that does not match the code can only add a bundle path, not change the identity. Anything
 * unreadable in the record is dropped rather than failing the start: the record is for showing
 * a person which build is running, and a host that refused to start over it would show nothing.
 */
export function hostBuild(commit: string, sourceJson: string | undefined): HostBuild {
  const build: HostBuild = { commit, protocolVersion: PROTOCOL_VERSION }
  if (!sourceJson) return build
  let source: unknown
  try {
    source = JSON.parse(sourceJson)
  } catch {
    return build
  }
  if (typeof source !== 'object' || source === null) return build
  const text = (k: string) => {
    const v = (source as Record<string, unknown>)[k]
    return typeof v === 'string' && v.length > 0 && v.length <= 4096 ? v : undefined
  }
  const version = text('version')
  const bundlePath = text('bundlePath')
  const copyDir = text('copyDir')
  return { ...build, ...(version ? { version } : {}), ...(bundlePath ? { bundlePath } : {}), ...(copyDir ? { copyDir } : {}) }
}

/** The states in which someone would lose something if the host went away */
const BUSY_STATES: ReadonlySet<SessionState> = new Set(['working', 'waiting_approval', 'waiting_input'])

export type ActivitySnapshot = {
  sessions: Pick<SessionInfo, 'state' | 'live'>[]
  terminals: number
  commandRuns: number
}

/**
 * Whether the host is doing anything a person would lose if it stopped now.
 *
 * - a live session that is working, waiting for an approval, or waiting on a question — an
 *   approval left in background mode is exactly what a person comes back for;
 * - an open terminal or a running project command (a dev server).
 *
 * External app processes do not count: they start on demand and are restarted with the host
 * (#280, decision 2).
 */
export function hostBusy(s: ActivitySnapshot): boolean {
  return s.terminals > 0 || s.commandRuns > 0 || s.sessions.some((x) => x.live === true && BUSY_STATES.has(x.state))
}

/** How often the host looks. The keeper's idle limit is 30 minutes, so seconds of lag cost nothing */
export const ACTIVITY_POLL_MS = 5_000

/**
 * Reports `{"activity":{"busy":…}}` once at start and again whenever it changes, for the keeper's
 * idle rule (an unwatched keeper in background mode ends itself only after no window and no
 * activity for its idle limit).
 *
 * Polled rather than wired into every state change: the answer is three counts, the keeper only
 * needs it to the nearest few seconds, and a hook in each service would be three more places to
 * forget when a fourth kind of long-lived work appears.
 * @returns stops the report
 */
export function startActivityReport(
  snapshot: () => ActivitySnapshot,
  write: (line: string) => void,
  intervalMs = ACTIVITY_POLL_MS,
): () => void {
  let last: boolean | null = null
  const tick = () => {
    let busy: boolean
    try {
      busy = hostBusy(snapshot())
    } catch {
      return
    }
    if (busy === last) return
    last = busy
    write(JSON.stringify({ activity: { busy } }))
  }
  tick()
  const timer = setInterval(tick, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}
