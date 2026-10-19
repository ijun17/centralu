import type Database from 'better-sqlite3'
import type { WorktreeRecovery } from '../worktree-recovery.js'
import type { SessionInfo } from '@cc/protocol'
import { indexedText } from './search-index.js'
import { type SessionRecords } from './sessions.js'
import { asObj, filled, isObj } from '../../json-value.js'
import { parseJson } from './json.js'
import { SESSION_SETTING_OF } from './settings.js'

/**
 * What a session in the trash remembers (`sessions.trash`, #204).
 *
 *   projectId, projectName, projectPath   where it came from. A trashed session has no `project_id` (see
 *                                         `trashSession`), and its project may be deleted meanwhile; restoring
 *                                         then registers the folder again under the same id
 *   removeExternal   delete the tool's own conversation file (Claude JSONL, Codex rollout) when deleted for good
 *   removeWorktree   remove the session's worktree when deleted for good
 */
export type TrashRecord = {
  projectId: string | null
  projectName: string | null
  projectPath: string | null
  removeExternal: boolean
  removeWorktree: boolean
  recovery?: WorktreeRecovery
}

/** One row of `listTrash` */
export type TrashedRow = {
  id: string
  name: string
  tool: string
  deletedAt: number
  messages: number
  bytes: number
  /** The tool knows this conversation by an id of its own — there is a file of the tool's to keep or delete */
  hasConversationFile: boolean
  record: TrashRecord
  worktree: { path: string; branch: string } | null
}

/** A record written by an older or broken build reads as "keep everything" — deleting for good must be asked for */
function parseTrashRecord(json: string | null): TrashRecord {
  // Unreadable, or JSON that is not an object (#850): the defaults below keep the files
  const r: Partial<Record<keyof TrashRecord, unknown>> = asObj(parseJson(json))
  return {
    projectId: filled(r.projectId),
    projectName: filled(r.projectName),
    projectPath: filled(r.projectPath),
    removeExternal: r.removeExternal === true,
    removeWorktree: r.removeWorktree === true,
    ...(isObj(r.recovery) &&
      typeof (r.recovery as WorktreeRecovery).snapshot === 'string' &&
      typeof (r.recovery as WorktreeRecovery).tip === 'string' &&
      typeof (r.recovery as WorktreeRecovery).changedFiles === 'number' &&
      typeof (r.recovery as WorktreeRecovery).commits === 'number'
      ? { recovery: r.recovery as WorktreeRecovery } : {}),
  }
}

/**
 * One chunk of a session deletion (#179). Removing one index row from the real database took
 * about 0.064ms (1,774ms for 27,887 rows), so 250 rows keeps one chunk under about 20ms. Cutting
 * it finer would only add more commits and lengthen the total time.
 */
const DELETE_CHUNK = 250

/** The trash (#204): moving a session out of the live list and back, deleting it for good, and deleting a project */
export class TrashRecords {
  constructor(private readonly db: Database.Database, private readonly sessions: SessionRecords) {}

  // ── The trash (#204) ──
  //
  // Deleting a session moves it here; only Settings removes it for good. While it is here its rows stay as they
  // were, except its search index, which is dropped: no search and no agent's `recall` can reach it, and the index is
  // the larger half of the store (71MB of 137MB, measured for #96). Restoring rebuilds the index from the messages.

  /**
   * Moves a live session into the trash. `record` carries where it came from and what the person chose to remove
   * with it once it is deleted for good. Returns false when there was no live session to move.
   *
   * The session leaves every listing in the first transaction: `deleted_at` is set before anything slow runs. It
   * also leaves its project: `project_id` becomes NULL and the project is kept in `record`. That is what lets a
   * project be deleted while its sessions sit in the trash — `sessions.project_id` cascades a project delete (FK), so
   * a session still pointing at the project would be destroyed with it. The grid panel goes too: it is layout, not a
   * record, and a restored session is opened from the sidebar.
   *
   * The index rows are then dropped in chunks, letting the event loop go between them (#179: the biggest session in
   * a copy of the real store held 32,323 index rows, and dropping them in one transaction froze the host for 2.9s).
   * If the host stops halfway, the session is in the trash with part of its index left; searches still skip it
   * (`searchMessages` filters the trash), and restoring or purging finishes the job.
   */
  async trashSession(sessionId: string, record: TrashRecord, chunk = DELETE_CHUNK): Promise<boolean> {
    const move = this.db.transaction((): boolean => {
      const moved = this.db
        .prepare(`UPDATE sessions SET deleted_at = ?, trash = ?, project_id = NULL WHERE id = ? AND deleted_at IS NULL`)
        .run(Date.now(), JSON.stringify(record), sessionId).changes
      if (moved === 0) return false
      // Both lists: this build's, and the one an older host still reads (v42)
      this.db.prepare(`DELETE FROM grid_panels WHERE session_id = ?`).run(sessionId)
      this.db.prepare(`DELETE FROM grid_layout WHERE session_id = ?`).run(sessionId)
      return true
    })
    if (!move()) return false
    const dropFts = this.db.prepare(`DELETE FROM messages_fts WHERE rowid = ?`)
    await this.walkMessages(sessionId, chunk, false, (rows) => {
      for (const r of rows) dropFts.run(r.rowid)
    })
    return true
  }

  /**
   * Takes a session out of the trash into `projectId` (null for one that had no project). Returns null when it was
   * not in the trash.
   *
   * The index is rebuilt first, in chunks, and the session becomes live only in the last step. A restore cut short
   * therefore leaves it in the trash with part of its index, which the search filter hides and the next restore
   * overwrites (the index row is keyed by the message's rowid, so writing it again replaces it).
   */
  async restoreSession(sessionId: string, projectId: string | null, chunk = DELETE_CHUNK): Promise<SessionInfo | null> {
    if (!this.isTrashed(sessionId)) return null
    const put = this.db.prepare(`INSERT OR REPLACE INTO messages_fts (rowid, body, session_id, seq) VALUES (?, ?, ?, ?)`)
    const drop = this.db.prepare(`DELETE FROM messages_fts WHERE rowid = ?`)
    await this.walkMessages(sessionId, chunk, true, (rows) => {
      for (const r of rows) {
        const body = indexedText(r.kind ?? '', r.payload ?? '')
        if (body) put.run(r.rowid, body, sessionId, r.seq)
        else drop.run(r.rowid)
      }
    })
    const back = this.db
      .prepare(`UPDATE sessions SET deleted_at = NULL, trash = NULL, project_id = ? WHERE id = ? AND deleted_at IS NOT NULL`)
      .run(projectId, sessionId).changes
    if (back === 0) return null
    return this.sessions.readSessions(`s.id = ? AND s.deleted_at IS NULL`, sessionId)[0] ?? null
  }

  /**
   * Deletes a session in the trash for good. It is the only way a session's rows leave the store, and it takes only
   * a session already in the trash: a live one has to be moved there first, so nothing skips the way back.
   *
   * Everything that points at the session goes with it: its messages and whatever is left of their index, the steps
   * of the subagents it launched (`subagent_messages`, #222), its approval rules, its commit links (`commit_sessions` — #96 found 57 of 304 links pointing at sessions that no
   * longer existed, because deleting used to leave them behind). The app runs it started or ran in stay in their app's
   * run log with the link cleared (`app_runs.session_id` / `caller_session_id`, #378): until then purging an app-agent
   * session erased its run, and purging a session that called an app erased those calls, from the app's history.
   *
   * Chunked like `trashSession` (#179: on the same copy of the real store the longest pause went from 2.9s to 84ms;
   * the whole took 4.1s, with the event loop turning 231 times). The rows that are not messages, and the session row, go in the same
   * transaction as the last chunk, so a purge cut short leaves the session in the trash with fewer messages, to be
   * purged again, and never messages without a session.
   *
   * The settings kept per session go too, all of them by their shape (`SESSION_SETTING_OF`) rather than by name: the
   * purge used to name two of them, and every key added since stayed behind for good (a process's tool prefix and launch
   * settings, its fresh-start mark, its last import, a paused report).
   */
  async purgeSession(sessionId: string, chunk = DELETE_CHUNK): Promise<boolean> {
    if (!this.isTrashed(sessionId)) return false
    const pick = this.db.prepare(`SELECT rowid FROM messages WHERE session_id = ? LIMIT ?`)
    const dropFts = this.db.prepare(`DELETE FROM messages_fts WHERE rowid = ?`)
    const dropMsg = this.db.prepare(`DELETE FROM messages WHERE rowid = ?`)
    // A subagent's steps (#222) go first, in the same chunks: they can outnumber the conversation's own rows
    const pickSub = this.db.prepare(`SELECT rowid FROM subagent_messages WHERE session_id = ? LIMIT ?`)
    const dropSub = this.db.prepare(`DELETE FROM subagent_messages WHERE rowid = ?`)
    const step = this.db.transaction((): boolean => {
      const subs = pickSub.all(sessionId, chunk) as { rowid: number }[]
      for (const { rowid } of subs) dropSub.run(rowid)
      if (subs.length === chunk) return false
      const rows = pick.all(sessionId, chunk) as { rowid: number }[]
      for (const { rowid } of rows) {
        dropFts.run(rowid)
        dropMsg.run(rowid)
      }
      if (rows.length === chunk) return false
      this.db.prepare(`DELETE FROM approval_rules WHERE session_id = ?`).run(sessionId)
      this.db.prepare(`DELETE FROM commit_sessions WHERE session_id = ?`).run(sessionId)
      this.db.prepare(`UPDATE app_runs SET session_id = NULL WHERE session_id = ?`).run(sessionId)
      this.db.prepare(`UPDATE app_runs SET caller_session_id = NULL WHERE caller_session_id = ?`).run(sessionId)
      this.db.prepare(`DELETE FROM report_marks WHERE session_id = ? OR caller_session_id = ?`).run(sessionId, sessionId)
      this.db.prepare(`DELETE FROM agent_start_requests WHERE caller_session_id = ?`).run(sessionId)
      this.db.prepare(`DELETE FROM delegated_turns WHERE session_id = ? OR caller_session_id = ?`).run(sessionId, sessionId)
      this.db.prepare(`DELETE FROM queued_requests WHERE session_id = ? OR caller_session_id = ?`).run(sessionId, sessionId)
      // Every setting kept for it (`<name>:<sessionId>`, `SESSION_SETTING_OF` in store/settings.ts)
      this.db.prepare(`DELETE FROM app_settings WHERE ${SESSION_SETTING_OF}`).run({ sessionId })
      this.db.prepare(`DELETE FROM sessions WHERE id = ? AND deleted_at IS NOT NULL`).run(sessionId)
      return true
    })
    while (!step()) await new Promise<void>((resolve) => setImmediate(resolve))
    return true
  }

  /** One session's messages in seq order, one transaction per chunk, letting the event loop go between chunks (#179) */
  private async walkMessages(
    sessionId: string,
    chunk: number,
    withPayload: boolean,
    each: (rows: { rowid: number; seq: number; kind?: string; payload?: string }[]) => void,
  ): Promise<void> {
    const pick = this.db.prepare(
      `SELECT rowid, seq${withPayload ? ', kind, payload' : ''} FROM messages WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
    )
    let after = Number.MIN_SAFE_INTEGER
    const step = this.db.transaction((): boolean => {
      const rows = pick.all(sessionId, after, chunk) as { rowid: number; seq: number; kind?: string; payload?: string }[]
      each(rows)
      if (rows.length > 0) after = rows[rows.length - 1]!.seq
      return rows.length < chunk
    })
    while (!step()) await new Promise<void>((resolve) => setImmediate(resolve))
  }

  /**
   * A trashed session keeps the tool's conversation file when deleted for good (#378 review). A delete the person asked
   * for while the host's own was under way ends in the trash, with the person's choice: the host's had chosen to
   * delete the file, which only the person may.
   */
  keepConversationFile(sessionId: string): void {
    this.db
      .prepare(`UPDATE sessions SET trash = json_set(trash, '$.removeExternal', json('false')) WHERE id = ? AND deleted_at IS NOT NULL AND json_valid(trash)`)
      .run(sessionId)
  }

  isTrashed(sessionId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM sessions WHERE id = ? AND deleted_at IS NOT NULL`).get(sessionId)
  }

  /** The ids in the trash — for the few callers that must tell "in the trash" from "gone" */
  trashedIds(): Set<string> {
    const rows = this.db.prepare(`SELECT id FROM sessions WHERE deleted_at IS NOT NULL`).all() as { id: string }[]
    return new Set(rows.map((r) => r.id))
  }

  /** A session in the trash as it will come back, with its record — null when it is not in the trash */
  trashedSession(sessionId: string): { session: SessionInfo; record: TrashRecord; deletedAt: number } | null {
    const session = this.sessions.readSessions(`s.id = ? AND s.deleted_at IS NOT NULL`, sessionId)[0]
    if (!session) return null
    const row = this.db.prepare(`SELECT deleted_at as deletedAt, trash FROM sessions WHERE id = ?`).get(sessionId) as {
      deletedAt: number
      trash: string | null
    }
    return { session, record: parseTrashRecord(row.trash), deletedAt: row.deletedAt }
  }

  /**
   * Whether the trash holds a session of this project (its record names it): restoring one registers the project
   * again, under the same id and at the same path (`SessionTrash.restoreSession`), so what the project needs to come
   * back has to stay while this is true (#1204)
   */
  holdsProject(projectId: string): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM sessions
          WHERE deleted_at IS NOT NULL AND json_valid(trash) AND json_extract(trash, '$.projectId') = ? LIMIT 1`,
      )
      .get(projectId)
  }

  /**
   * What is in the trash, most recently deleted first, with how much of the store each one holds: the bytes of its
   * messages (the index is already gone). Settings shows the total, because nothing empties the trash on its own.
   * Measured on a copy of the real store (135,828 messages): summing every session's messages takes about 40ms.
   */
  listTrash(): TrashedRow[] {
    const rows = this.db
      .prepare(
        `SELECT s.id, s.name, s.tool, s.deleted_at as deletedAt, s.trash as trash,
                s.worktree_path as worktreePath, s.worktree_branch as worktreeBranch,
                (s.external_id IS NOT NULL OR s.imported_from IS NOT NULL) as hasConversationFile,
                COUNT(m.seq) as messages,
                COALESCE(SUM(LENGTH(CAST(m.payload AS BLOB))), 0)
                  /* a subagent's steps (#222) are part of what it holds, though not of its message count */
                  + COALESCE((SELECT SUM(LENGTH(CAST(sm.payload AS BLOB))) FROM subagent_messages sm WHERE sm.session_id = s.id), 0) as bytes
         FROM sessions s LEFT JOIN messages m ON m.session_id = s.id
         WHERE s.deleted_at IS NOT NULL GROUP BY s.id ORDER BY s.deleted_at DESC`,
      )
      .all() as (Omit<TrashedRow, 'record' | 'worktree' | 'hasConversationFile'> & {
      hasConversationFile: number
      trash: string | null
      worktreePath: string | null
      worktreeBranch: string | null
    })[]
    return rows.map(({ trash, worktreePath, worktreeBranch, hasConversationFile, ...r }) => ({
      ...r,
      hasConversationFile: !!hasConversationFile,
      record: parseTrashRecord(trash),
      worktree: worktreePath ? { path: worktreePath, branch: worktreeBranch ?? '' } : null,
    }))
  }

  /**
   * Deletes a project. Its sessions go to the trash (#204), not with it.
   *
   * The manager moves each session to the trash first (`SessionManager.deleteProject`), which also stops its
   * process. This step catches any live row that did not get there, in the same transaction as the project row, so
   * deleting a project cannot destroy a conversation. Such a row is marked to keep the tool's conversation file and
   * the worktree: nobody was asked about them.
   *
   * **This does not rely on an FK's CASCADE.** `messages_fts` is a virtual table with no foreign key at all, so the index rows
   * of a session caught here are dropped by hand — a session in the trash must not turn up in a search.
   *
   * The rows that belong to the project go with it as before: project-scope rules, the answers given to its apps, and
   * the app runs and commit links that point at no session still here. Rows that point at a session in the trash stay with that session until it is
   * deleted for good: its own rules, its commit links, the app runs it started or ran in. A restore that registers
   * the folder again under the same id finds them where they were.
   */
  deleteProject(projectId: string): void {
    const tx = this.db.transaction(() => {
      const project = this.db.prepare(`SELECT name, path FROM projects WHERE id = ?`).get(projectId) as
        | { name: string; path: string }
        | undefined
      const record: TrashRecord = {
        projectId,
        projectName: project?.name ?? null,
        projectPath: project?.path ?? null,
        removeExternal: false,
        removeWorktree: false,
      }
      const left = this.db.prepare(`SELECT id FROM sessions WHERE project_id = ? AND deleted_at IS NULL`).all(projectId) as {
        id: string
      }[]
      for (const { id } of left) {
        this.db.prepare(`DELETE FROM messages_fts WHERE rowid IN (SELECT rowid FROM messages WHERE session_id = ?)`).run(id)
        this.db
          .prepare(`UPDATE sessions SET deleted_at = ?, trash = ?, project_id = NULL WHERE id = ? AND deleted_at IS NULL`)
          .run(Date.now(), JSON.stringify(record), id)
        this.db.prepare(`DELETE FROM grid_panels WHERE session_id = ?`).run(id)
        this.db.prepare(`DELETE FROM grid_layout WHERE session_id = ?`).run(id)
      }
      // The project's apps leave the grid with it: layout, like a session's panel
      this.db.prepare(`DELETE FROM grid_layout WHERE kind = 'app' AND project_id = ?`).run(projectId)
      this.db
        .prepare(
          `/* includes the trash: a rule of a session in the trash stays with it */
           DELETE FROM approval_rules WHERE project_id = ? AND (session_id IS NULL OR session_id NOT IN (SELECT id FROM sessions))`,
        )
        .run(projectId)
      this.db
        .prepare(
          `/* includes the trash: a commit link of a session in the trash stays with it */
           DELETE FROM commit_sessions WHERE project_id = ? AND session_id NOT IN (SELECT id FROM sessions)`,
        )
        .run(projectId)
      // The run log for that project's apps is part of this deletion too (M4 A-6) — a run that points at a session in the trash stays with it
      this.db
        .prepare(
          `/* includes the trash: a run of a session in the trash stays with it */
           DELETE FROM app_runs WHERE project_id = ?
             AND (session_id IS NULL OR session_id NOT IN (SELECT id FROM sessions))
             AND (caller_session_id IS NULL OR caller_session_id NOT IN (SELECT id FROM sessions))`,
        )
        .run(projectId)
      this.db.prepare(`DELETE FROM app_run_failures WHERE project_id = ? AND run_id NOT IN (SELECT id FROM app_runs)`).run(projectId)
      // Answers given to that project's apps' capabilities too (M4 D-4) — a folder registered again, even under the same id by a restore, is asked again
      this.db.prepare(`DELETE FROM app_permissions WHERE project_id = ?`).run(projectId)
      this.db.prepare(`DELETE FROM projects WHERE id = ?`).run(projectId)
    })
    tx()
  }
}
