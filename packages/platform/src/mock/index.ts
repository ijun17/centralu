import type {
  AdapterCapabilities,
  GitBranch,
  GitCommit,
  GitDiff,
  GitFileStatus,
  ApprovalDecision,
  ApprovalDetail,
  ApprovalScope,
  CreateSessionParams,
  NormalizedEvent,
  ProjectInfo,
  SessionInfo,
  StoredMessage,
  ToolName,
} from '@cc/protocol'
import type { AgentPort, ConnectionState, Platform, ProjectPort, SystemPort, Unsubscribe, WorkspaceSnapshot } from '../ports/index.js'

/**
 * 인메모리 구현 (docs/platform-abstraction.md §6).
 * 테스트·Playwright는 이걸 쓴다 — 모킹 라이브러리로 포트를 즉석 모킹하지 않는다 (계약이 흩어지므로).
 */

export type MockOptions = {
  /** 결정적 시각 — 대기 경과 시간 테스트용 */
  now?: () => number
}

export class MockPlatform implements Platform {
  private projectsList: ProjectInfo[] = []
  private sessions = new Map<string, SessionInfo>()
  private messages = new Map<string, StoredMessage[]>()
  private handlers = new Set<(e: NormalizedEvent) => void>()
  private connHandlers = new Set<(s: ConnectionState) => void>()
  private idc = 0
  private now: () => number

  /** 테스트용: 디렉토리 피커가 돌려줄 값 */
  nextPickedDirectory: string | null = '/tmp/picked'
  /** 테스트용: 재개 불가로 만들 세션들 */
  readonly unresumable = new Set<string>()
  readonly notifications: { title: string; body: string }[] = []
  readonly opened: { path: string; line?: number }[] = []
  badge = 0

  constructor(opts: MockOptions = {}) {
    this.now = opts.now ?? (() => Date.now())
  }

  readonly capabilities = {
    osNotifications: true,
    dockBadge: true,
    globalShortcuts: false,
    processSupervision: false,
    openInIde: true,
  }

  /** 테스트가 이벤트를 주입하는 통로 */
  emit(event: NormalizedEvent): void {
    if (event.sessionId) {
      const s = this.sessions.get(event.sessionId)
      if (s) {
        if (event.type === 'approval_request') {
          s.state = 'waiting_approval'
          s.waitingSince ??= this.now()
        } else if (event.type === 'turn_complete') {
          s.state = 'waiting_input'
          s.waitingSince ??= this.now()
        } else if (event.type === 'message_delta' || event.type === 'tool_call') {
          s.state = 'working'
          s.waitingSince = null
        }
        if (event.type === 'message_delta') {
          const seq = (this.messages.get(s.id)?.length ?? 0) + 1
          this.pushMessage({ sessionId: s.id, seq, role: 'assistant', kind: 'text', payload: event, ts: this.now() })
          s.lastSeq = seq
        }
      }
    }
    for (const h of this.handlers) h(event)
  }

  private pushMessage(m: StoredMessage): void {
    const arr = this.messages.get(m.sessionId) ?? []
    arr.push(m)
    this.messages.set(m.sessionId, arr)
  }

  setConnectionState(s: ConnectionState): void {
    for (const h of this.connHandlers) h(s)
  }

  /** 테스트가 주무르는 가짜 깃 상태 */
  gitState: {
    files: GitFileStatus[]
    diffs: Record<string, string>
    commits: GitCommit[]
    branches: GitBranch[]
    dirty: string[]
    lastCommitMessage?: string
    pushed: boolean
  } = { files: [], diffs: {}, commits: [], branches: [], dirty: [], pushed: false }

  readonly git = {
    status: async (_projectId: string) => [...this.gitState.files],
    diff: async (_projectId: string, path: string, _staged?: boolean): Promise<GitDiff> => ({
      diff: this.gitState.diffs[path] ?? '',
      truncated: false,
      binary: false,
    }),
    log: async (_projectId: string, limit = 50) => this.gitState.commits.slice(0, limit),
    commitDetail: async (_projectId: string, sha: string) => ({
      files: [`file-${sha}.ts`],
      diff: this.gitState.diffs[sha] ?? '',
      truncated: false,
    }),
    branches: async (_projectId: string) => [...this.gitState.branches],
    checkout: async (_projectId: string, branch: string, dryRun?: boolean) => {
      if (dryRun) return { ok: this.gitState.dirty.length === 0, conflicts: [...this.gitState.dirty] }
      this.gitState.branches = this.gitState.branches.map((b) => ({ ...b, current: b.name === branch }))
      return { ok: true, conflicts: [] }
    },
    stage: async (_projectId: string, paths: string[], unstage?: boolean) => {
      this.gitState.files = this.gitState.files.map((f) =>
        paths.includes(f.path) ? { ...f, staged: !unstage } : f,
      )
    },
    commit: async (_projectId: string, message: string) => {
      this.gitState.lastCommitMessage = message
      this.gitState.files = this.gitState.files.filter((f) => !f.staged)
      return { ok: true }
    },
    push: async (_projectId: string) => {
      this.gitState.pushed = true
      return { ok: true }
    },
  }

  /** 테스트용: 마지막 createSession 파라미터 (고른 값이 실제로 전달됐는지 확인) */
  lastCreateParams: CreateSessionParams | null = null

  readonly agents: AgentPort = {
    createSession: async (params: CreateSessionParams) => {
      this.lastCreateParams = params
      const id = `mock-session-${++this.idc}`
      const info: SessionInfo = {
        id, projectId: params.projectId, tool: params.tool, externalId: `ext-${id}`,
        name: params.initialPrompt?.slice(0, 40) ?? '새 세션', autoNamed: true, state: 'idle',
        archived: false, lastReadSeq: 0, lastSeq: 0, createdAt: this.now(), waitingSince: null, live: true,
      }
      this.sessions.set(id, info)
      if (params.initialPrompt) await this.agents.send(id, params.initialPrompt)
      return info
    },
    send: async (sessionId: string, text: string) => {
      const s = this.sessions.get(sessionId)
      if (!s) throw Object.assign(new Error('세션 없음'), { code: 'session_not_found' })
      const seq = (this.messages.get(sessionId)?.length ?? 0) + 1
      this.pushMessage({ sessionId, seq, role: 'user', kind: 'text', payload: { text }, ts: this.now() })
      s.lastSeq = seq
      s.lastReadSeq = seq
      if (s.autoNamed && s.name === '새 세션') {
        s.name = text.slice(0, 40)
        this.emit({ type: 'session_title', sessionId, title: s.name })
      }
      this.emit({ type: 'state_change', sessionId, state: 'working' })
    },
    respondApproval: async (sessionId: string, requestId: string, decision: ApprovalDecision, _scope?: ApprovalScope) => {
      this.emit({ type: 'approval_resolved', sessionId, requestId, decision })
      this.emit({ type: 'turn_complete', sessionId })
    },
    interrupt: async (sessionId: string) => {
      this.emit({ type: 'state_change', sessionId, state: 'waiting_input', reason: 'interrupted' })
    },
    archiveSession: async (sessionId: string) => {
      const s = this.sessions.get(sessionId)
      if (s) {
        s.archived = true
        s.state = 'idle'
        s.waitingSince = null
      }
      this.emit({ type: 'state_change', sessionId, state: 'idle', reason: 'archived' })
    },
    resumeSession: async (sessionId: string) => {
      const s = this.sessions.get(sessionId)
      if (!s) throw Object.assign(new Error('세션 없음'), { code: 'session_not_found' })
      if (this.unresumable.has(sessionId)) {
        return { session: { ...s }, resumed: false, reason: '이 세션은 재개할 수 없습니다' }
      }
      s.live = true
      this.emit({ type: 'state_change', sessionId, state: 'idle', reason: 'resumed' })
      return { session: { ...s }, resumed: true }
    },
    rename: async (sessionId: string, name: string) => {
      const s = this.sessions.get(sessionId)
      if (s) {
        s.name = name
        s.autoNamed = false
      }
    },
    markRead: async (sessionId: string, seq: number) => {
      const s = this.sessions.get(sessionId)
      if (s) s.lastReadSeq = Math.max(s.lastReadSeq, seq)
    },
    listSessions: async () => [...this.sessions.values()].map((s) => ({ ...s })),
    loadMessages: async (sessionId: string, limit = 200, beforeSeq?: number) => {
      const all = this.messages.get(sessionId) ?? []
      const filtered = beforeSeq ? all.filter((m) => m.seq < beforeSeq) : all
      return filtered.slice(-limit)
    },
    capabilities: async (_tool: ToolName): Promise<AdapterCapabilities> => ({
      approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: ['image', 'file'],
    }),
    detect: async () => [
      { tool: 'claude' as const, installed: true, loggedIn: true, detail: 'mock 2.1.0' },
    ],
    subscribe: (handler: (e: NormalizedEvent) => void): Unsubscribe => {
      this.handlers.add(handler)
      return () => this.handlers.delete(handler)
    },
    onConnectionChange: (handler: (s: ConnectionState) => void): Unsubscribe => {
      this.connHandlers.add(handler)
      return () => this.connHandlers.delete(handler)
    },
  }

  readonly projects: ProjectPort = {
    add: async (path: string) => {
      const existing = this.projectsList.find((p) => p.path === path)
      if (existing) return existing
      const info: ProjectInfo = {
        id: `mock-project-${++this.idc}`, path, name: path.split('/').filter(Boolean).pop() ?? path,
        defaultTool: 'claude', git: { branch: 'main', changedFiles: 0, isRepo: true },
      }
      this.projectsList.push(info)
      return info
    },
    list: async () => this.projectsList.map((p) => ({ ...p })),
    gitStatus: async (projectId: string) => {
      const p = this.projectsList.find((x) => x.id === projectId)
      if (!p) throw Object.assign(new Error('프로젝트 없음'), { code: 'internal' })
      return { ...p }
    },
  }

  readonly system: SystemPort = {
    notify: async (title: string, body: string) => {
      this.notifications.push({ title, body })
    },
    setBadge: async (count: number) => {
      this.badge = count
    },
    openInIde: async (path: string, line?: number) => {
      this.opened.push({ path, line })
    },
    pickDirectory: async () => this.nextPickedDirectory,
  }

  /** 테스트가 들여다볼 수 있게 공개 */
  workspaceSnapshot: WorkspaceSnapshot | null = null

  readonly workspace = {
    save: async (s: WorkspaceSnapshot) => {
      this.workspaceSnapshot = s
    },
    load: async () => this.workspaceSnapshot,
  }

  async dispose(): Promise<void> {
    this.handlers.clear()
    this.connHandlers.clear()
  }

  /** 시나리오 헬퍼: 승인 요청을 만든다 (Playwright에서 사용) */
  requestApproval(sessionId: string, detail: ApprovalDetail, requestId = `req-${++this.idc}`): string {
    this.emit({ type: 'approval_request', sessionId, requestId, detail })
    return requestId
  }
}

export function createMockPlatform(opts?: MockOptions): MockPlatform {
  return new MockPlatform(opts)
}
