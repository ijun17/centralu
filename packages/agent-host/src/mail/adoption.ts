import { errorMessage } from '@cc/protocol'
import type { SessionInfo } from '@cc/protocol'
import type { Store } from '../dev-services/store.js'
import type { ThreadRow } from '../dev-services/store/mail.js'
import { inTurn } from '../idle.js'
import { parseAddress } from './address.js'
import type { MailService } from './service.js'

/** What the host knows of a session when it adopts the marks an older build wrote */
export type AdoptedSession = { askedBy?: string | null; projectId?: string | null; depth?: number }

/**
 * The other way (§4.2): work an earlier build finished while it served the store. It reported the old way and never moved the threads this build
 * had written, so one it finished still reads `running`, and a parent that handed it on counts it as going for ever (its next turn end is "the same
 * pause", and nobody hears). A delegation thread that is `open` or `running` is finished when its session owes its owner no report mark, is at
 * rest, holds nothing paused or queued and has no mail it has not taken: it goes to `review` with an event. Idempotent, and only the origins that carry a mark while work is
 * owed; `blocked` threads and the ones made with `mail` are left
 *
 * @returns how many threads it moved
 */
export function reconcileFinished(
  mail: MailService,
  threads: readonly ThreadRow[],
  host: {
    /** The session owes this owner a report (its mark names the owner) */
    owes(assigneeId: string, ownerId: string): boolean
    /** The session is here and not in a turn */
    atRest(sessionId: string): boolean
    /** The session's report is held over background work, or a request waits for it */
    holds(sessionId: string): boolean
    /** The thread holds mail for its session that the session has not taken (the owner or the person sent more into it): work in hand */
    mailInHand(thread: ThreadRow): boolean
  },
): number {
  let moved = 0
  for (const thread of threads) {
    const assignee = parseAddress(thread.assignee ?? '')
    const owner = parseAddress(thread.owner)
    if (assignee?.kind !== 'session' || owner?.kind !== 'session') continue
    if (host.owes(assignee.sessionId, owner.sessionId) || !host.atRest(assignee.sessionId) || host.holds(assignee.sessionId) || host.mailInHand(thread)) continue
    try {
      if (mail.finishedByEarlierBuild(thread.id)) moved++
    } catch (e) {
      console.error(`[mail] could not close the work an earlier build finished (${thread.id}): ${errorMessage(e)}`)
    }
  }
  return moved
}

/**
 * Report marks an older build wrote while it served the same store (docs/plans/mailbox.md §4.2, slice 3): this build adopts them as threads when
 * it becomes the active host, after the old one drained, so a mark written while both were up is not missed. A mark is a `running` thread whose
 * owner is the marking caller (origin `start_agent` when the caller started the session, else `send_to_session`); one paused over the session's own
 * background work says so in an event. Keyed by the two sessions and idempotent: a pair that has a thread not over is skipped. A mark whose
 * sessions are not both here is left alone, and the old rows stay, kept in step as the contract (slice 9) is not yet
 *
 * @returns how many threads it made
 */
export function adoptOldMarks(
  mail: MailService,
  marks: readonly { sessionId: string; callerSessionId: string }[],
  sessionOf: (id: string) => AdoptedSession | undefined,
  /** How many background tasks the session's report is held over, 0 when it is not */
  pausedTasks: (sessionId: string) => number,
): number {
  let made = 0
  for (const mark of marks) {
    if (mark.sessionId === mark.callerSessionId) continue
    const child = sessionOf(mark.sessionId)
    if (!child || !sessionOf(mark.callerSessionId)) continue
    try {
      const paused = pausedTasks(mark.sessionId)
      const thread = mail.adoptMark(mail.sessionAddress(mark.callerSessionId), mail.sessionAddress(mark.sessionId), {
        origin: child.askedBy === mark.callerSessionId ? 'start_agent' : 'send_to_session',
        projectId: child.projectId ?? null,
        ...(child.depth ? { depth: child.depth } : {}),
        ...(paused > 0 ? { paused } : {}),
      })
      if (thread) made++
    } catch (e) {
      // One mark that cannot be adopted leaves the others; the old path still reports it
      console.error(`[mail] could not adopt the report mark of ${mark.sessionId.slice(0, 8)} (${errorMessage(e)})`)
    }
  }
  return made
}

/**
 * What the host that becomes the active one does with the store an earlier build served (§4.2), before delivery starts: adopt the report marks it
 * wrote, then close the work it finished (the marks it cleared while the threads here still read as going). Neither starts a turn nor wakes anyone
 */
export function takeOverFromEarlierBuild(
  mail: MailService,
  store: Pick<Store, 'children' | 'mail'>,
  sessions: {
    info(id: string): (AdoptedSession & { state: SessionInfo['state'] }) | undefined
    depth(id: string): number
    /** How many background tasks the session's stored report is held over; null when it is not held */
    paused(id: string): number | null
  },
): { adopted: number; closed: number } {
  const marks = store.children.listReportMarks()
  const paused = (id: string) => sessions.paused(id)
  const adopted = adoptOldMarks(
    mail,
    marks,
    (id) => {
      const s = sessions.info(id)
      return s && { askedBy: s.askedBy, projectId: s.projectId, depth: sessions.depth(id) }
    },
    (id) => paused(id) ?? 0,
  )
  const owing = new Map(store.children.listReportMarks().map((r) => [r.sessionId, r.callerSessionId]))
  const queued = new Set(store.children.listQueuedRequests().map((r) => r.sessionId))
  const closed = reconcileFinished(mail, store.mail.goingMarked(), {
    owes: (assigneeId, ownerId) => owing.get(assigneeId) === ownerId,
    atRest: (id) => {
      const s = sessions.info(id)
      return !!s && !inTurn(s.state)
    },
    holds: (id) => queued.has(id) || paused(id) !== null,
    mailInHand: (thread) => thread.assignee !== null && store.mail.hasMailInHand(thread.id, thread.assignee),
  })
  return { adopted, closed }
}
