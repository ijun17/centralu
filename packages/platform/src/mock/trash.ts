import { isInTurn, type ProjectInfo, type SessionInfo, type StoredMessage } from '@cc/protocol'
import type { MockClock } from './clock.js'
import type { SessionStore } from './session-store.js'
import type { ProjectStore } from './project-store.js'
import type { ToolsMock } from './tools.js'
import type { GridMock } from './grid.js'
import type { Emit } from './event-bus.js'
import { mockError } from './mock-error.js'

/** The trash (#204), behind the `trash` port: deleting a session moves it here until it is deleted for good */
export class TrashMock {
  /** Session ids deleted via deleteExternal — the observation point for whether "really delete" was actually delivered */
  readonly externallyDeleted: string[] = []
  /**
   * The trash (#204), with the host's rules: deleting moves a session here with its messages, and nothing chosen in
   * the dialog happens until it is deleted for good — only then does `externallyDeleted` record the tool's file.
   */
  readonly trashBin = new Map<
    string,
    {
      session: SessionInfo
      messages: StoredMessage[]
      deletedAt: number
      project: { id: string; name: string; path: string } | null
      removeExternal: boolean
      removeWorktree: boolean
    }
  >()

  moveToTrash(sessionId: string, removeWorktree: boolean, removeExternal: boolean): void {
    const session = this.store.sessions.get(sessionId)
    if (!session) return
    const p = session.projectId ? this.projectStore.list.find((x) => x.id === session.projectId) : undefined
    this.trashBin.set(sessionId, {
      session: { ...session, live: false },
      messages: this.store.messages.get(sessionId) ?? [],
      deletedAt: this.clock.now(),
      project: p ? { id: p.id, name: p.name, path: p.path } : null,
      removeExternal: removeExternal && !!(session.externalId ?? session.importedFrom),
      removeWorktree: removeWorktree && !!session.worktree,
    })
    this.store.sessions.delete(sessionId)
    this.store.messages.delete(sessionId)
    this.gridMock.gridPanels = this.gridMock.gridPanels.filter((p) => !(p.kind === 'session' && p.sessionId === sessionId))
    this.emit({ type: 'session_deleted', sessionId })
  }

  readonly trash = {
    list: async () => {
      const sessions = [...this.trashBin.values()]
        .sort((a, b) => b.deletedAt - a.deletedAt)
        .map(({ session: s, messages, deletedAt, project, removeExternal, removeWorktree }) => {
          const live = project ? this.projectStore.list.find((x) => x.id === project.id) : undefined
          const hasFile = !!(s.externalId ?? s.importedFrom)
          return {
            id: s.id,
            name: s.name,
            tool: s.tool,
            project: project ? { id: project.id, name: live?.name ?? project.name, path: live?.path ?? project.path, exists: !!live } : null,
            deletedAt,
            messages: messages.length,
            bytes: messages.reduce((n, m) => n + JSON.stringify(m.payload).length, 0),
            conversationFile: (!hasFile ? 'none' : removeExternal ? 'remove' : 'keep') as 'none' | 'remove' | 'keep',
            worktree: s.worktree ? { path: s.worktree.path, branch: s.worktree.branch, remove: removeWorktree } : null,
          }
        })
      return { sessions, bytes: sessions.reduce((n, s) => n + s.bytes, 0) }
    },
    read: async (sessionId: string, limit = 200, beforeSeq?: number) => {
      const t = this.trashBin.get(sessionId)
      if (!t) throw mockError(`Not in the trash: ${sessionId}`, 'session_not_found')
      const filtered = beforeSeq ? t.messages.filter((m) => m.seq < beforeSeq) : t.messages
      return filtered.slice(-limit)
    },
    restore: async (sessionId: string) => {
      const t = this.trashBin.get(sessionId)
      if (!t) throw mockError(`Not in the trash: ${sessionId}`, 'session_not_found')
      let registered: ProjectInfo | null = null
      let projectId: string | null = null
      if (t.project) {
        const home =
          this.projectStore.list.find((x) => x.id === t.project!.id) ?? this.projectStore.list.find((x) => x.path === t.project!.path)
        if (home) projectId = home.id
        else {
          // The mock has no disk: the folder is always there, so the project is registered again under its id
          const p: ProjectInfo = {
            id: t.project.id, path: t.project.path, name: t.project.name, defaultTool: this.toolsMock.firstRegisteredTool(), defaultModels: {},
            commands: [], worktreeSetup: null, worktreeManager: null, trusted: false,
            git: { branch: 'main', changedFiles: 0, isRepo: true },
          }
          this.projectStore.list.push(p)
          projectId = p.id
          registered = this.projectStore.withGit(p)
        }
      }
      const live = isInTurn(t.session.state)
      const session: SessionInfo = { ...t.session, projectId, ...(live ? { state: 'idle' as const, waitingSince: null } : {}) }
      this.trashBin.delete(sessionId)
      this.store.sessions.set(sessionId, session)
      this.store.messages.set(sessionId, t.messages)
      this.emit({ type: 'session_created', sessionId, session: { ...session } })
      return { session: { ...session }, project: registered }
    },
    purge: async (sessionId: string) => {
      const t = this.trashBin.get(sessionId)
      if (!t) throw mockError(`Not in the trash: ${sessionId}`, 'session_not_found')
      // The same rule as the host: if removing the original was specified, that fact stays on the record (a point tests verify)
      if (t.removeExternal) this.externallyDeleted.push(sessionId)
      this.trashBin.delete(sessionId)
    },
    empty: async () => {
      const ids = [...this.trashBin.keys()]
      for (const id of ids) await this.trash.purge(id)
      return { purged: ids.length, failed: [] }
    },
  }

  constructor(
    private readonly clock: MockClock,
    private readonly emit: Emit,
    private readonly store: SessionStore,
    private readonly projectStore: ProjectStore,
    private readonly toolsMock: ToolsMock,
    private readonly gridMock: GridMock,
  ) {}
}
