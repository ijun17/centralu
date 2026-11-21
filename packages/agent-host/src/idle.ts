import { atRest, busyWith, isInTurn, type BusyReason, type HostActivity, type SessionInfo, type SessionState } from '@cc/protocol'

/**
 * The one rule for "is anything running that a person would lose": the keeper's idle exit, the switch-build and automatic-update
 * questions and moving a session to a new agent CLI all read it, so they cannot drift apart (#280, #352, #297).
 * Free of any service so it is tested as data; the host builds the snapshot in main.ts
 */

/**
 * The states in which a turn is running (`isInTurn`). Not `waiting_input`: `turn_complete` leaves it until the next message, and
 * counting it made every session that had answered read as busy, so idle exits and "Apply updates automatically when idle" (#352)
 * waited for a message nobody sends. A pending question is counted by `pendingQuestions` too, so it holds where the state is unknown
 */
export const inTurn = (state: SessionState): boolean => isInTurn(state)

/** One session as the idle rule reads it; the fields past `state` and `live` are optional, so a snapshot without them reads as nothing pending */
export type IdleActivity = Pick<SessionInfo, 'state' | 'live'> &
  Partial<Pick<SessionInfo, 'id' | 'pendingApproval' | 'pendingQuestions' | 'backgroundTasks'>>

export type ActivitySnapshot = {
  sessions: IdleActivity[]
  terminals: number
  commandRuns: number
}

/** Whether one live session holds something a person would lose; a session with no process holds nothing (#290) */
export function sessionBusy(s: IdleActivity): boolean {
  return s.live === true && !atRest(s)
}

/**
 * Whether the host is doing anything a person would lose if it stopped now: a busy live session (`sessionBusy`), an open terminal
 * or a running project command. A terminal counts even at a prompt, since the host cannot tell an idle shell from one running a
 * command. External app processes do not: they start on demand and restart with the host (#280)
 */
export function hostBusy(s: ActivitySnapshot): boolean {
  return s.terminals > 0 || s.commandRuns > 0 || s.sessions.some(sessionBusy)
}

/** `hostBusy` for a question a session asks itself (an agent applying an update): its own turn is not counted, what else it holds still is */
export function hostBusyBesides(s: ActivitySnapshot, sessionId: string): boolean {
  return hostBusy({ ...s, sessions: s.sessions.map((x) => (x.id === sessionId ? { ...x, state: 'waiting_input' as const } : x)) })
}

/**
 * Whether Automatic updates would apply an update now: the switch is on, the host is not draining and nothing runs (`besides`
 * is the asking session). Pure, so each condition is tested alone (#1509)
 */
export function updateAtRest(i: { automatic: boolean; draining: boolean; activity: ActivitySnapshot; besides?: string }): boolean {
  if (!i.automatic || i.draining) return false
  return !(i.besides === undefined ? hostBusy(i.activity) : hostBusyBesides(i.activity, i.besides))
}

/**
 * What `hostBusy` counts, for `host.activity` (a hub's "Update <machine>" prompt, plan §10.5): a busy session counts once,
 * under the first of approval, question, turn, background work
 */
export function activityCounts(s: ActivitySnapshot): HostActivity {
  const c: HostActivity = { working: 0, approvals: 0, questions: 0, background: 0, terminals: s.terminals, commandRuns: s.commandRuns }
  for (const x of s.sessions) {
    if (!sessionBusy(x)) continue
    // A question blocks the session as an approval does (waiting_approval), so its own list is read before the state
    if (x.pendingApproval) c.approvals++
    else if ((x.pendingQuestions?.length ?? 0) > 0) c.questions++
    else if (x.state === 'waiting_approval') c.approvals++
    else if (inTurn(x.state)) c.working++
    else c.background++
  }
  return c
}

/**
 * Whether stopping the host now ends this session's turn: it works or waits on an approval or question. Background work alone
 * is not a turn, nothing continues it (#1618)
 */
export function turnCut(s: IdleActivity): boolean {
  return inTurn(s.state)
}

/**
 * The turns stopping the host now ends, as an update's stop lists them for the next host (#1618): the sessions in a turn (`turnCut`)
 * and `woken`, the cut turns an update's start continued that have not answered yet (`TurnContinue.unanswered`, #1913): a resumed
 * process ends a turn of its own before the note's request, so one can read at rest. No other session at rest is listed: a Stop
 * writes no row, so a mark alone cannot tell the person's Stop from a woken turn's gap
 */
export function cutTurns(s: ActivitySnapshot, woken: readonly string[] = []): { id: string; woken?: true }[] {
  const inTurnNow = s.sessions.flatMap((x) => (x.id !== undefined && turnCut(x) ? [{ id: x.id }] : []))
  return [...inTurnNow, ...woken.filter((id) => !inTurnNow.some((t) => t.id === id)).map((id) => ({ id, woken: true as const }))]
}

/**
 * Whether one session's agent process can be replaced on a newly installed CLI without losing anything (#290, #297);
 * `SessionProcesses.sessionIdle` answers with it, adding whether a process runs and whether the tool reports background work.
 * Not idle during a turn, an approval, a question or background work that counts (the tool holds it in its process); a tool that
 * cannot report background work is never idle while its process lives; no process is idle. Unlike `sessionBusy`, terminals and commands do not count
 */
export type SessionIdle =
  | { idle: true }
  | { idle: false; reason: BusyReason | 'background_unknown' }

export function sessionIdle(
  s: Pick<SessionInfo, 'state' | 'pendingApproval' | 'pendingQuestions' | 'backgroundTasks'>,
  process: { running: boolean; reportsBackground: boolean },
): SessionIdle {
  // The busy rule's own reason (`busyWith`), except that background work counts only while a process holds it
  const busy = busyWith(s)
  if (busy !== null && busy !== 'background') return { idle: false, reason: busy }
  if (!process.running) return { idle: true }
  if (busy !== null) return { idle: false, reason: busy }
  if (!process.reportsBackground) return { idle: false, reason: 'background_unknown' }
  return { idle: true }
}
