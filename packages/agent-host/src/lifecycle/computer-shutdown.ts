/**
 * Whether the computer shut down, restarted or logged out under the last host (#1397), read at the next start rather than
 * from each system's power-off signal (one per OS, and a host killed with the system may never see it).
 *
 * The host's last sign of life is the mail delivery's heartbeat (`MAIL_HEARTBEAT_KEY`): written every minute it runs and as
 * it stops. The boot time is the clock less the system's uptime. A boot after the last sign of life means the last host's
 * life ended before this boot, and no one stopped it on purpose (the stop mark, `markQuit`, is not there): the computer went
 * down under it. A session that ended between the two ended because of it.
 */

/**
 * How far before the last sign of life a session may have ended and still be the shutdown's. A host the system stops
 * writes its heartbeat as it stops, after its agents' processes went; one it kills has the last minute's beat at most.
 */
export const SHUTDOWN_GRACE_MS = 2 * 60_000

/** The span a session ended in when the computer shut down under it: from a little before the last sign of life to the boot */
export type ShutdownWindow = { from: number; to: number }

/** The moment the system booted, from the clock and the system's uptime in seconds (`os.uptime()`, read in main.ts) */
export const bootTimeOf = (now: number, uptimeSeconds: number): number => now - uptimeSeconds * 1000

/**
 * The span of the last host's end that a shutdown covers, or `null` when none did: no sign of life on record (a first
 * start), the person stopped Centralu (`stoppedOnPurpose`: a quit is not a shutdown, whenever the computer went down
 * after it), or the system booted before the host was last alive (it was running through the boot, so nothing went down)
 */
export function computerShutdownWindow(o: { lastAliveAt: number | null; bootAt: number; stoppedOnPurpose: boolean }): ShutdownWindow | null {
  if (o.lastAliveAt === null || o.stoppedOnPurpose || o.bootAt <= o.lastAliveAt) return null
  return { from: o.lastAliveAt - SHUTDOWN_GRACE_MS, to: o.bootAt }
}

export const endedInShutdown = (window: ShutdownWindow | null | undefined, at: number): boolean => !!window && at >= window.from && at < window.to

/** The `error.code` of a stored row that is an error event, or undefined */
function errorCodeOf(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null || !('type' in payload) || payload.type !== 'error') return undefined
  const error = 'error' in payload ? payload.error : undefined
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : ''
}

/**
 * Whether a session in `error` got there from an `adapter_crashed` stamped inside the span: the newest error among its last rows
 * (`rows`, oldest first), which the state says nothing since has replaced. A crash outside the span is a crash
 */
export function crashedInShutdown(s: { state: string }, rows: readonly { ts: number; payload: unknown }[], window: ShutdownWindow | null | undefined): boolean {
  if (s.state !== 'error' || !window) return false
  const last = rows.findLast((r) => errorCodeOf(r.payload) !== undefined)
  return !!last && errorCodeOf(last.payload) === 'adapter_crashed' && endedInShutdown(window, last.ts)
}
