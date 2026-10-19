import type Database from 'better-sqlite3'
import type { ProjectInfo, SavedCommand, ToolDefaults } from '@cc/protocol'
import { asObj, isObj } from '../../json-value.js'
import { parseJson, readJsonList } from './json.js'
import { z } from 'zod'

/** The projects table: what a project remembers (its commands, worktree setup, tool defaults, trust) and where it sits in the sidebar */
/** Where a project's instructions for started agents are kept (#1161 item 2) */
export const agentInstructionsKey = (projectId: string): string => `agent_instructions:${projectId}`

export class ProjectRecords {
  constructor(private readonly db: Database.Database) {}

  /**
   * `trusted` is the trust a NEW row starts with (#655); absent means untrusted, as before. It is an insert-only
   * value: registering a path that already has a row renames it and leaves its trust alone, so neither an earlier
   * "no" nor a later "yes" is overwritten by a second registration.
   */
  addProject(p: { id: string; path: string; name: string; trusted?: boolean }): void {
    this.db
      .prepare(
        `INSERT INTO projects (id, path, name, created_at, trusted) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET name = excluded.name`,
      )
      .run(p.id, p.path, p.name, Date.now(), p.trusted ? 1 : 0)
  }

  /**
   * `commands` is deliberately not in here (issue #44) — `projectCommands` answers that one.
   *
   * The column holds JSON, so it needs decoding, and every caller of this method wants a
   * path or a name. Leaving it out of the row type means the omission is stated rather than
   * silently cast away, which is how `Omit<ProjectInfo, 'git'>` would have become a lie the
   * moment the field was added.
   */
  listProjects(): Omit<ProjectInfo, 'git' | 'commands' | 'defaultModels'>[] {
    const rows = this.db
      .prepare(
        `SELECT id, path, name, default_tool as defaultTool, trusted FROM projects ORDER BY sidebar_order, created_at`,
      )
      .all() as (Omit<ProjectInfo, 'git' | 'commands' | 'defaultModels' | 'trusted'> & { trusted: number })[]
    // SQLite has no boolean — passing 0/1 straight through would still satisfy `if (p.trusted)` on screen, but fail schema validation
    return rows.map((r) => ({ ...r, trusted: r.trusted === 1 }))
  }

  /**
   * The shell commands saved on a project (issue #44).
   *
   * Unreadable JSON reads as "none". A row that somehow got corrupted must not take the
   * project list — and with it the sidebar — down with it; the worst it can cost is a menu
   * you have to fill in again.
   */
  projectCommands(projectId: string): SavedCommand[] {
    const row = this.db.prepare(`SELECT commands FROM projects WHERE id = ?`).get(projectId) as
      { commands: string } | undefined
    // Old rows are an array of strings (before labels, ~2026-09-06) — upgraded on read, and the next save fixes the new shape
    return readJsonList(row?.commands, z.unknown()).flatMap((c): SavedCommand[] => {
      if (typeof c === 'string') return [{ command: c }]
      if (c && typeof c === 'object' && typeof (c as { command?: unknown }).command === 'string') {
        const label = (c as { label?: unknown }).label
        return [{ command: (c as { command: string }).command, ...(typeof label === 'string' && label ? { label } : {}) }]
      }
      return []
    })
  }

  /** The whole list at once — add and delete both arrive here as "it looks like this now" */
  setProjectCommands(projectId: string, commands: readonly SavedCommand[]): void {
    this.db.prepare(`UPDATE projects SET commands = ? WHERE id = ?`).run(JSON.stringify(commands), projectId)
  }

  /**
   * The worktree provisioning setup (#69). null means nothing runs — it is not enforced.
   * The same rule as projectCommands: read whole, written whole.
   */
  worktreeSetup(projectId: string): { command: string; copyFiles: string[] } | null {
    const row = this.db.prepare(`SELECT worktree_setup FROM projects WHERE id = ?`).get(projectId) as
      { worktree_setup: string | null } | undefined
    const parsed = asObj(parseJson(row?.worktree_setup))
    const command = typeof parsed.command === 'string' ? parsed.command : ''
    const copyFiles = Array.isArray(parsed.copyFiles)
      ? parsed.copyFiles.filter((f): f is string => typeof f === 'string')
      : []
    if (!command && copyFiles.length === 0) return null
    return { command, copyFiles }
  }

  setWorktreeSetup(projectId: string, setup: { command: string; copyFiles: string[] } | null): void {
    this.db
      .prepare(`UPDATE projects SET worktree_setup = ? WHERE id = ?`)
      .run(setup ? JSON.stringify(setup) : null, projectId)
  }

  /**
   * The person's instructions for agents started in this project (#1161 item 2), '' when none. Kept as an app setting
   * of the project (`agent_instructions:<projectId>`), not a column: no store step, and an older build serving the same
   * store during a swap leaves it alone. Goes with the project (`TrashStore.deleteProject`).
   */
  agentInstructions(projectId: string): string {
    const row = this.db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(agentInstructionsKey(projectId)) as
      { value: string } | undefined
    return row?.value ?? ''
  }

  /** Written whole; an empty text removes the setting */
  setAgentInstructions(projectId: string, text: string): void {
    const key = agentInstructionsKey(projectId)
    if (!text) this.db.prepare(`DELETE FROM app_settings WHERE key = ?`).run(key)
    else this.db.prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, text)
  }

  /**
   * This project's worktree manager slot and trunk (#76).
   *
   * **This does not check whether the session it points at actually still exists** — that is
   * the job of the side that knows sessions (SessionManager); the store just hands back what
   * it was told to write down. Putting the "is this link broken" judgment (session deleted or
   * archived) in two places would let the two places disagree.
   */
  worktreeManager(projectId: string): { sessionId: string; baseBranch: string } | null {
    const row = this.db.prepare(`SELECT worktree_manager FROM projects WHERE id = ?`).get(projectId) as
      { worktree_manager: string | null } | undefined
    const parsed = asObj(parseJson(row?.worktree_manager))
    if (typeof parsed.sessionId !== 'string' || !parsed.sessionId) return null
    return {
      sessionId: parsed.sessionId,
      baseBranch: typeof parsed.baseBranch === 'string' ? parsed.baseBranch : '',
    }
  }

  /**
   * The project's worktree trunk (#76), from the same row as the former manager slot (#561 part 3): read whatever the
   * slot's session, since the trunk is the project's and no longer a manager's. Empty or unreadable: none.
   */
  worktreeTrunk(projectId: string): string | null {
    const row = this.db.prepare(`SELECT worktree_manager FROM projects WHERE id = ?`).get(projectId) as
      { worktree_manager: string | null } | undefined
    const parsed = asObj(parseJson(row?.worktree_manager))
    return typeof parsed.baseBranch === 'string' && parsed.baseBranch ? parsed.baseBranch : null
  }

  /**
   * Sets the trunk, keeping the slot's session id when there is one, so an older build still finds the manager it made
   * there (agent-host.md §5.1: the shape is expanded, not changed)
   */
  setWorktreeTrunk(projectId: string, baseBranch: string): void {
    this.setWorktreeManager(projectId, { sessionId: this.worktreeManager(projectId)?.sessionId ?? '', baseBranch })
  }

  setWorktreeManager(projectId: string, manager: { sessionId: string; baseBranch: string } | null): void {
    this.db
      .prepare(`UPDATE projects SET worktree_manager = ? WHERE id = ?`)
      .run(manager ? JSON.stringify(manager) : null, projectId)
  }

  /**
   * The tool a new session in this project starts on.
   *
   * Written when a session is created with an explicit tool, not from a settings screen:
   * the column was set to 'claude' at project creation and never updated again, so a Codex
   * user re-picked the pill on every single new session, forever.
   */
  setProjectDefaultTool(projectId: string, tool: string): void {
    this.db.prepare(`UPDATE projects SET default_tool = ? WHERE id = ?`).run(tool, projectId)
  }

  /**
   * The last model and effort chosen becomes the default (#69 finding 5) — but **per tool**
   * (#107).
   *
   * Read whole and written whole, the same rule as projectCommands. Unparsable JSON reads as
   * "none": the cost of losing one remembered value is a click, while throwing here would take
   * the project list — and with it the sidebar — down with it.
   */
  projectToolDefaults(projectId: string): Record<string, ToolDefaults> {
    const row = this.db.prepare(`SELECT default_models FROM projects WHERE id = ?`).get(projectId) as
      { default_models: string | null } | undefined
    const out: Record<string, ToolDefaults> = {}
    for (const [tool, v] of Object.entries(asObj(parseJson(row?.default_models)))) {
      if (!v || typeof v !== 'object') continue
      const { model, effort } = v as { model?: unknown; effort?: unknown }
      out[tool] = {
        model: typeof model === 'string' && model ? model : null,
        effort: typeof effort === 'string' && effort ? effort : null,
      }
    }
    return out
  }

  /**
   * Only one tool's slot is rewritten — another tool's remembered value has nothing to do with this choice (#107). It is
   * written over the stored value, not over this build's reading of it (#384): what a newer build keeps next to a
   * tool's model and effort, and a tool this build does not know, stay as they were. A value that is not a JSON object
   * is replaced, and named on stderr with what it held.
   */
  setProjectToolDefaults(projectId: string, tool: string, d: ToolDefaults): void {
    const row = this.db.prepare(`SELECT default_models FROM projects WHERE id = ?`).get(projectId) as
      { default_models: string | null } | undefined
    const raw = row?.default_models ?? null
    const stored = parseJson(raw)
    if (raw !== null && !isObj(stored)) {
      console.error(`[store] projects.default_models of ${projectId} held ${JSON.stringify(raw.slice(0, 200))}, not a JSON object; replaced by this pick`)
    }
    const all = asObj(stored)
    const next = { ...all, [tool]: { ...asObj(all[tool]), ...d } }
    this.db.prepare(`UPDATE projects SET default_models = ? WHERE id = ?`).run(JSON.stringify(next), projectId)
  }

  /**
   * The projects the app runtime sees — root path and trust (M4 A-2).
   *
   * Worktrees are not here. A worktree is a copy of a project, not a project, and if an app
   * instance stood up per copy, the same app would end up running multiple times over a single
   * data folder — the app only reads from a registered root (plan A-2).
   */
  projectRoots(): { id: string; path: string; trusted: boolean }[] {
    const rows = this.db
      .prepare(`SELECT id, path, trusted FROM projects ORDER BY sidebar_order, created_at`)
      .all() as { id: string; path: string; trusted: number }[]
    return rows.map((r) => ({ id: r.id, path: r.path, trusted: r.trusted === 1 }))
  }

  /** @returns whether the project existed — this does not silently succeed on an unknown id */
  setProjectTrusted(projectId: string, trusted: boolean): boolean {
    return this.db.prepare(`UPDATE projects SET trusted = ? WHERE id = ?`).run(trusted ? 1 : 0, projectId).changes > 0
  }

  findProjectByPath(path: string): { id: string } | undefined {
    return this.db.prepare(`SELECT id FROM projects WHERE path = ?`).get(path) as { id: string } | undefined
  }

  /**
   * Saves the sidebar order.
   *
   * **The whole order is taken and renumbered from scratch.** Touching only the neighboring
   * items in a "move this after that" way would eventually need a reshuffle once the values
   * get packed too tight, and would drift if the list changed in between. The list is short
   * (it is a sidebar a person looks at), so rewriting all of it is simple and safe.
   */
  setProjectOrder(orderedIds: readonly string[]): void {
    const stmt = this.db.prepare(`UPDATE projects SET sidebar_order = ? WHERE id = ?`)
    this.db.transaction(() => orderedIds.forEach((id, i) => stmt.run(i, id)))()
  }
}
