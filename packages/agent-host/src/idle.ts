import { liveBackgroundTasks, type SessionInfo, type SessionState } from '@cc/protocol'

/**
 * The one rule for "is anything running that a person would lose" (#280, #352).
 *
 * Every decision that must wait for a quiet moment reads this rule and no other, so they cannot
 * drift apart:
 *   - the keeper's idle exit in background mode (through the activity report, keeper-link.ts);
 *   - whether switching builds asks first (the keeper passes the same report to the window);
 *   - applying an update by itself when idle (#352, the window reads the same report);
 *   - moving a session to a newly installed agent CLI (#297): `sessionIdle` below, one session at a
 *     time, which is this rule narrowed to what one session's process holds.
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

/**
 * Whether one session's agent process can be replaced without losing anything (#290, #297): the
 * rule for restarting a single session on a newly installed CLI. The session manager answers with
 * it (`SessionManager.sessionIdle`), adding the facts only it holds: whether a process is running
 * and whether the tool reports its background work.
 *
 * Not idle while a turn runs, while an approval or a question waits, or while background work that
 * counts as activity runs: the tool holds that work in its process, and a restart ends it. A tool
 * that cannot report its background work is never called idle while its process lives, since
 * silence there does not mean nothing is running. A session with no process is idle: it holds
 * nothing.
 *
 * **Narrower than `hostBusy`, on purpose.** `hostBusy` counts `waiting_input`, and that is the
 * state every finished turn leaves (`turn_complete`) until the next message: the answer is stored,
 * and the process holds nothing of it. Counting it here would keep every session that ever
 * answered on its old CLI. A question waiting for an answer is `pendingQuestions`, counted below.
 */
export type SessionIdle =
  | { idle: true }
  | { idle: false; reason: 'turn' | 'approval' | 'question' | 'background' | 'background_unknown' }

export function sessionIdle(
  s: Pick<SessionInfo, 'state' | 'pendingApproval' | 'pendingQuestions' | 'backgroundTasks'>,
  process: { running: boolean; reportsBackground: boolean },
): SessionIdle {
  if (s.pendingApproval) return { idle: false, reason: 'approval' }
  if (s.pendingQuestions.length > 0) return { idle: false, reason: 'question' }
  if (s.state === 'working' || s.state === 'waiting_approval') return { idle: false, reason: 'turn' }
  if (!process.running) return { idle: true }
  if (liveBackgroundTasks(s.backgroundTasks).length > 0) return { idle: false, reason: 'background' }
  if (!process.reportsBackground) return { idle: false, reason: 'background_unknown' }
  return { idle: true }
}
