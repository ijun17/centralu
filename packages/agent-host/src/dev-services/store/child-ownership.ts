import type Database from 'better-sqlite3'
import { parseJson } from './json.js'

/** A request held for a busy session until its turn ends (#677, `queued_requests`) */
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

  // ── Sessions running a turn another session gave them (#676) — see migration v51 ──

  listDelegatedTurns(): { sessionId: string; callerSessionId: string; told: string[]; turnId: string }[] {
    const rows = this.db
      .prepare<unknown[], { sessionId: string; callerSessionId: string; told: string; turnId: string }>(`SELECT session_id as sessionId, caller_session_id as callerSessionId, told_cards as told, turn_id as turnId FROM delegated_turns ORDER BY started_at`)
      .all()
    return rows.map((r) => ({ ...r, told: r.told.split(' ').filter(Boolean) }))
  }

  /** A new delegated turn: the cards told of the session's earlier one go with it */
  setDelegatedTurn(sessionId: string, callerSessionId: string, turnId: string): void {
    this.db
      .prepare(
        `INSERT INTO delegated_turns (session_id, caller_session_id, started_at, told_cards, turn_id) VALUES (?, ?, ?, '', ?)
           ON CONFLICT(session_id) DO UPDATE SET caller_session_id = excluded.caller_session_id, started_at = excluded.started_at, told_cards = '', turn_id = excluded.turn_id`,
      )
      .run(sessionId, callerSessionId, Date.now(), turnId)
  }

  setDelegatedTurnTold(sessionId: string, told: readonly string[]): void {
    this.db.prepare(`UPDATE delegated_turns SET told_cards = ? WHERE session_id = ?`).run(told.join(' '), sessionId)
  }

  // ── Requests held for a busy session (#677) — see migration v52 ──

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

  addQueuedRequest(r: QueuedRequest): void {
    this.db
      .prepare(`INSERT INTO queued_requests (id, session_id, caller_session_id, via, text, queued_at, opened_by_auto) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(r.id, r.sessionId, r.callerSessionId, r.via, r.text, r.queuedAt, r.openedByAuto ? 1 : 0)
  }

  /** A queued ask that now rests on its requester's `auto` alone (#838): the mark the delivery gate reads */
  markQueuedOpenedByAuto(id: string): void {
    this.db.prepare(`UPDATE queued_requests SET opened_by_auto = 1 WHERE id = ?`).run(id)
  }

  markQueuedDelivering(id: string, at: number | null): void {
    this.db.prepare(`UPDATE queued_requests SET delivering_at = ? WHERE id = ?`).run(at, id)
  }

  removeQueuedRequest(id: string): void {
    this.db.prepare(`DELETE FROM queued_requests WHERE id = ?`).run(id)
  }

  clearDelegatedTurn(sessionId: string): void {
    this.db.prepare(`DELETE FROM delegated_turns WHERE session_id = ?`).run(sessionId)
  }

  /**
   * A handoff's move of the original session's live children to the session that took over (#693), in one
   * transaction: each moved session's `asked_by_session_id` and `parent_session_id` where they name the original, the
   * report each owes it (`report_marks`), the delegated turn it gave each (`delegated_turns`), every request it queued
   * (`queued_requests`), and its start_agent requests still waiting for the person (`agent_start_requests`, whose
   * stored request names its caller too). A crash before the commit leaves every row on the original; after it, every
   * row on the new session, so the next host (a swap or a restart) reads one owner either way. `armReports`: children
   * whose report the original was waiting for in a call (its wait had taken the mark down), now owed to the new session.
   * `then`: the rest of the handoff's move that is stored elsewhere (the mail, `MailService.handOver`), run last in the same
   * transaction, so a refusal there leaves every row of both on the original.
   */
  moveChildren(
    from: string,
    to: string,
    move: { sessions: readonly string[]; startRequests: readonly { requestId: string; request: unknown }[]; armReports?: readonly string[]; queued?: boolean },
    then?: () => void,
  ): void {
    this.db.transaction(() => {
      const owner = this.db.prepare(
        `UPDATE sessions SET
           asked_by_session_id = CASE WHEN asked_by_session_id = @from THEN @to ELSE asked_by_session_id END,
           parent_session_id = CASE WHEN parent_session_id = @from THEN @to ELSE parent_session_id END
         WHERE id = @id`,
      )
      const mark = this.db.prepare(`UPDATE report_marks SET caller_session_id = @to WHERE session_id = @id AND caller_session_id = @from`)
      const turn = this.db.prepare(`UPDATE delegated_turns SET caller_session_id = @to WHERE session_id = @id AND caller_session_id = @from`)
      for (const id of move.sessions) {
        owner.run({ from, to, id })
        mark.run({ from, to, id })
        turn.run({ from, to, id })
      }
      // A removed original's queue stays with it, for the trash to drop (#738)
      if (move.queued !== false) this.db.prepare(`UPDATE queued_requests SET caller_session_id = ? WHERE caller_session_id = ?`).run(to, from)
      const start = this.db.prepare(`UPDATE agent_start_requests SET caller_session_id = ?, request = ? WHERE request_id = ? AND caller_session_id = ?`)
      for (const r of move.startRequests) start.run(to, JSON.stringify(r.request), r.requestId, from)
      const arm = this.db.prepare(
        `INSERT INTO report_marks (session_id, caller_session_id, marked_at) VALUES (?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET caller_session_id = excluded.caller_session_id, marked_at = excluded.marked_at`,
      )
      for (const id of move.armReports ?? []) arm.run(id, to, Date.now())
      then?.()
    })()
  }
}
