import { oneRow } from './rows.js'
import type Database from 'better-sqlite3'
import type { StoredMessage } from '@cc/protocol'
import { readRows } from './messages.js'

/** How much of the app's request a trash row shows: enough to tell two runs of one app apart */
const REQUEST_PREVIEW_CHARS = 300

/** One row of `listKeptRuns`, in the store's own terms */
export type KeptRunRow = {
  runId: string
  projectId: string | null
  projectName: string | null
  appId: string
  appName: string
  sessionId: string
  sessionName: string
  tool: string
  status: string
  durationMs: number | null
  tokens: { input: number; output: number } | null
  requestPreview: string
  startedAt: number
  keptAt: number
  messages: number
  bytes: number
}

/**
 * The records of deleted app-agent sessions (#378): what a session an app stood up with `run_agent` did, kept in the
 * trash once the session itself is deleted. The person reads them in Settings → Archive and deletes them there; the run
 * log's retention prunes them with the rest (`AppRunRecords.pruneAppRuns`).
 *
 * A record holds the whole conversation (owner decision, 2026-10-06), copied from `messages` and its subagents' steps
 * from `subagent_messages` (#222) in SQLite without passing through the host, and everything the trash lists, so it
 * needs neither the session nor the run log line to be read. The purge that follows deletes both tables' rows of the
 * session, so the copy is what is left of them. Subagent steps the person moved to the trash (#418, `trashed_at`) are
 * not copied: the person put them out of the conversation, and the record must not bring them back or outlive their
 * purge.
 */
export class KeptRuns {
  constructor(private readonly db: Database.Database) {}

  /**
   * Keeps the record of one app-agent session before it is deleted: its run's row as it ended, the names the trash
   * shows, and a copy of every message and every subagent step. One transaction, checked by its row counts against the
   * session's, so a record is never kept half-copied. Returns false, with nothing kept, when the run is not in the log
   * (pruned meanwhile) or the copy is not whole: the caller then keeps the session rather than lose what it did.
   */
  keepRun(r: { runId: string; sessionId: string; sessionName: string; appName: string; projectName: string | null; tool: string; keptAt: number }): boolean {
    const tx = this.db.transaction((): boolean => {
      const inserted = this.db
        .prepare(
          `INSERT OR REPLACE INTO app_run_records
             (run_id, project_id, project_name, app_id, app_name, session_id, session_name, tool, status, duration_ms,
              tokens_in, tokens_out, request, answer, output, started_at, kept_at)
           SELECT id, project_id, ?, app_id, ?, ?, ?, ?, status, duration_ms, tokens_in, tokens_out,
                  coalesce(request, ''), coalesce(answer, ''), output, created_at, ?
           FROM app_runs WHERE id = ?`,
        )
        .run(r.projectName, r.appName, r.sessionId, r.sessionName, r.tool, r.keptAt, r.runId).changes
      if (inserted === 0) return false
      this.db.prepare(`DELETE FROM app_run_messages WHERE run_id = ?`).run(r.runId)
      this.db.prepare(`DELETE FROM app_run_subagent_messages WHERE run_id = ?`).run(r.runId)
      const messages = this.db
        .prepare(
          `INSERT INTO app_run_messages (run_id, seq, role, kind, payload, ts)
           SELECT ?, seq, role, kind, payload, ts FROM messages WHERE session_id = ?`,
        )
        .run(r.runId, r.sessionId).changes
      const steps = this.db
        .prepare(
          `INSERT INTO app_run_subagent_messages (run_id, parent_call_id, seq, role, kind, payload, ts)
           SELECT ?, parent_call_id, seq, role, kind, payload, ts FROM subagent_messages WHERE session_id = ? AND trashed_at IS NULL`,
        )
        .run(r.runId, r.sessionId).changes
      const has = oneRow(
        this.db
        .prepare<unknown[], { messages: number; steps: number; keptMessages: number; keptSteps: number }>(
          `SELECT (SELECT COUNT(*) FROM messages WHERE session_id = @s) as messages,
                  (SELECT COUNT(*) FROM subagent_messages WHERE session_id = @s AND trashed_at IS NULL) as steps,
                  (SELECT COUNT(*) FROM app_run_messages WHERE run_id = @r) as keptMessages,
                  (SELECT COUNT(*) FROM app_run_subagent_messages WHERE run_id = @r) as keptSteps`,
        )
        .get({ s: r.sessionId, r: r.runId }),
      )
      // Thrown, so the transaction takes back what it wrote: a record is the whole session or nothing
      if (messages !== has.messages || steps !== has.steps || has.keptMessages !== has.messages || has.keptSteps !== has.steps) throw new IncompleteCopy()
      return true
    })
    try {
      return tx()
    } catch (e) {
      if (e instanceof IncompleteCopy) return false
      throw e
    }
  }

  /** Every kept record, most recent first, with how much of the store each holds (its messages' bytes) */
  listKeptRuns(): KeptRunRow[] {
    const rows = this.db
      .prepare<unknown[], (Omit<KeptRunRow, 'tokens'> & { tokensIn: number | null; tokensOut: number | null })>(
        `SELECT k.run_id as runId, k.project_id as projectId, k.project_name as projectName, k.app_id as appId,
                k.app_name as appName, k.session_id as sessionId, k.session_name as sessionName, k.tool, k.status,
                k.duration_ms as durationMs, k.tokens_in as tokensIn, k.tokens_out as tokensOut,
                substr(k.request, 1, ${REQUEST_PREVIEW_CHARS}) as requestPreview, k.started_at as startedAt, k.kept_at as keptAt,
                (SELECT COUNT(*) FROM app_run_messages m WHERE m.run_id = k.run_id) as messages,
                LENGTH(CAST(k.request AS BLOB)) + LENGTH(CAST(k.answer AS BLOB)) + COALESCE(LENGTH(CAST(k.output AS BLOB)), 0)
                  + COALESCE((SELECT SUM(LENGTH(CAST(m.payload AS BLOB))) FROM app_run_messages m WHERE m.run_id = k.run_id), 0)
                  + COALESCE((SELECT SUM(LENGTH(CAST(m.payload AS BLOB))) FROM app_run_subagent_messages m WHERE m.run_id = k.run_id), 0) as bytes
         FROM app_run_records k ORDER BY k.kept_at DESC, k.rowid DESC`,
      )
      .all()
    return rows.map(({ tokensIn, tokensOut, ...r }) => ({ ...r, tokens: tokensIn === null ? null : { input: tokensIn, output: tokensOut ?? 0 } }))
  }

  /** One record's request, answer and output, and a page of its conversation (the shape of `messages.load`); null when it is gone */
  readKeptRun(runId: string, limit: number, beforeSeq?: number): { request: string; answer: string; output: string | null; messages: StoredMessage[] } | null {
    const head = this.db.prepare<unknown[], { request: string; answer: string; output: string | null; sessionId: string }>(`SELECT request, answer, output, session_id as sessionId FROM app_run_records WHERE run_id = ?`).get(runId)
    if (!head) return null
    const raw = this.db
      .prepare<unknown[], (StoredMessage & { payload: string })>(
        `SELECT ? as sessionId, seq, role, kind, payload, ts FROM app_run_messages
         WHERE run_id = ? AND (? IS NULL OR seq < ?) ORDER BY seq DESC LIMIT ?`,
      )
      .all(head.sessionId, runId, beforeSeq ?? null, beforeSeq ?? null, limit)
    return { request: head.request, answer: head.answer, output: head.output, messages: readRows(raw.reverse()) }
  }

  /**
   * Deletes kept records for good, and what their run log lines still say of the conversation (the request, the answer
   * and the output): the line itself stays with its status, time and tokens, as any call's does. The request is left
   * empty rather than null, which still says an agent was started (`appAgentUse`). @returns how many went
   */
  purgeKeptRuns(runIds: readonly string[]): number {
    const tx = this.db.transaction((): number => {
      let gone = 0
      for (const id of runIds) {
        this.db.prepare(`DELETE FROM app_run_messages WHERE run_id = ?`).run(id)
        this.db.prepare(`DELETE FROM app_run_subagent_messages WHERE run_id = ?`).run(id)
        gone += this.db.prepare(`DELETE FROM app_run_records WHERE run_id = ?`).run(id).changes
        this.db.prepare(`UPDATE app_runs SET request = '', answer = NULL, output = NULL WHERE id = ? AND request IS NOT NULL`).run(id)
      }
      return gone
    })
    return tx()
  }

  /** The ids of every kept record, for emptying the trash */
  keptRunIds(): string[] {
    return this.db.prepare<unknown[], { runId: string }>(`SELECT run_id as runId FROM app_run_records`).all().map((r) => r.runId)
  }
}

/** A copy whose row counts do not match the session's (`keepRun`), thrown to roll the transaction back */
class IncompleteCopy extends Error {}
