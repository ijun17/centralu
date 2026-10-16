import type Database from 'better-sqlite3'
import type { SessionInfo } from '@cc/protocol'
import { Interruption as InterruptionSchema, sessionLiveDefaults } from '@cc/protocol'
import { z } from 'zod'
import { readJson, readJsonList } from './json.js'

/** The sessions table: one row per session, how a row becomes a `SessionInfo`, and what the host keeps on a session besides it (its directory, touched paths, read mark, commit links) */
export class SessionRecords {
  constructor(private readonly db: Database.Database) {}

  /**
   * The UPDATE clause has to list **everything that can change.**
   * It used to be missing tool, so switching agents (claude to codex) was never saved — on
   * restart the tool reverted, but by then the thread to resume from (external_id) had already
   * broken, turning the session into one that could not even be recovered. (project_id and
   * created_at do not change, by definition.)
   */
  upsertSession(s: SessionInfo): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, project_id, tool, external_id, name, auto_named, state, is_orchestrator, last_read_seq, waiting_since, created_at, model, effort, verbosity, service_tier, permission_preset, imported_from, worktree_path, worktree_branch, worktree_base, parent_session_id, scope_session_ids, role_append, app_id, asked_by_session_id, forked_from_session_id, context_used, context_window, context_exactness, interruption)
         VALUES (@id, @projectId, @tool, @externalId, @name, @autoNamed, @state, @isOrchestrator, @lastReadSeq, @waitingSince, @createdAt, @model, @effort, @verbosity, @serviceTier, @permissionPreset, @importedFrom, @worktreePath, @worktreeBranch, @worktreeBase, @parentSessionId, @scopeSessionIds, @roleAppend, @appId, @askedBy, @forkedFrom, @contextUsed, @contextWindow, @contextExactness, @interruption)
         ON CONFLICT(id) DO UPDATE SET
           tool = excluded.tool,
           external_id = excluded.external_id, name = excluded.name, auto_named = excluded.auto_named,
           state = excluded.state, last_read_seq = excluded.last_read_seq,
           is_orchestrator = excluded.is_orchestrator,
           waiting_since = excluded.waiting_since, model = excluded.model, effort = excluded.effort,
           verbosity = excluded.verbosity,
           service_tier = excluded.service_tier,
           permission_preset = excluded.permission_preset, imported_from = excluded.imported_from,
           worktree_path = excluded.worktree_path, worktree_branch = excluded.worktree_branch,
           worktree_base = excluded.worktree_base,
           parent_session_id = excluded.parent_session_id,
           scope_session_ids = excluded.scope_session_ids,
           role_append = excluded.role_append,
           app_id = excluded.app_id,
           asked_by_session_id = excluded.asked_by_session_id,
           forked_from_session_id = excluded.forked_from_session_id,
           context_used = excluded.context_used, context_window = excluded.context_window,
           context_exactness = excluded.context_exactness,
           interruption = excluded.interruption`,
      )
      .run({
        ...s,
        autoNamed: s.autoNamed ? 1 : 0,
        // The marker (#13) rides the ordinary upsert too — with two write paths, only one would end up fixed
        isOrchestrator: s.kind === 'orchestrator' ? 1 : 0,
        effort: s.effort ?? null,
        verbosity: s.verbosity ?? null,
        serviceTier: s.serviceTier ?? null,
        importedFrom: s.importedFrom ?? null,
        worktreePath: s.worktree?.path ?? null,
        worktreeBranch: s.worktree?.branch ?? null,
        worktreeBase: s.worktree?.base ?? null,
        parentSessionId: s.parentSessionId ?? null,
        // Visibility is flattened into a JSON array (#80, #81) — the relationship lives in the row (lesson of the orphan)
        scopeSessionIds: s.scopeSessionIds ? JSON.stringify(s.scopeSessionIds) : null,
        roleAppend: s.roleAppend ?? null,
        appId: s.appId ?? null,
        askedBy: s.askedBy ?? null,
        forkedFrom: s.forkedFrom ?? null,
        /*
         * Context rides the ordinary upsert (issue #48), which the manager already runs after
         * every event — so a reading is on disk the instant it arrives, with no second write
         * path to remember. Saving at session close instead would lose exactly the sessions
         * that matter: the ones a crash or a force-quit ends.
         */
        contextUsed: s.context?.used ?? null,
        contextWindow: s.context?.window ?? null,
        contextExactness: s.context?.exactness ?? null,
        // `reconnecting` describes the running process and is not kept (#698)
        interruption: s.interruption && s.interruption.reason !== 'reconnecting' ? JSON.stringify(s.interruption) : null,
      })
  }

  setSessionOrder(orderedIds: readonly string[]): void {
    const stmt = this.db.prepare(`UPDATE sessions SET sidebar_order = ? WHERE id = ?`)
    this.db.transaction(() => orderedIds.forEach((id, i) => stmt.run(i, id)))()
  }

  /**
   * The id of the **central** orchestrator (null if there is none).
   *
   * There used to be only one orchestrator per app, so this query was the whole answer. Once
   * project orchestrators existed (#13), the marker (is_orchestrator=1) could be set on more
   * than one row, and the central one is whichever of those has no project. The marker itself
   * rides SessionInfo.kind through the ordinary upsert — at one point this was the only place
   * that answered, on the reasoning that "keeping it in two places lets one drift out of sync,"
   * but the project orchestrator broke the premise that reasoning relied on (that projectId
   * being null was the same fact as the marker), so kind is now the single source of truth and
   * this query just reads it.
   */
  orchestratorId(): string | null {
    /*
     * A trashed session has no project (see `trashSession`), so without the filter a trashed project orchestrator
     * would answer here as the central one.
     */
    const row = this.db
      .prepare(`SELECT id FROM sessions WHERE is_orchestrator = 1 AND project_id IS NULL AND deleted_at IS NULL LIMIT 1`)
      .get() as { id: string } | undefined
    return row?.id ?? null
  }

  /** Live sessions only — the trash (#204) is listed by `listTrash` and nowhere else */
  listSessions(): SessionInfo[] {
    return this.readSessions(`s.deleted_at IS NULL`)
  }

  /** The rows of `listSessions`, for any condition on `sessions s` — the one place a row becomes a `SessionInfo` */
  readSessions(where: string, ...params: unknown[]): SessionInfo[] {
    const rows = this.db
      .prepare(
        `SELECT s.id, s.project_id as projectId, s.tool, s.external_id as externalId, s.name,
                s.auto_named as autoNamed, s.state, s.is_orchestrator as isOrchestrator,
                s.last_read_seq as lastReadSeq,
                s.waiting_since as waitingSince, s.created_at as createdAt,
                s.model, s.effort, s.verbosity, s.service_tier as serviceTier, s.permission_preset as permissionPreset, s.imported_from as importedFrom,
                s.worktree_path as worktreePath, s.worktree_branch as worktreeBranch,
                s.worktree_base as worktreeBase,
                s.parent_session_id as parentSessionId,
                s.scope_session_ids as scopeSessionIdsJson, s.role_append as roleAppend, s.app_id as appId,
                s.asked_by_session_id as askedBy,
                s.forked_from_session_id as forkedFrom,
                s.context_used as contextUsed, s.context_window as contextWindow,
                s.context_exactness as contextExactness,
                s.interruption as interruptionJson,
                COALESCE((SELECT MAX(seq) FROM messages m WHERE m.session_id = s.id), 0) as lastSeq
         FROM sessions s WHERE ${where} ORDER BY s.sidebar_order, s.created_at`,
      )
      .all(...params) as (Omit<SessionInfo, 'autoNamed' | 'worktree' | 'kind'> & {
      autoNamed: number
      isOrchestrator: number
      worktreePath: string | null
      worktreeBranch: string | null
      worktreeBase: string | null
      contextUsed: number | null
      contextWindow: number | null
      contextExactness: string | null
      scopeSessionIdsJson: string | null
      interruptionJson: string | null
    })[]
    // Live-only fields are not in the database — a restored session correctly has none of them (facts that die with the host)
    return rows.map(
      ({
        worktreePath,
        worktreeBranch,
        worktreeBase,
        contextUsed,
        contextWindow,
        contextExactness,
        isOrchestrator,
        scopeSessionIdsJson,
        interruptionJson,
        ...r
      }) => ({
        ...r,
        autoNamed: !!r.autoNamed,
        /*
         * Whether a session coordinates is also relational (#80, #81): having a visibility list
         * makes it a coordinating session — a separate marker column would eventually drift out
         * of sync with the relationship it is meant to reflect (the lesson of #13).
         */
        kind: isOrchestrator
          ? ('orchestrator' as const)
          : scopeSessionIdsJson
            ? ('coordinator' as const)
            : ('worker' as const),
        // An unreadable list is a coordinator that sees no session: it grants nothing, and fails no other row (#850)
        scopeSessionIds: scopeSessionIdsJson ? readJsonList(scopeSessionIdsJson, z.string()) : null,
        live: false,
        worktree: worktreePath
          ? {
              path: worktreePath,
              branch: worktreeBranch ?? '',
              ...(worktreeBase ? { base: worktreeBase } : {}),
            }
          : null,
        ...sessionLiveDefaults(),
        /*
         * **Context is the one that comes back** (issue #48), so it overrules the defaults above.
         *
         * The rest of that group are facts about *our* process — a request id nobody can answer
         * any more, a rate-limit window that expired while we were gone — and are rightly gone
         * with it. How full the context is, is not: it is a fact about the conversation, and the
         * conversation is the tool's and outlives us.
         *
         * It is shown plainly, with no staleness mark, and that is a decision rather than an
         * omission. The gauge has never claimed to be live — the reading arrives at the end of a
         * turn and is already a turn behind while the next one runs; restarting only lengthens a
         * gap that is always there. The event that really makes it wrong is the conversation
         * moving without us (someone continuing it in the terminal), which can happen with or
         * without a restart and which we cannot detect either way. A mark keyed on "we
         * restarted" would therefore flag the common case, where nothing moved and the number is
         * exact, and stay silent in the case that actually earns it. The first turn corrects it
         * regardless — at the very instant the old behaviour would have shown anything at all.
         */
        context:
          contextUsed !== null && contextWindow !== null
            ? {
                used: contextUsed,
                window: contextWindow,
                // Only the adapter can claim 'exact'; anything we cannot read back says 'estimate'
                exactness: contextExactness === 'exact' ? ('exact' as const) : ('estimate' as const),
              }
            : null,
        // Why the last turn did not finish (#698); a value this build cannot read is no interruption rather than a lost row
        interruption: readJson(interruptionJson, InterruptionSchema.nullable(), null),
      }),
    )
  }

  /**
   * The directory this session was created in — the one its tool-side history is filed under.
   *
   * Deliberately **not** part of `SessionInfo`: it is not something the screen shows, and
   * `upsertSession` must never carry it. The whole point (issue #28) is that this value is
   * written once and then left alone; routing it through the same upsert that saves names and
   * states would let any later save quietly replace it with whatever the caller happened to
   * hold. `touched_paths` lives on the same terms.
   *
   * null means "we do not know yet" — an orchestrator row that predates v14. The manager
   * resolves it the first time it needs the path and writes it back.
   */
  sessionCwd(sessionId: string): string | null {
    const row = this.db.prepare(`SELECT cwd FROM sessions WHERE id = ?`).get(sessionId) as
      { cwd: string | null } | undefined
    return row?.cwd ?? null
  }

  setSessionCwd(sessionId: string, cwd: string): void {
    this.db.prepare(`UPDATE sessions SET cwd = ? WHERE id = ?`).run(cwd, sessionId)
  }

  setTouchedPaths(sessionId: string, paths: string[]): void {
    this.db
      .prepare(`UPDATE sessions SET touched_paths = ? WHERE id = ?`)
      .run(JSON.stringify(paths), sessionId)
  }

  getTouchedPaths(sessionId: string): string[] {
    const row = this.db.prepare(`SELECT touched_paths as p FROM sessions WHERE id = ?`).get(sessionId) as
      { p: string } | undefined
    return readJsonList(row?.p, z.string())
  }

  /** Records the skill list (per tool and directory) */
  /** Records commit attribution (#50) — kept here only, not in the repository */
  recordCommit(projectId: string, sha: string, sessionId: string): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO commit_sessions (project_id, sha, session_id, ts) VALUES (?, ?, ?, ?)`)
      .run(projectId, sha, sessionId, Date.now())
  }

  commitSessions(projectId: string): { sha: string; sessionId: string }[] {
    return this.db
      .prepare(`SELECT sha, session_id AS sessionId FROM commit_sessions WHERE project_id = ?`)
      .all(projectId) as { sha: string; sessionId: string }[]
  }

  markRead(sessionId: string, seq: number): void {
    this.db
      .prepare(`UPDATE sessions SET last_read_seq = MAX(last_read_seq, ?) WHERE id = ?`)
      .run(seq, sessionId)
  }
}
