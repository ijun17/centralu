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

/**
 * The states in which a turn is running: someone would lose it if the host went away.
 *
 * Not `waiting_input`. That is what `turn_complete` leaves (sessions/manager.ts, `applyStateHint`)
 * until the next message: the turn is over and its answer is stored. Counting it made every session
 * that had ever answered read as busy, so the keeper's idle exit and "Apply updates automatically
 * when idle" (#352) waited for a message nobody was going to send. A question waiting for an answer
 * is counted by itself (`pendingQuestions`), not by a state that also means "finished".
 */
const BUSY_STATES: ReadonlySet<SessionState> = new Set(['working', 'waiting_approval'])

/**
 * One session as the idle rule reads it. The fields past `state` and `live` are optional so a
 * snapshot that does not carry them still reads (as nothing pending); the host's (`main.ts`,
 * `mgr.listSessions()`) carries all of them.
 */
export type SessionActivity = Pick<SessionInfo, 'state' | 'live'> &
  Partial<Pick<SessionInfo, 'pendingApproval' | 'pendingQuestions' | 'backgroundTasks'>>

export type ActivitySnapshot = {
  sessions: SessionActivity[]
  terminals: number
  commandRuns: number
}

/**
 * Whether one live session holds something a person would lose: a running turn, an approval or a
 * question waiting for them, or background work that counts as activity (#290 — the tool holds it in
 * its process). A session with no process holds nothing.
 */
export function sessionBusy(s: SessionActivity): boolean {
  if (s.live !== true) return false
  return (
    BUSY_STATES.has(s.state) ||
    !!s.pendingApproval ||
    (s.pendingQuestions?.length ?? 0) > 0 ||
    liveBackgroundTasks(s.backgroundTasks ?? []).length > 0
  )
}

/**
 * Whether the host is doing anything a person would lose if it stopped now.
 *
 * - a live session that is working, waiting for an approval or on a question, or running
 *   background work (`sessionBusy`) — an approval left in background mode is exactly what a person
 *   comes back for. A session whose turn has finished (`waiting_input`) is not busy;
 * - an open terminal or a running project command (a dev server). An open terminal counts even
 *   when its shell sits at a prompt: the host cannot yet tell an idle shell from one running a
 *   command, and guessing wrong would end someone's work.
 *
 * External app processes do not count: they start on demand and are restarted with the host
 * (#280, decision 2).
 */
export function hostBusy(s: ActivitySnapshot): boolean {
  return s.terminals > 0 || s.commandRuns > 0 || s.sessions.some(sessionBusy)
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
 * The same facts about a session as `sessionBusy`, with two differences: terminals and commands do
 * not count (restarting one session's process does not touch them), and a tool that cannot report
 * its background work is not idle while its process lives. A finished turn (`waiting_input`) is
 * idle here as there.
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
