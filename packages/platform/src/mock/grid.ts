import { appKeyOf, GridPanel } from '@cc/protocol/client'
import type { AgentPort } from '../ports/index.js'
import { readStored, writeStored } from './stored.js'
import type { SessionStore } from './session-store.js'
import type { ProjectStore } from './project-store.js'

/** The grid's panels (#288), behind `agents.grid` and `agents.setGridView` */
export class GridMock {
  /**
   * The grid's panels, sessions and apps (#288). `null` until first read: the list also survives a
   * reload through localStorage, like the workspace snapshot below, because the real host keeps it
   * on disk and "the grid comes back after a restart" is otherwise untestable against this mock.
   */
  private gridList: GridPanel[] | null = null
  get gridPanels(): GridPanel[] {
    if (this.gridList) return this.gridList
    const stored = readStored('cc-mock-grid') // nothing in node, or with storage denied: the in-memory copy still works
    // A panel this build cannot read is dropped, as the real list drops it
    this.gridList = Array.isArray(stored) ? stored.flatMap((p: unknown) => { const r = GridPanel.safeParse(p); return r.success ? [r.data] : [] }) : []
    return this.gridList
  }
  set gridPanels(list: GridPanel[]) {
    this.gridList = list
    writeStored('cc-mock-grid', list)
  }
  readonly agents: Pick<AgentPort, 'grid' | 'setGridView'> = {
    // The host's rule (store.listGridView): a session panel only while its session is live, an app panel while its project is registered
    grid: async () =>
      this.gridPanels.filter((p) =>
        p.kind === 'session' ? this.store.sessions.has(p.sessionId) : p.projectId === null || this.projectStore.list.some((x) => x.id === p.projectId),
      ),
    // The host's rule (SessionLayout.setGridView): unknown sessions and an app of an unregistered project are left out, and a panel named twice keeps its first place
    setGridView: async (panels: GridPanel[]) => {
      const seen = new Set<string>()
      this.gridPanels = panels.filter((p) => {
        const key = p.kind === 'session' ? `session:${p.sessionId}` : `app:${appKeyOf(p.projectId, p.appId)}`
        if (seen.has(key)) return false
        seen.add(key)
        return p.kind === 'session' ? this.store.sessions.has(p.sessionId) : p.projectId === null || this.projectStore.list.some((x) => x.id === p.projectId)
      })
      return [...this.gridPanels]
    },
  }

  constructor(
    private readonly store: SessionStore,
    private readonly projectStore: ProjectStore,
  ) {}
}
