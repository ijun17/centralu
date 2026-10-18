import type Database from 'better-sqlite3'
import { appKeyOf } from '@cc/protocol'
import { isObj } from '../../json-value.js'
import { parseJson } from './json.js'
import type { SettingsRecords } from './settings.js'

/**
 * A user-folder app registered as a project in place (#1141): what the store keeps under the app's key, carried from
 * `_user/<id>` to `<project id>/<id>`. The files it keeps (data, logs, versions, secrets) are the app runtime's to carry
 * (`ExternalApps.carryAppState`); the host's adoption (`user-app-adoption.ts`) runs both.
 *
 * **Expand only** (docs/agent-host.md §5.1): no table or column changes, and every row a previous build reads stays
 * readable to it. What it reads by the old key is copied where a copy is possible (grants, the builder map entry, the
 * view origin port, a window's span); what is one row per thing moves to the project, where the previous build still
 * reads it under that project (runs, the app's sessions, attachments, grid panels). Run twice, it changes nothing the
 * second time: copies are `OR IGNORE`, moves only touch rows still under the user folder.
 */

/** Where the record of adopted folders is kept: app id → the project it became, bound to its folder's file id */
export const ADOPTED_USER_APPS_KEY = 'apps.adoptedUserApps'
const BUILDERS_KEY = 'apps.builders'
const VIEW_PORTS_KEY = 'apps.viewPorts'
const ATTACHED_PREFIX = 'session_apps:'

export type AdoptedRecord = { projectId: string; ino: string; at: number }

export class UserAppAdoptionRecords {
  constructor(
    private readonly db: Database.Database,
    private readonly settings: SettingsRecords,
  ) {}

  /** The folders already registered as projects, by app id */
  adopted(): Record<string, AdoptedRecord> {
    const raw = parseJson(this.settings.appSetting(ADOPTED_USER_APPS_KEY))
    const out: Record<string, AdoptedRecord> = {}
    if (!isObj(raw)) return out
    for (const [id, r] of Object.entries(raw)) {
      if (isObj(r) && typeof r.projectId === 'string' && typeof r.ino === 'string' && typeof r.at === 'number') out[id] = { projectId: r.projectId, ino: r.ino, at: r.at }
    }
    return out
  }

  /**
   * Registers the folder as a project (unless it already is one: its id and trust are then kept), carries the store's
   * part of one app from the user folder to that project, and records the folder as adopted — one transaction, so the
   * project never stands without its app's state, nor the record without what it says was carried. Returns the
   * project's id and the ids of the sessions moved into it (the manager holds them in memory too).
   */
  carry(appId: string, project: { path: string; name: string; trusted: boolean; newId: string }, ino: string): { projectId: string; sessions: string[] } {
    return this.db.transaction(() => {
      const known = this.db.prepare(`SELECT id FROM projects WHERE path = ?`).get(project.path) as { id: string } | undefined
      const projectId = known?.id ?? project.newId
      if (!known) {
        this.db
          .prepare(`INSERT INTO projects (id, path, name, created_at, trusted) VALUES (?, ?, ?, ?, ?)`)
          .run(projectId, project.path, project.name, Date.now(), project.trusted ? 1 : 0)
      }
      const from = appKeyOf(null, appId)
      const to = appKeyOf(projectId, appId)
      // Grants (app_permissions): the app's own answers, then other apps' answers about calling it
      this.db
        .prepare(
          `INSERT OR IGNORE INTO app_permissions (app_key, project_id, capability, text, decision, uses_stamp, decided_at)
           SELECT ?, ?, capability, text, decision, uses_stamp, decided_at FROM app_permissions WHERE app_key = ?`,
        )
        .run(to, projectId, from)
      this.db
        .prepare(
          `INSERT OR IGNORE INTO app_permissions (app_key, project_id, capability, text, decision, uses_stamp, decided_at)
           SELECT app_key, project_id, ?, text, decision, uses_stamp, decided_at FROM app_permissions WHERE capability = ?`,
        )
        .run(`app:${to}`, `app:${from}`)
      // The run ledger and its kept failures
      this.db.prepare(`UPDATE app_runs SET project_id = ? WHERE project_id IS NULL AND app_id = ?`).run(projectId, appId)
      this.db.prepare(`UPDATE app_run_failures SET project_id = ? WHERE project_id IS NULL AND app_id = ?`).run(projectId, appId)
      // Its sessions (its builder, the agents it started): a user-folder app's had no project; the orchestrator and coordinators are not its
      const sessions = (
        this.db
          .prepare(
            `SELECT id FROM sessions
              WHERE project_id IS NULL AND app_id = ? AND deleted_at IS NULL AND is_orchestrator = 0 AND scope_session_ids IS NULL`,
          )
          .all(appId) as { id: string }[]
      ).map((r) => r.id)
      const move = this.db.prepare(`UPDATE sessions SET project_id = ? WHERE id = ? AND project_id IS NULL AND deleted_at IS NULL`)
      for (const id of sessions) move.run(projectId, id)
      // Grid panels: moved, unless the project's key already has one
      const has = this.db.prepare(`SELECT 1 FROM grid_layout WHERE panel_key = ?`).get(`app:${to}`)
      if (has) this.db.prepare(`DELETE FROM grid_layout WHERE panel_key = ?`).run(`app:${from}`)
      else
        this.db
          .prepare(`UPDATE grid_layout SET panel_key = ?, project_id = ? WHERE panel_key = ? AND kind = 'app' AND project_id IS NULL AND app_id = ?`)
          .run(`app:${to}`, projectId, `app:${from}`, appId)
      // The builder map: the same session, under the new key too
      this.updateJson(BUILDERS_KEY, (map) => {
        if (typeof map[from] === 'string' && map[to] === undefined) map[to] = map[from]
      })
      // The view origin port: the same app keeps the same origin, so its browser storage stays its own
      this.updateJson(VIEW_PORTS_KEY, (book) => {
        const assigned = book.assigned
        if (isObj(assigned) && typeof assigned[from] === 'number' && assigned[to] === undefined) assigned[to] = assigned[from]
      })
      // Apps sessions attached themselves (find_apps / attach_app): the record names the app's project now
      const attached = this.db.prepare(`SELECT key, value FROM app_settings WHERE key LIKE ? ESCAPE '\\'`).all(`${ATTACHED_PREFIX.replace(/_/g, '\\_')}%`) as {
        key: string
        value: string
      }[]
      for (const row of attached) {
        const list = parseJson(row.value)
        if (!Array.isArray(list)) continue
        let changed = false
        for (const r of list) {
          if (isObj(r) && r.projectId === null && r.appId === appId) {
            r.projectId = projectId
            changed = true
          }
        }
        if (changed) this.settings.setAppSetting(row.key, JSON.stringify(list))
      }
      // The names sessions have seen it under (#1141): the same app, so the same name, under its new key
      const names = this.db.prepare(`SELECT key, value FROM app_settings WHERE key LIKE ? ESCAPE '\\'`).all('session\\_app\\_names:%') as { key: string; value: string }[]
      for (const row of names) {
        const book = parseJson(row.value)
        if (!isObj(book) || typeof book[from] !== 'string' || book[to] !== undefined) continue
        book[to] = book[from]
        delete book[from]
        this.settings.setAppSetting(row.key, JSON.stringify(book))
      }
      // The window's own memory of the app (its span on the grid, the app it had open), kept in the workspace snapshot
      const layout = this.settings.loadWorkspace<Record<string, unknown>>()
      if (isObj(layout)) {
        let changed = false
        const spans = layout.appSpans
        if (isObj(spans) && spans[from] !== undefined && spans[to] === undefined) {
          spans[to] = spans[from]
          changed = true
        }
        const open = layout.focusedApp
        if (isObj(open) && open.projectId === null && open.appId === appId && !open.machine) {
          layout.focusedApp = { projectId, appId }
          changed = true
        }
        if (changed) this.settings.saveWorkspace(layout)
      }
      this.updateJson(ADOPTED_USER_APPS_KEY, (adopted) => {
        adopted[appId] = { projectId, ino, at: Date.now() }
      })
      return { projectId, sessions }
    })()
  }

  /** Reads a JSON object setting, lets `edit` change it in place, and writes it back (an absent or unreadable one starts empty) */
  private updateJson(key: string, edit: (value: Record<string, unknown>) => void): void {
    const raw = parseJson(this.settings.appSetting(key))
    const value: Record<string, unknown> = isObj(raw) ? raw : {}
    const before = JSON.stringify(value)
    edit(value)
    if (JSON.stringify(value) !== before) this.settings.setAppSetting(key, JSON.stringify(value))
  }
}
