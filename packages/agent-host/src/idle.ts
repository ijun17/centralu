import type { SessionInfo, SessionState } from '@cc/protocol'

/**
 * The one rule for "is anything running that a person would lose" (#280, #352).
 *
 * Every decision that must wait for a quiet moment reads this rule and no other, so they cannot
 * drift apart:
 *   - the keeper's idle exit in background mode (through the activity report, keeper-link.ts);
 *   - whether switching builds asks first (the keeper passes the same report to the window);
 *   - applying an update by itself when idle (#352, the window reads the same report);
 *   - updating the agent CLIs by themselves (#297): call `hostBusy` on the live snapshot.
 *
 * Kept free of any service so it is tested as data; the host builds the snapshot (main.ts).
 */

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
 * - an open terminal or a running project command (a dev server). An open terminal counts even
 *   when its shell sits at a prompt: the host cannot yet tell an idle shell from one running a
 *   command, and guessing wrong would end someone's work.
 *
 * External app processes do not count: they start on demand and are restarted with the host
 * (#280, decision 2).
 */
export function hostBusy(s: ActivitySnapshot): boolean {
  return s.terminals > 0 || s.commandRuns > 0 || s.sessions.some((x) => x.live === true && BUSY_STATES.has(x.state))
}
