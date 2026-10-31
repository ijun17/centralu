import { isInTurn, type ProjectInfo, type SessionInfo, type StoredMessage, type SubagentStepsHeld, type TrashedRun, type TrashedSubagentSteps } from '@cc/protocol/client'
import type { MockClock } from './clock.js'
import type { SessionStore } from './session-store.js'
import type { ProjectStore } from './project-store.js'
import type { ToolsMock } from './tools.js'
import type { GridMock } from './grid.js'
import type { Emit } from './event-bus.js'
import { mockProjectInfo } from './session-info.js'
import { mockError } from './mock-error.js'

/** The session archive (#204), behind the `trash` port: deleting a session moves it here until it is deleted for good */
export class TrashMock {
  /** Session ids deleted via deleteExternal — the observation point for whether "really delete" was actually delivered */
  readonly externallyDeleted: string[] = []
  /**
   * The session archive (#204), with the host's rules: deleting moves a session here with its messages, and nothing chosen in
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

  /**
   * The records of deleted app-agent sessions (#378), as the host keeps them. The mock never runs an app's agent, so a
   * test or a demo scene puts one here (`keepRun`).
   */
  readonly keptRuns = new Map<string, { run: TrashedRun; request: string; answer: string; output?: unknown; messages: StoredMessage[] }>()

  keepRun(r: { run: Omit<TrashedRun, 'messages' | 'bytes' | 'requestPreview'>; request: string; answer: string; output?: unknown; messages: StoredMessage[] }): void {
    const bytes = r.request.length + r.answer.length + r.messages.reduce((n, m) => n + JSON.stringify(m.payload).length, 0)
    this.keptRuns.set(r.run.runId, {
      ...r,
      run: { ...r.run, requestPreview: r.request.slice(0, 300), messages: r.messages.length, bytes },
    })
  }

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
          const conversationFile: 'none' | 'remove' | 'keep' = !hasFile ? 'none' : removeExternal ? 'remove' : 'keep'
          return {
            id: s.id,
            name: s.name,
            tool: s.tool,
            project: project ? { id: project.id, name: live?.name ?? project.name, path: live?.path ?? project.path, exists: !!live } : null,
            deletedAt,
            messages: messages.length,
            bytes: messages.reduce((n, m) => n + JSON.stringify(m.payload).length, 0),
            conversationFile,
            worktree: s.worktree ? { path: s.worktree.path, branch: s.worktree.branch, remove: removeWorktree } : null,
          }
        })
      const runs = [...this.keptRuns.values()].map((k) => k.run).sort((a, b) => b.keptAt - a.keptAt)
      const subagentSteps = this.trashedSubagentEntries()
      return { sessions, runs, bytes: [...sessions, ...runs, ...subagentSteps].reduce((n, x) => n + x.bytes, 0), subagentSteps }
    },
    readRun: async (runId: string, limit = 200, beforeSeq?: number) => {
      const k = this.keptRuns.get(runId)
      if (!k) throw mockError(`Not in the session archive: ${runId}`, 'session_not_found')
      const filtered = beforeSeq ? k.messages.filter((m) => m.seq < beforeSeq) : k.messages
      return { request: k.request, answer: k.answer, ...(k.output !== undefined ? { output: k.output } : {}), messages: filtered.slice(-limit) }
    },
    purgeRuns: async (runIds: string[]) => {
      let purged = 0
      for (const id of runIds) if (this.keptRuns.delete(id)) purged++
      return { purged }
    },
    read: async (sessionId: string, limit = 200, beforeSeq?: number) => {
      const t = this.trashBin.get(sessionId)
      if (!t) throw mockError(`Not in the session archive: ${sessionId}`, 'session_not_found')
      const filtered = beforeSeq ? t.messages.filter((m) => m.seq < beforeSeq) : t.messages
      return filtered.slice(-limit)
    },
    restore: async (sessionId: string) => {
      const t = this.trashBin.get(sessionId)
      if (!t) throw mockError(`Not in the session archive: ${sessionId}`, 'session_not_found')
      let registered: ProjectInfo | null = null
      let projectId: string | null = null
      const trashedProject = t.project
      if (trashedProject) {
        const home =
          this.projectStore.list.find((x) => x.id === trashedProject.id) ?? this.projectStore.list.find((x) => x.path === trashedProject.path)
        if (home) projectId = home.id
        else {
          // The mock has no disk: the folder is always there, so the project is registered again under its id
          const p = mockProjectInfo({ id: trashedProject.id, path: trashedProject.path, name: trashedProject.name, defaultTool: this.toolsMock.firstRegisteredTool() })
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
      if (!t) throw mockError(`Not in the session archive: ${sessionId}`, 'session_not_found')
      // The same rule as the host: if removing the original was specified, that fact stays on the record (a point tests verify)
      if (t.removeExternal) this.externallyDeleted.push(sessionId)
      this.trashBin.delete(sessionId)
      // Its subagent steps go with it, in the session archive or not (#222)
      for (const key of this.subagentKeys(sessionId)) {
        for (const m of this.store.subagentMessages.get(key) ?? []) this.store.subagentTrashedAt.delete(`${key} ${m.seq}`)
        this.store.subagentMessages.delete(key)
      }
    },
    // Sessions only, as the host: the run records and the subagent steps are the window's to delete, each it listed
    empty: async () => {
      const ids = [...this.trashBin.keys()]
      for (const id of ids) await this.trash.purge(id)
      return { purged: ids.length, failed: [] }
    },
    // A session's subagent steps, to the session archive without it and back (#418), with the host's rules
    subagentUsage: async () => ({ sessions: this.subagentEntries() }),
    trashSubagentSteps: async (sessionId: string) => {
      if (!this.store.sessions.has(sessionId)) {
        throw mockError('That session is no longer here: it was deleted, or is in the session archive', 'session_not_found')
      }
      // Strictly later than the session's last move, as the host stamps it, so a window's `upTo` never reaches a later one
      const prev = Math.max(0, ...this.subagentSteps(sessionId, true).map(([key, m]) => this.store.subagentTrashedAt.get(`${key} ${m.seq}`) ?? 0))
      const now = Math.max(this.clock.now(), prev + 1)
      const moved = { steps: 0, bytes: 0 }
      for (const [key, m] of this.subagentSteps(sessionId, false)) {
        this.store.subagentTrashedAt.set(`${key} ${m.seq}`, now)
        moved.steps++
        moved.bytes += stepBytes(m)
      }
      return moved
    },
    restoreSubagentSteps: async (sessionId: string) => {
      const trashed = this.trashedSteps(sessionId)
      for (const [key, m] of trashed) this.store.subagentTrashedAt.delete(`${key} ${m.seq}`)
    },
    purgeSubagentSteps: async (sessionId: string, upTo: number) => {
      const trashed = this.trashedSteps(sessionId, upTo)
      for (const [key, m] of trashed) {
        this.store.subagentTrashedAt.delete(`${key} ${m.seq}`)
        this.store.subagentMessages.set(key, (this.store.subagentMessages.get(key) ?? []).filter((r) => r.seq !== m.seq))
      }
    },
  }

  /** The launch cards of a session that keep steps: `<session id> <launch call id>` */
  private subagentKeys(sessionId: string): string[] {
    return [...this.store.subagentMessages.keys()].filter((k) => k.startsWith(`${sessionId} `))
  }

  /** A session's steps, in the session archive or under their cards, each with its card's key */
  private subagentSteps(sessionId: string, trashed: boolean): [string, StoredMessage][] {
    const out: [string, StoredMessage][] = []
    for (const key of this.subagentKeys(sessionId)) {
      for (const m of this.store.subagentMessages.get(key) ?? []) {
        if (this.store.subagentTrashedAt.has(`${key} ${m.seq}`) === trashed) out.push([key, m])
      }
    }
    return out
  }

  /** A live session's archived steps (moved at or before `upTo`, when given), or the host's refusal when it has none */
  private trashedSteps(sessionId: string, upTo = Number.MAX_SAFE_INTEGER): [string, StoredMessage][] {
    const session = this.store.sessions.get(sessionId)
    const trashed = session
      ? this.subagentSteps(sessionId, true).filter(([key, m]) => (this.store.subagentTrashedAt.get(`${key} ${m.seq}`) ?? 0) <= upTo)
      : []
    if (!trashed.length) {
      throw mockError(`No subagent steps of ${session ? `“${session.name}”` : 'that session'} are in the session archive`, 'session_not_found')
    }
    return trashed
  }

  /** What each live session's subagent steps take, under their cards (largest first) */
  private subagentEntries(): SubagentStepsHeld[] {
    return this.heldSubagentSteps(false).sort((a, b) => b.bytes - a.bytes)
  }

  /** What each session's subagent steps in the session archive take (latest first) */
  private trashedSubagentEntries(): TrashedSubagentSteps[] {
    return this.heldSubagentSteps(true)
      .map((held) => ({ ...held, deletedAt: held.deletedAt ?? 0 }))
      .sort((a, b) => b.deletedAt - a.deletedAt)
  }

  private heldSubagentSteps(trashed: boolean): (SubagentStepsHeld & { deletedAt?: number })[] {
    const out: (SubagentStepsHeld & { deletedAt?: number })[] = []
    for (const s of this.store.sessions.values()) {
      const steps = this.subagentSteps(s.id, trashed)
      if (!steps.length) continue
      const p = s.projectId ? this.projectStore.list.find((x) => x.id === s.projectId) : undefined
      out.push({
        sessionId: s.id,
        name: s.name,
        tool: s.tool,
        project: p ? { id: p.id, name: p.name } : null,
        runs: new Set(steps.map(([key]) => key)).size,
        steps: steps.length,
        bytes: steps.reduce((n, [, m]) => n + stepBytes(m), 0),
        ...(trashed ? { deletedAt: Math.max(...steps.map(([key, m]) => this.store.subagentTrashedAt.get(`${key} ${m.seq}`) ?? 0)) } : {}),
      })
    }
    return out
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

/** A step's size as the mock counts a message's (`list`): its payload as JSON */
function stepBytes(m: StoredMessage): number {
  return JSON.stringify(m.payload).length
}
