import { errorMessage } from '@cc/protocol'
import type { SessionInfo } from '@cc/protocol'
import type { Store } from '../dev-services/store.js'
import { SEND_ORIGINS } from '../dev-services/store/mail-types.js'
import { parseAddress } from './address.js'
import type { MessageService } from './messages.js'
import { ADOPTED_TASK } from './rules.js'

/** What the host knows of a session when it adopts the marks an older build wrote */
export type AdoptedSession = { askedBy?: string | null; state: SessionInfo['state'] }

/**
 * What the host that becomes the active one does with what an earlier build left (docs/plans/mailbox.md §10.6.3), after the pending thread mail moved
 * and before delivery starts. The task rows are the record of an owed answer:
 *
 * 0. **Requests it queued** (`queued_requests`, docs/plans/mailbox.md §10.6.2). Each becomes a task from its requester, not delivered yet, which the
 *    delivery gives the session as any task (joining its turn, or at its next), and its row goes, in one transaction. A row whose requester or session is
 *    gone goes with no task; a row through a tool this build does not know stays, for a build that knows it (#384).
 * 1. **Report marks.** A mark whose caller has no unsettled task to its session gets one, delivered (the earlier build delivered the work), with the
 *    origin the mark implies (`start_agent` when the caller started the session, else `send_to_session`). Then every mark goes: this build reads none
 *    (`leaveForEarlierBuild` writes them again for a build that does).
 *
 * Neither starts a turn nor wakes anyone. A crash between them is mended at the next `ready` the same way.
 */
export function takeOverFromEarlierBuild(
  mail: MessageService,
  store: Pick<Store, 'children' | 'mailbox'>,
  sessions: { info(id: string): AdoptedSession | undefined },
): { queued: number; adopted: number } {
  let queued = 0
  for (const r of store.children.listQueuedRequests()) {
    if (!SEND_ORIGINS.has(r.via)) continue
    try {
      store.mailbox.transaction(() => {
        if (sessions.info(r.sessionId) && sessions.info(r.callerSessionId)) {
          mail.task(mail.sessionAddress(r.callerSessionId), mail.sessionAddress(r.sessionId), { text: r.text, origin: r.via, delivered: false })
          queued++
        }
        store.children.removeQueuedRequest(r.id)
      })
    } catch (e) {
      // One row that cannot be taken leaves the others, and stays for the next start
      console.error(`[mail] could not take the request an earlier build queued for ${r.sessionId.slice(0, 8)} (${errorMessage(e)})`)
    }
  }

  let adopted = 0
  for (const mark of store.children.listReportMarks()) {
    const child = sessions.info(mark.sessionId)
    const owner = mail.sessionAddress(mark.callerSessionId)
    const childAddress = mail.sessionAddress(mark.sessionId)
    try {
      store.mailbox.transaction(() => {
        if (mark.sessionId !== mark.callerSessionId && child && sessions.info(mark.callerSessionId) && !store.mailbox.newestTask(owner, childAddress)) {
          mail.task(owner, childAddress, { text: ADOPTED_TASK, origin: child.askedBy === mark.callerSessionId ? 'start_agent' : 'send_to_session', delivered: true })
          adopted++
        }
        store.children.clearReportMark(mark.sessionId)
      })
    } catch (e) {
      // One mark that cannot be adopted leaves the others, and stays for the next start
      console.error(`[mail] could not adopt the report mark of ${mark.sessionId.slice(0, 8)} (${errorMessage(e)})`)
    }
  }
  return { queued, adopted }
}

/**
 * What this host leaves for an earlier build that may take over after it (a rollback, docs/plans/mailbox.md §10.6.3): that build reports a turn's end
 * only by a report mark, which it keeps for a session whose turn goes on under it, and settles at its start every task no mark owes. So each session
 * still in a turn gets a mark, and that turn's end is reported there. Written as this host leaves.
 *
 * One mark a session: `report_marks` keeps one row per session, so of several open tasks only one sender can be told; one per task would take a store
 * step. The one chosen is the sender of the task the running turn is the work of (its `mail_turns` row), as that build's own mark named the caller whose
 * work started the turn, so its report of that turn's end goes to the one it was for; when the turn is no session's task (the person's, the CLI's
 * own), the sender of the newest open task, the last instruction the turn took in
 */
export function leaveForEarlierBuild(mail: MessageService, store: Pick<Store, 'children' | 'mailbox'>, inTurnNow: readonly string[]): void {
  const work = new Map(store.mailbox.openTurns().map((t) => [t.sessionId, t.messageId]))
  for (const id of inTurnNow) {
    const address = mail.sessionAddress(id)
    const open = store.mailbox
      .watchedTo(address)
      .map((r) => store.mailbox.message(r.messageId))
      .filter((m) => m?.kind === 'task' && parseAddress(m.sender)?.kind === 'session')
    const task = open.find((m) => m?.id === work.get(id)) ?? open.at(-1)
    const caller = task ? parseAddress(task.sender) : null
    if (caller?.kind === 'session') store.children.setReportMark(id, caller.sessionId)
  }
}
