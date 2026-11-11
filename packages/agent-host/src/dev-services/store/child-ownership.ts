import type Database from 'better-sqlite3'
import { parseJson } from './json.js'

/**
 * A request an older build held for a busy session until its turn ends (#677, `queued_requests`). This build writes none: a send to a busy session
 * is mail (docs/plans/mailbox.md §10.6.2), and a row an older build left becomes a mail task at the start (`takeOverFromEarlierBuild`)
 */
export type QueuedRequest = {
  id: string
  sessionId: string
  callerSessionId: string
  via: 'ask_project' | 'agent_session' | 'send_to_session'
  text: string
  queuedAt: number
  /** When delivery began, until the session's turn starts (#684 review); null while it waits */
  deliveringAt?: number | null
  /**
   * An ask_project request that passed only because its requester was `auto`, with no remembered consent for the pair
   * (v54): delivered only while the requester still is, or the pair has consent by then. Null in a row an older build
   * wrote, which does not say.
   */
  openedByAuto?: boolean | null
}

/** Which session owns the work another session gave: the reports it owes, the requests waiting for the person, the turns it runs for another and the requests held for it */
export class ChildOwnershipRecords {
  constructor(private readonly db: Database.Database) {}

  // ── Sessions that owe a report to the session that gave them work (#646) — see migration v49 ──

  listReportMarks(): { sessionId: string; callerSessionId: string }[] {
    return this.db
      .prepare<unknown[], { sessionId: string; callerSessionId: string }>(`SELECT session_id as sessionId, caller_session_id as callerSessionId FROM report_marks ORDER BY marked_at`)
      .all()
  }

  setReportMark(sessionId: string, callerSessionId: string): void {
    this.db
      .prepare(
        `INSERT INTO report_marks (session_id, caller_session_id, marked_at) VALUES (?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET caller_session_id = excluded.caller_session_id, marked_at = excluded.marked_at`,
      )
      .run(sessionId, callerSessionId, Date.now())
  }

  /** When the session's report mark was set: new work from its caller sets it again, a change of owner does not */

  clearReportMark(sessionId: string): void {
    this.db.prepare(`DELETE FROM report_marks WHERE session_id = ?`).run(sessionId)
  }

  // ── start_agent requests waiting for the person (#673) — see migration v50 ──

  listAgentStartRequests(): { requestId: string; callerSessionId: string; request: unknown; askedAt: number }[] {
    const rows = this.db
      .prepare<unknown[], { requestId: string; callerSessionId: string; request: string; askedAt: number }>(`SELECT request_id as requestId, caller_session_id as callerSessionId, request, asked_at as askedAt FROM agent_start_requests ORDER BY asked_at`)
      .all()
    return rows.flatMap((r) => {
      const request = parseJson(r.request)
      return request === undefined ? [] : [{ ...r, request }]
    })
  }

  putAgentStartRequest(requestId: string, callerSessionId: string, request: unknown): void {
    this.db
      .prepare(
        `INSERT INTO agent_start_requests (request_id, caller_session_id, request, asked_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(request_id) DO UPDATE SET caller_session_id = excluded.caller_session_id, request = excluded.request`,
      )
      .run(requestId, callerSessionId, JSON.stringify(request), Date.now())
  }

  deleteAgentStartRequest(requestId: string): void {
    this.db.prepare(`DELETE FROM agent_start_requests WHERE request_id = ?`).run(requestId)
  }

  /**
   * Sessions running a turn another session gave them (#676, migration v51): this build neither reads nor writes them (docs/plans/mailbox.md
   * §10.6.4). Every start drops what an earlier build left, so that build, after a rollback, adopts no stale link
   */
  dropDelegatedTurns(): void {
    this.db.prepare(`DELETE FROM delegated_turns`).run()
  }

  // ── Requests an older build held for a busy session (#677) — see migration v52; read once, as mail, and removed ──

  listQueuedRequests(): QueuedRequest[] {
    const rows = this.db
      .prepare<unknown[], (Omit<QueuedRequest, 'openedByAuto'> & { openedByAuto: number | null })>(
        `SELECT id, session_id as sessionId, caller_session_id as callerSessionId, via, text, queued_at as queuedAt,
                delivering_at as deliveringAt, opened_by_auto as openedByAuto
           FROM queued_requests ORDER BY queued_at, rowid`,
      )
      .all()
    return rows.map((r) => ({ ...r, openedByAuto: r.openedByAuto === null ? null : r.openedByAuto === 1 }))
  }

  removeQueuedRequest(id: string): void {
    this.db.prepare(`DELETE FROM queued_requests WHERE id = ?`).run(id)
  }

  /**
   * A handoff's move of the original session's children to the session that took over (#693, #1475), in one
   * transaction: each moved session's `asked_by_session_id` and `parent_session_id` where they name the original, and its start_agent requests still waiting for the person (`agent_start_requests`, whose
   * stored request names its caller too). A crash before the commit leaves every row on the original; after it, every
   * row on the new session, so the next host (a swap or a restart) reads one owner either way.
   * `then`: the rest of the handoff's move that is stored elsewhere (the mail, `MailService.handOver`), run last in the same
   * transaction, so a refusal there leaves every row of both on the original.
   */
  moveChildren(
    from: string,
    to: string,
    move: { sessions: readonly string[]; startRequests: readonly { requestId: string; request: unknown }[] },
    then?: () => void,
  ): void {
    this.db.transaction(() => {
      const owner = this.db.prepare(
        `UPDATE sessions SET
           asked_by_session_id = CASE WHEN asked_by_session_id = @from THEN @to ELSE asked_by_session_id END,
           parent_session_id = CASE WHEN parent_session_id = @from THEN @to ELSE parent_session_id END
         WHERE id = @id`,
      )
      for (const id of move.sessions) owner.run({ from, to, id })
      const start = this.db.prepare(`UPDATE agent_start_requests SET caller_session_id = ?, request = ? WHERE request_id = ? AND caller_session_id = ?`)
      for (const r of move.startRequests) start.run(to, JSON.stringify(r.request), r.requestId, from)
      then?.()
    })()
  }
}
