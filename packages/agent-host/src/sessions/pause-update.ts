import type { SessionInfo } from '@cc/protocol'
import type { Store } from '../dev-services/store.js'
import { inTurn } from '../idle.js'
import { pausedReportKey, readPausedTasks } from './child-ownership.js'

/** A later turn of work whose report is paused on the session's own background work, as a report path knows it (#1540) */
export type LaterTurn = {
  /** Centralu's own turn to compact the conversation */
  compaction?: boolean
  /** A message no session sent went into it: the person's, an app's or a script's. Such a turn may be theirs though it reads as the work's */
  othersWrote?: boolean
  /** The person wrote to the session since it owed the report: which of its turns are theirs cannot always be told, and their words are not the caller's */
  personWrote?: boolean
}

/**
 * Whether a later turn of paused work is an update its caller hears at once (#1540): one that said something of its own, in the work's own turn.
 * A turn with no words (a Monitor's look), Centralu's compaction, a turn others wrote into, and every turn once the person wrote to the session tell
 * nothing; the final report still comes when the work ends. The one rule for this host's children (`ChildReports`) and a linked machine's (`LinkedReports`)
 */
export function isPauseUpdate(turn: LaterTurn, words: string): boolean {
  return !turn.compaction && !turn.othersWrote && !turn.personWrote && words.trim() !== ''
}

/**
 * Whether the person wrote to the session since it owed its report (#1540): a pause of that work then sends no updates. Read from the store (the
 * person's message after the report's mark, which new work sets again), so a host after an update reads it as the one before did
 */
export function personWroteSinceMark(store: Pick<Store, 'children' | 'messages'>, sessionId: string): boolean {
  const marked = store.children.reportMarkedAt(sessionId)
  const said = marked === null ? null : store.messages.newestPersonMessage(sessionId)
  return marked !== null && said !== null && said.ts >= marked
}

/**
 * The reports paused over the work of a session at rest that an update's stop ended (#1912), at the start after it: no turn was cut, so nothing
 * would end the work's wait, and its caller would wait for good. Each is kept as a report whose turn goes on (`ChildOwnership.restoreReports`),
 * and the next report about the session says the update stopped that work (`StoppedByUpdate`): the end of the turn the update's note wakes
 * it for, or at once when no such turn comes (`ChildReports.reportStoppedByUpdate`)
 */
export function keptOverUpdateStop(store: Pick<Store, 'children' | 'settings'>, sessions: ReadonlyMap<string, SessionInfo>, goingOn: ReadonlySet<string>): Set<string> {
  const kept = new Set<string>()
  for (const mark of store.children.listReportMarks()) {
    // A session whose turn goes on keeps its report as that turn's
    if (goingOn.has(mark.sessionId)) continue
    const child = sessions.get(mark.sessionId)
    const paused = readPausedTasks(store.settings.appSetting(pausedReportKey(mark.sessionId)))
    if (paused && child && !inTurn(child.state) && sessions.has(mark.callerSessionId)) kept.add(mark.sessionId)
  }
  return kept
}
