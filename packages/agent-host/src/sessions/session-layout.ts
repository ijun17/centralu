import type { GridPanel, SessionInfo } from '@cc/protocol'
import { appKeyOf } from '@cc/protocol'
import type { DelegationHost } from './delegation-flow.js'

/**
 * What the session layout reaches of the session manager (#1143), typed as the manager declares each member. The
 * manager builds it with getters for its fields (`SessionManager.parts`), so each is read when used, never kept.
 */
export type SessionLayoutHost = Pick<DelegationHost, 'meta' | 'store'> & {
  /** Every session this host knows, as the windows list them */
  listSessions: () => SessionInfo[]
}

/**
 * Where sessions and apps sit on the screen: the sidebar order of sessions and the grid's panels, with the linked
 * machines' sessions and apps a panel may name. Moved out of the session manager as it was (#1143); what it reaches
 * of the manager is `SessionLayoutHost`.
 */
export class SessionLayout {
  constructor(private readonly host: SessionLayoutHost) {}

  reorderSessions(projectId: string, orderedIds: readonly string[]): SessionInfo[] {
    /*
     * The order is **a single global one** (sidebar_order). Renumbering just this project's own
     * from 0 would collide with other projects' values, so sorting one project would scramble the
     * whole list. So only **the slots this project occupied** in the global order are swapped in
     * with the new order, and every other session is left exactly where it was.
     */
    const all = this.host.listSessions()
    const mine = new Set(all.filter((s) => s.projectId === projectId).map((s) => s.id))
    const rest = [...mine].filter((id) => !orderedIds.includes(id))
    const replacement = [...orderedIds.filter((id) => mine.has(id)), ...rest]
    let k = 0
    const globalOrder = all.map((s) => (mine.has(s.id) ? replacement[k++]! : s.id))
    this.host.store.sessions.setSessionOrder(globalOrder)
    // Reorder the in-memory copy too — saving alone leaves it out of sync with the screen until the next
    // launch. Sorted in place (#1143): the map stays the one every module reads, so none is left on an old copy
    const rank = new Map(globalOrder.map((id, i) => [id, i]))
    const sorted = [...this.host.meta.entries()].sort((a, b) => (rank.get(a[0]) ?? 0) - (rank.get(b[0]) ?? 0))
    this.host.meta.clear()
    for (const [id, m] of sorted) this.host.meta.set(id, m)
    return this.host.listSessions()
  }

  /** Grid layout — sessions and apps, in order (#288) */
  grid(): GridPanel[] {
    return this.host.store.grid.listGridView()
  }

  /**
   * Saves the layout.
   *
   * **Unknown sessions are filtered out.** If a deleted session's id stays in the layout and comes
   * back, the screen tries to draw something that no longer exists — filtering once at save time
   * means nobody has to worry about it afterward. An app panel is kept while its project is
   * registered (a user-folder app has none). Whether the app itself exists is the screen's
   * question: the app list is read from folders and can lag behind, and a panel dropped here for
   * that reason would not come back once the list caught up.
   */
  setGridView(panels: readonly GridPanel[]): GridPanel[] {
    const known = new Set(this.host.meta.keys())
    const projects = new Set(this.host.store.projects.listProjects().map((p) => p.id))
    // A linked machine's session (#82) is kept while the hub's mirror knows it (links/links.ts)
    const remote = (id: string) => !known.has(id) && this.linkedSession(id)
    /*
     * Another machine's app (#82, remote-hub.md §11.8) is kept while that machine is linked and, for a project app,
     * while the hub's mirror knows its project: the machine of a user-folder app is named by `machine`, a project
     * app's by its qualified project. A `machine` on a panel of this host's own app is dropped: it would name nothing.
     */
    const appMachine = (p: Extract<GridPanel, { kind: 'app' }>): string | null =>
      p.projectId === null ? (p.machine && this.linkedApps.linked(p.machine) ? p.machine : null) : this.linkedApps.projectMachine(p.projectId)
    const seen = new Set<string>()
    const clean: GridPanel[] = []
    for (const p of panels) {
      if (p.kind === 'session') {
        const key = `session:${p.sessionId}`
        if (seen.has(key) || !(known.has(p.sessionId) || remote(p.sessionId))) continue
        seen.add(key)
        clean.push(p)
        continue
      }
      const { machine: _machine, ...own } = p
      const elsewhere = projects.has(p.projectId ?? '') ? null : appMachine(p)
      // A panel naming a machine this host does not link is nobody's app here
      if (!elsewhere && (p.machine || (p.projectId !== null && !projects.has(p.projectId)))) continue
      const panel: GridPanel = elsewhere && p.projectId === null ? { ...own, machine: elsewhere } : own
      const key = `app:${appKeyOf(p.projectId, p.appId, elsewhere)}`
      if (seen.has(key)) continue
      seen.add(key)
      clean.push(panel)
    }
    this.host.store.grid.setGridView(clean, remote, (p) => (projects.has(p.projectId ?? '') ? null : appMachine(p)))
    return clean
  }

  /** Whether a machine-qualified id names a session of a linked machine the hub knows (#82). None without links */
  private linkedSession: (sessionId: string) => boolean = () => false

  useLinkedSessions(known: (sessionId: string) => boolean): void {
    this.linkedSession = known
  }

  /** The linked machines, for grid panels of their apps (#82). None without links */
  private linkedApps: { linked(machine: string): boolean; projectMachine(projectId: string): string | null } = {
    linked: () => false,
    projectMachine: () => null,
  }

  useLinkedApps(lookup: { linked(machine: string): boolean; projectMachine(projectId: string): string | null }): void {
    this.linkedApps = lookup
  }
}
