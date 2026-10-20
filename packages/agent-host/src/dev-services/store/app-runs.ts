import { oneRow } from './rows.js'
import type Database from 'better-sqlite3'
import type { AgentUse } from '@cc/protocol'

/** The cap on chain rows the history screen loads beneath one app's roots (M4 D-6, `listAppRuns`) */
const CHAIN_ROWS_MAX = 500

/** One row of app_runs — the same shape as the runtime's `AppRunRow` (locked together structurally) */
export type AppRunRecord = {
  id: string
  projectId: string | null
  appId: string
  kind: string
  tool: string
  callerKind: string
  callerSessionId: string | null
  parentRunId: string | null
  status: string
  durationMs: number | null
  argsDigest: string
  argsSummary: string
  error: string | null
  createdAt: number
  sessionId: string | null
}

/** The run log for external apps (M4 A-6) and the raw text of the failures it keeps */
export class AppRunRecords {
  constructor(private readonly db: Database.Database) {}

  // ── The run log for external apps (M4 A-6) — this store fills in the app runtime's `RunLedger` ──
  //
  // The runtime does not import this class. The runtime declares the shape it needs (RunLedger),
  // and main.ts passes these methods in as that shape (inverting the dependency from #97).

  beginAppRun(r: AppRunRecord): void {
    this.db
      .prepare(
        `INSERT INTO app_runs (id, project_id, app_id, kind, tool, caller_kind, caller_session_id, parent_run_id,
                               status, duration_ms, args_digest, args_summary, error, created_at, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.id, r.projectId, r.appId, r.kind, r.tool, r.callerKind, r.callerSessionId, r.parentRunId,
        r.status, r.durationMs, r.argsDigest, r.argsSummary, r.error, r.createdAt, r.sessionId,
      )
  }

  /** Links a running run_agent row to the session that request set up (M4 D-6) */
  linkAppRunSession(id: string, sessionId: string): void {
    this.db.prepare(`UPDATE app_runs SET session_id = ? WHERE id = ?`).run(sessionId, id)
  }

  /**
   * Closes a run. `agent` is a run_agent row's request and answer (#378), already masked, with the structured output
   * as JSON text: kept on the row, so the run says what it was asked and what it answered after its session is gone.
   */
  endAppRun(
    id: string,
    end: {
      status: string
      durationMs: number
      error: string | null
      tokens?: { input: number; output: number } | null
      agent?: { request: string; answer: string | null; output: string | null } | null
    },
  ): void {
    this.db
      .prepare(
        `UPDATE app_runs SET status = ?, duration_ms = ?, error = ?, tokens_in = ?, tokens_out = ?,
                             request = coalesce(?, request), answer = coalesce(?, answer), output = coalesce(?, output) WHERE id = ?`,
      )
      .run(
        end.status, end.durationMs, end.error, end.tokens?.input ?? null, end.tokens?.output ?? null,
        end.agent?.request ?? null, end.agent?.answer ?? null, end.agent?.output ?? null, id,
      )
  }

  /** One run as the record of a deleted app-agent session reads it (#378); null when the run is not in the log */
  appRun(id: string): (AppRunRecord & { tokens: { input: number; output: number } | null; request: string | null; answer: string | null; output: string | null }) | null {
    const r = this.db
      .prepare<unknown[], (AppRunRecord & { tokensIn: number | null; tokensOut: number | null; request: string | null; answer: string | null; output: string | null })>(
        `SELECT id, project_id as projectId, app_id as appId, kind, tool, caller_kind as callerKind,
                caller_session_id as callerSessionId, parent_run_id as parentRunId, status, duration_ms as durationMs,
                args_digest as argsDigest, args_summary as argsSummary, error, created_at as createdAt, session_id as sessionId,
                tokens_in as tokensIn, tokens_out as tokensOut, request, answer, output
         FROM app_runs WHERE id = ?`,
      )
      .get(id)
    if (!r) return null
    const { tokensIn, tokensOut, ...rest } = r
    return { ...rest, tokens: tokensIn === null ? null : { input: tokensIn, output: tokensOut ?? 0 } }
  }

  /**
   * How much of the agents an app requested since `since` were used (M4 D-5) — only run_agent
   * rows that had a session stand up (a rejected request never set an agent up). A still-running
   * row is counted, but its duration is not in yet. A row whose session is gone counts by its kept
   * request (#378: written only once a session stood up, and left empty when its record is deleted).
   */
  appAgentUse(projectId: string | null, appId: string, since: number): AgentUse {
    const r = oneRow(
      this.db
      .prepare<unknown[], { runs: number; durationMs: number; counted: number; input: number; output: number }>(
        `SELECT COUNT(*) as runs, COALESCE(SUM(duration_ms), 0) as durationMs, COUNT(tokens_in) as counted,
                COALESCE(SUM(tokens_in), 0) as input, COALESCE(SUM(tokens_out), 0) as output
         FROM app_runs
         WHERE app_id = ? AND project_id IS ? AND kind = 'broker' AND tool = 'run_agent' AND (session_id IS NOT NULL OR request IS NOT NULL) AND created_at >= ?`,
      )
      .get(appId, projectId, since),
    )
    return { runs: r.runs, durationMs: r.durationMs, tokens: r.counted > 0 ? { input: r.input, output: r.output } : null }
  }

  /**
   * Keeps the raw text of a failure, but only the **most recent `keep`** for that app. The raw
   * text is large and rarely read — what an agent building the app needs to fix it is the last
   * handful of failures, not all of them.
   */
  keepAppRunFailure(f: { runId: string; projectId: string | null; appId: string; args: string; result: string | null; createdAt: number }, keep: number): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(`INSERT OR REPLACE INTO app_run_failures (run_id, project_id, app_id, args, result, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(f.runId, f.projectId, f.appId, f.args, f.result, f.createdAt)
      this.db
        .prepare(
          `DELETE FROM app_run_failures WHERE app_id = ? AND project_id IS ? AND run_id NOT IN (
             SELECT run_id FROM app_run_failures WHERE app_id = ? AND project_id IS ? ORDER BY created_at DESC, rowid DESC LIMIT ?
           )`,
        )
        .run(f.appId, f.projectId, f.appId, f.projectId, keep)
    })
    tx()
  }

  /**
   * One app's run log, most recent first — **including the chain beneath each row** (M4 D-6).
   * A failure whose raw text is still kept is returned with it.
   *
   * A root is one of this app's rows whose parent is not also one of this app's rows (called
   * from the UI or a session, called by a different app, or requested with no open run at all).
   * `limit` counts roots. Everything below a root is included by following parent links down —
   * rows for other apps this app called, down to the rows for agents that app in turn requested.
   * That is what lets a single history screen read "what the UI clicked → another app → an
   * agent" as one chain. Rows below the roots are capped at `CHAIN_ROWS_MAX`, so an app that
   * makes requests without end inside a single call cannot hold the screen hostage.
   */
  listAppRuns(
    projectId: string | null,
    appId: string,
    limit: number,
  ): (AppRunRecord & { tokens: { input: number; output: number } | null; failure: { args: string; result: string | null } | null; kept: boolean })[] {
    const rows = this.db
      .prepare<unknown[], (AppRunRecord & {
      tokensIn: number | null
      tokensOut: number | null
      failureArgs: string | null
      failureResult: string | null
      kept: number
      seq: number
      isRoot: number
    })>(
        `WITH RECURSIVE
           roots(id) AS (
             SELECT r.id FROM app_runs r
             WHERE r.app_id = ? AND r.project_id IS ?
               AND NOT EXISTS (SELECT 1 FROM app_runs p WHERE p.id = r.parent_run_id AND p.app_id = r.app_id AND p.project_id IS r.project_id)
             ORDER BY r.created_at DESC, r.rowid DESC LIMIT ?
           ),
           chain(id) AS (
             SELECT id FROM roots
             UNION
             SELECT c.id FROM app_runs c JOIN chain ON c.parent_run_id = chain.id
           )
         SELECT r.id, r.project_id as projectId, r.app_id as appId, r.kind, r.tool, r.caller_kind as callerKind,
                r.caller_session_id as callerSessionId, r.parent_run_id as parentRunId, r.status,
                r.duration_ms as durationMs, r.args_digest as argsDigest, r.args_summary as argsSummary,
                r.error, r.created_at as createdAt, r.session_id as sessionId, r.tokens_in as tokensIn, r.tokens_out as tokensOut,
                f.args as failureArgs, f.result as failureResult,
                /* the record of a deleted app-agent session (#378), in the trash */
                EXISTS (SELECT 1 FROM app_run_records k WHERE k.run_id = r.id) as kept,
                r.rowid as seq, r.id IN (SELECT id FROM roots) as isRoot
         FROM app_runs r LEFT JOIN app_run_failures f ON f.run_id = r.id
         WHERE r.id IN (SELECT id FROM chain)
         ORDER BY isRoot DESC, r.created_at DESC, r.rowid DESC LIMIT ?`,
      )
      .all(appId, projectId, limit, limit + CHAIN_ROWS_MAX)
    // Filling roots first was only the order used for truncation — what is returned is chronological (most recent first)
    rows.sort((a, b) => b.createdAt - a.createdAt || b.seq - a.seq)
    return rows.map(({ failureArgs, failureResult, tokensIn, tokensOut, kept, seq: _seq, isRoot: _isRoot, ...r }) => ({
      ...r,
      kept: !!kept,
      tokens: tokensIn === null ? null : { input: tokensIn, output: tokensOut ?? 0 },
      failure: failureArgs === null ? null : { args: failureArgs, result: failureResult },
    }))
  }

  /**
   * Removes run records outside the retention window, the kept records of deleted app-agent sessions with them (#378:
   * the trash keeps those for the run log's own 30 days). @returns the number of runs deleted
   */
  pruneAppRuns(before: number): number {
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM app_run_messages WHERE run_id IN (SELECT run_id FROM app_run_records WHERE started_at < ?)`).run(before)
      this.db.prepare(`DELETE FROM app_run_subagent_messages WHERE run_id IN (SELECT run_id FROM app_run_records WHERE started_at < ?)`).run(before)
      this.db.prepare(`DELETE FROM app_run_records WHERE started_at < ?`).run(before)
      this.db.prepare(`DELETE FROM app_run_failures WHERE created_at < ?`).run(before)
      return this.db.prepare(`DELETE FROM app_runs WHERE created_at < ?`).run(before).changes
    })
    return tx()
  }

  /**
   * Closes out runs that never saw an end (once, at startup). When the host dies, the app
   * process's input also closes and it ends — a row left at `running` would look like it is
   * running forever. The same reasoning as fixing session state at startup (`manager.ts`'s
   * LIVE_ONLY): a "live" state is only true while a process backs it.
   */
  settleUnfinishedAppRuns(error: string): number {
    return this.db.prepare(`UPDATE app_runs SET status = 'error', error = ? WHERE status = 'running'`).run(error).changes
  }
}
