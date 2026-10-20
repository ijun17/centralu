import type Database from 'better-sqlite3'
import type { GridPanel } from '@cc/protocol'
import { GridSpan, appKeyOf } from '@cc/protocol'

/** The grid layout: which sessions and apps sit in the grid, in what order */
export class GridRecords {
  constructor(private readonly db: Database.Database) {}

  /**
   * The grid layout — sessions and apps, in the order the panels were placed (#288).
   *
   * A session panel shows only while its session is live: `trashSession` takes the panel away, and the join keeps a
   * panel written by an older build out of the grid too. An app panel shows while its project is registered (a
   * user-folder app has none); `deleteProject` takes its panels away, and the join covers a row it missed. Whether the
   * app itself still exists is not asked here — the app list is read from folders, it can lag behind, and the screen
   * leaves out an app it cannot find without the list losing its place.
   */
  listGridView(): GridPanel[] {
    const rows = this.db
      .prepare<unknown[], {
      kind: string
      session_id: string | null
      project_id: string | null
      app_id: string | null
      app_machine: string | null
      span_cols: number | null
      span_rows: number | null
    }>(
        `SELECT g.kind, COALESCE(g.session_id, g.remote_session_id) AS session_id, g.project_id,
                COALESCE(g.app_id, g.remote_app_id) AS app_id, g.app_machine, g.span_cols, g.span_rows
           FROM grid_layout g
           LEFT JOIN sessions s ON g.kind = 'session' AND s.id = g.session_id
           LEFT JOIN projects p ON g.kind = 'app' AND p.id = g.project_id
          WHERE (g.kind = 'session' AND s.id IS NOT NULL AND s.deleted_at IS NULL)
             OR (g.kind = 'session' AND g.session_id IS NULL AND g.remote_session_id IS NOT NULL AND EXISTS (
                  SELECT 1 FROM machine_headers h
                   WHERE h.kind = 'session' AND h.machine_id || '.' || h.item_id = g.remote_session_id))
             OR (g.kind = 'app' AND g.app_id IS NOT NULL AND (g.project_id IS NULL OR p.id IS NOT NULL))
             OR (g.kind = 'app' AND g.app_id IS NULL AND g.remote_app_id IS NOT NULL
                 AND EXISTS (SELECT 1 FROM linked_machines m WHERE m.id = g.app_machine)
                 AND (g.project_id IS NULL OR EXISTS (
                  SELECT 1 FROM machine_headers h
                   WHERE h.kind = 'project' AND h.machine_id = g.app_machine AND h.machine_id || '.' || h.item_id = g.project_id)))
          ORDER BY g.position`,
      )
      .all()
    // A row with no id (the WHERE above keeps none) is skipped, not drawn as a panel with nothing in it
    return rows.flatMap((r): GridPanel[] => {
      if (r.kind === 'session') return r.session_id === null ? [] : [{ kind: 'session', sessionId: r.session_id }]
      if (r.app_id === null) return []
      // A span is kept only whole: a row with one half, or a value outside the protocol's bounds, reads as none chosen
      const span = GridSpan.safeParse({ cols: r.span_cols, rows: r.span_rows })
      return [{
        kind: 'app',
        projectId: r.project_id,
        appId: r.app_id,
        // A linked machine's user-folder app names its machine; a project app's qualified id already does (#82)
        ...(r.app_machine && r.project_id === null ? { machine: r.app_machine } : {}),
        ...(span.success ? { span: span.data } : {}),
      }]
    })
  }

  /**
   * Rewrites the layout whole.
   *
   * Adding, removing and reordering all arrive as this one call, so deleting and reinserting
   * is the simplest approach. The list is short (a screen a person looks at), and being one
   * transaction means no intermediate state is ever visible. A panel named twice keeps its first
   * place (`panel_key` is the primary key).
   */
  setGridView(
    panels: readonly GridPanel[],
    remote: (sessionId: string) => boolean = () => false,
    /** The linked machine an app panel's app is on (#82), or null for this host's own */
    appMachine: (panel: Extract<GridPanel, { kind: 'app' }>) => string | null = () => null,
  ): void {
    const del = this.db.prepare(`DELETE FROM grid_layout`)
    const ins = this.db.prepare(
      `INSERT OR IGNORE INTO grid_layout (panel_key, kind, session_id, project_id, app_id, position, span_cols, span_rows)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    // Another machine's session is not in `sessions`, so it goes in a column without the reference (v46, #82)
    const insRemote = this.db.prepare(
      `INSERT OR IGNORE INTO grid_layout (panel_key, kind, session_id, remote_session_id, position) VALUES (?, 'session', NULL, ?, ?)`,
    )
    // Another machine's app keeps `app_id` empty, so a host from before v47 never reads it as its own (v47, #82)
    const insRemoteApp = this.db.prepare(
      `INSERT OR IGNORE INTO grid_layout (panel_key, kind, session_id, project_id, app_id, remote_app_id, app_machine, position, span_cols, span_rows)
       VALUES (?, 'app', NULL, ?, NULL, ?, ?, ?, ?, ?)`,
    )
    this.db.transaction(() => {
      del.run()
      panels.forEach((p, i) => {
        if (p.kind === 'session' && remote(p.sessionId)) insRemote.run(`session:${p.sessionId}`, p.sessionId, i)
        else if (p.kind === 'session') ins.run(`session:${p.sessionId}`, 'session', p.sessionId, null, null, i, null, null)
        else {
          const machine = appMachine(p)
          if (machine) {
            // The UI's key (`gridPanelKey`): a machine's user-folder app names the machine, a project app its qualified project
            const key = `app:${appKeyOf(p.projectId, p.appId, machine)}`
            insRemoteApp.run(key, p.projectId, p.appId, machine, i, p.span?.cols ?? null, p.span?.rows ?? null)
            return
          }
          const key = `app:${appKeyOf(p.projectId, p.appId)}`
          ins.run(key, 'app', null, p.projectId, p.appId, i, p.span?.cols ?? null, p.span?.rows ?? null)
        }
      })
    })()
  }
}
