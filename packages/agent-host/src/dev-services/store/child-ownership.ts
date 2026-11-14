import type Database from 'better-sqlite3'
import { parseJson } from './json.js'

/** Which session owns the work another session gave: the start requests waiting for the person, and a handoff's move of its children */
export class ChildOwnershipRecords {
  constructor(private readonly db: Database.Database) {}

  /**
   * The report marks a build of v70 to v73 leaves as it goes (`report_marks`, #646), deleted unread at every start: this build owes nothing by
   * them (docs/plans/mailbox.md §10.6.3), and that build, after a rollback, would make a task of one this build's tasks have since settled
   */
  dropReportMarks(): void {
    this.db.prepare(`DELETE FROM report_marks`).run()
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
