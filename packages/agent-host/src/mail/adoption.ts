import { errorMessage } from '@cc/protocol'
import type { SessionInfo } from '@cc/protocol'
import type { Store } from '../dev-services/store.js'
import { inTurn } from '../idle.js'
import { parseAddress } from './address.js'
import type { MessageService } from './messages.js'
import { ADOPTED_TASK } from './rules.js'

/** What the host knows of a session when it adopts the marks an older build wrote */
export type AdoptedSession = { askedBy?: string | null; state: SessionInfo['state'] }

/**
 * What the host that becomes the active one does with what an earlier build left (docs/plans/mailbox.md §9.5), after the pending thread mail moved
 * and before delivery starts. The old report paths are the truth of a report owed until M8 (D18), and the task rows follow them:
 *
 * 1. **Marks with no task.** A report mark whose caller has no unsettled task to its session gets one, delivered (the old build delivered the work),
 *    with the origin the mark implies (`start_agent` when the caller started the session, else `send_to_session`).
 * 2. **Tasks no mark owes.** An unsettled task from a session to a session the old paths no longer owe (`oldOwes`), whose child is here and not in a
 *    turn and has no undelivered mail from the owner, is settled `reported`, with no report message: the old path told the owner.
 *
 * Neither starts a turn nor wakes anyone. A crash between the old path's write and the task row's is mended at the next `ready` the same way.
 */
export function takeOverFromEarlierBuild(
  mail: MessageService,
  store: Pick<Store, 'children' | 'mailbox'>,
  sessions: {
    info(id: string): AdoptedSession | undefined
    /** §9.5's `oldOwes`: the old report paths still owe the owner a report of the child */
    oldOwes(ownerId: string, childId: string): boolean
  },
): { adopted: number; settled: number } {
  let adopted = 0
  for (const mark of store.children.listReportMarks()) {
    if (mark.sessionId === mark.callerSessionId) continue
    const child = sessions.info(mark.sessionId)
    if (!child || !sessions.info(mark.callerSessionId)) continue
    const owner = mail.sessionAddress(mark.callerSessionId)
    const childAddress = mail.sessionAddress(mark.sessionId)
    if (store.mailbox.newestTask(owner, childAddress)) continue
    try {
      mail.task(owner, childAddress, { text: ADOPTED_TASK, origin: child.askedBy === mark.callerSessionId ? 'start_agent' : 'send_to_session', delivered: true })
      adopted++
    } catch (e) {
      // One mark that cannot be adopted leaves the others; the old path still reports it
      console.error(`[mail] could not adopt the report mark of ${mark.sessionId.slice(0, 8)} (${errorMessage(e)})`)
    }
  }

  let settled = 0
  const queued = new Set(store.children.listQueuedRequests().map((r) => r.sessionId))
  for (const row of store.mailbox.unsettledTasks()) {
    const owner = parseAddress(row.sender)
    const child = parseAddress(row.recipient)
    if (owner?.kind !== 'session' || child?.kind !== 'session') continue
    const info = sessions.info(child.sessionId)
    if (!info || inTurn(info.state) || queued.has(child.sessionId) || sessions.oldOwes(owner.sessionId, child.sessionId)) continue
    if (store.mailbox.pendingFor(row.recipient, Number.MAX_SAFE_INTEGER).some((p) => p.message.sender === row.sender)) continue
    try {
      if (mail.settleReported(row.messageId, row.recipient) > 0) settled++
    } catch (e) {
      console.error(`[mail] could not settle the work an earlier build reported (${row.messageId}): ${errorMessage(e)}`)
    }
  }
  return { adopted, settled }
}
