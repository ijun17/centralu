import type {
  AdapterCapabilities,
  Attachment,
  PermissionPreset,
  GitBranch,
  GitCommit,
  GitDiff,
  GitFileStatus,
  ApprovalDecision,
  ApprovalDetail,
  ApprovalScope,
  CreateSessionParams,
  ExternalSession,
  NormalizedEvent,
  ProjectInfo,
  SessionInfo,
  StoredMessage,
  UsageSnapshot,
  ToolName,
  QuestionAnswer,
} from '@cc/protocol'
import { sessionLiveDefaults } from '@cc/protocol'
import type { AgentPort, AlertKind, ConnectionState, FsEntry, FsFile, Platform, ProjectPort, SystemPort, TerminalPort, Unsubscribe, WorkspaceSnapshot } from '../ports/index.js'

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
  sessions = new Map<string, SessionInfo>()
  private gridPanels: string[] = []
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
    // A browser has no window controls to leave room for, and E2E runs against this
    // mock — so the header it measures starts at the window edge.
    windowControlsInset: 0,
  }

  /** 테스트가 이벤트를 주입하는 통로 */
  emit(event: NormalizedEvent): void {
    let out = event
    if (event.sessionId) {
      const s = this.sessions.get(event.sessionId)
      if (s) {
        if (event.type === 'approval_request') {
          s.state = 'waiting_approval'
          s.waitingSince ??= this.now()
          s.pendingApproval = { requestId: event.requestId, detail: event.detail }
        } else if (event.type === 'approval_resolved') {
          if (s.pendingApproval?.requestId === event.requestId) s.pendingApproval = null
        } else if (event.type === 'turn_complete') {
          s.state = 'waiting_input'
          s.waitingSince ??= this.now()
        } else if (event.type === 'message_delta' || event.type === 'tool_call') {
          s.state = 'working'
          s.waitingSince = null
        }
        /*
         * 실물(host)과 같은 규칙: 기록으로 남는 이벤트에는 세션 내 seq를 매겨 방송에 싣는다.
         * UI의 안읽음 추적(lastSeq)은 이 seq만 믿는다 — 목이 안 실어 보내면
         * 실물에서는 잡힐 버그가 테스트에서만 조용히 지나간다.
         */
        const kind =
          event.type === 'tool_call' ? ('tool_call' as const)
          : event.type === 'tool_result' ? ('tool_result' as const)
          : event.type === 'approval_request' || event.type === 'approval_resolved' ? ('approval' as const)
          : event.type === 'message_delta' ? ('text' as const)
          : event.type === 'compaction' ? ('marker' as const)
          : null
        if (kind) {
          const seq = (this.messages.get(s.id)?.length ?? 0) + 1
          this.pushMessage({
            sessionId: s.id, seq, role: event.type === 'message_delta' ? 'assistant' : 'system',
            kind, payload: event, ts: this.now(),
          })
          s.lastSeq = seq
          out = { ...event, seq } as NormalizedEvent
        }
      }
    }
    for (const h of this.handlers) h(out)
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

  readonly savedAttachments: Attachment[] = []
  readonly sentAttachments: Attachment[] = []

  /** 테스트가 주무르는 가짜 파일 트리 */
  fsState: { entries: Record<string, FsEntry[]>; files: Record<string, string> } = { entries: {}, files: {} }

  /** 테스트용 검색·규칙 상태 */
  searchResults: { sessionId: string; seq: number; snippet: string }[] = []
  rulesList: { id: number; scope: string; matcher: string; decision: string; createdAt: number }[] = []

  readonly search = {
    messages: async (query: string) =>
      this.searchResults.filter((r) => r.snippet.includes(query)),
  }

  readonly rules = {
    list: async () => [...this.rulesList],
    remove: async (id: number) => {
      this.rulesList = this.rulesList.filter((r) => r.id !== id)
    },
  }

  readonly fs = {
    search: async (_projectId: string, query: string, limit = 20) => {
      // 목은 실제 퍼지 매칭을 흉내내지 않는다 — 검증 대상은 UI 흐름이다
      const all = Object.values(this.fsState.entries).flat().filter((e) => !e.isDir)
      const q = query.toLowerCase()
      return all
        .filter((e) => e.path.toLowerCase().includes(q))
        .slice(0, limit)
        .map((e) => ({ path: e.path, name: e.name }))
    },
    listDir: async (_projectId: string, path: string) => this.fsState.entries[path] ?? [],
    readFile: async (_projectId: string, path: string): Promise<FsFile> => ({
      text: this.fsState.files[path] ?? '',
      truncated: false,
      binary: false,
      bytes: (this.fsState.files[path] ?? '').length,
    }),
  }

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

  /** 테스트용: 사용량 (supported=false로 '못 가져옴'도 재현한다) */
  usageState: { supported: boolean; reason?: string; usage: UsageSnapshot | null } = {
    supported: true,
    usage: { plan: 'max', windows: [], daily: [] },
  }

  /** 테스트용: 슬래시 명령 목록 (ready=false로 '아직 준비 안 됨'도 재현한다) */
  commandState: { ready: boolean; commands: { name: string; description: string; argumentHint: string }[] } = {
    ready: true,
    commands: [],
  }

  /** 테스트용: 재시작을 요청받은 세션 */
  restarted: string[] = []

  /** 테스트용: 마지막 createSession 파라미터 (고른 값이 실제로 전달됐는지 확인) */
  lastCreateParams: CreateSessionParams | null = null
  /** 테스트가 "커밋 안 된 변경이 있는 워크트리"를 만들 수 있게 하는 손잡이 */
  mockWorktreeDirty = false

  /** 테스트용: 도구가 갖고 있는 척할 이전 세션. supported=false로 구버전 도구도 재현한다 */
  externalSessions: { supported: boolean; reason?: string; sessions: ExternalSession[] } = {
    supported: true,
    sessions: [],
  }
  /** 불러오기를 고른 세션의 이전 대화 (externalId → 줄 목록) */
  externalHistory = new Map<string, { role: 'user' | 'assistant'; text: string }[]>()

  readonly agents: AgentPort = {
    createSession: async (params: CreateSessionParams) => {
      this.lastCreateParams = params
      const id = `mock-session-${++this.idc}`
      const worktree = params.worktree
        ? { path: `/mock/worktrees/${id}`, branch: `centralu/${id.slice(-8)}` }
        : null
      const info: SessionInfo = {
        id, projectId: params.projectId, tool: params.tool, externalId: `ext-${id}`, worktree,
        effort: params.effort ?? null,
        name: params.initialPrompt?.slice(0, 40) ?? 'New session', autoNamed: true, state: 'idle',
        archived: false, lastReadSeq: 0, lastSeq: 0, createdAt: this.now(), waitingSince: null, live: true,
        model: params.model ?? null, permissionPreset: params.permissionPreset ?? 'normal',
        importedFrom: params.importHistory ? (params.resumeExternalId ?? null) : null,
        ...sessionLiveDefaults(),
      }
      if (params.resumeExternalId) info.externalId = params.resumeExternalId
      this.sessions.set(id, info)
      // 불러오기: 이전 대화를 이미 읽은 상태로 복원한다 (host의 importHistory와 같은 규칙)
      if (params.importHistory && params.resumeExternalId) {
        const history = this.externalHistory.get(params.resumeExternalId) ?? []
        for (const h of history) {
          const seq = (this.messages.get(id)?.length ?? 0) + 1
          this.pushMessage({ sessionId: id, seq, role: h.role, kind: 'text', payload: { text: h.text }, ts: this.now() })
          info.lastSeq = seq
          info.lastReadSeq = seq
        }
        const firstUser = history.find((h) => h.role === 'user')
        const listed = this.externalSessions.sessions.find((s) => s.externalId === params.resumeExternalId)
        if (listed) info.name = listed.title
        else if (firstUser) info.name = firstUser.text.slice(0, 40)
      }
      if (params.initialPrompt) await this.agents.send(id, params.initialPrompt)
      return info
    },
    saveAttachment: async (_sessionId: string, name: string, mime: string, dataBase64: string) => {
      const att = { kind: mime.startsWith('image/') ? ('image' as const) : ('file' as const), path: `/tmp/att/${name}`, name, mime, bytes: dataBase64.length }
      this.savedAttachments.push(att)
      return att
    },
    send: async (sessionId: string, text: string, attachments?: Attachment[]) => {
      if (attachments?.length) this.sentAttachments.push(...attachments)
      const s = this.sessions.get(sessionId)
      if (!s) throw Object.assign(new Error('Session not found'), { code: 'session_not_found' })
      // host와 같은 규칙: 잠들어 있으면 되살리고 나서 보낸다 (자동 이어가기)
      if (!s.live) {
        if (this.unresumable.has(sessionId)) {
          throw Object.assign(new Error('Could not resume the conversation: this session cannot be resumed'), {
            code: 'session_not_found',
          })
        }
        s.live = true
      }
      const seq = (this.messages.get(sessionId)?.length ?? 0) + 1
      this.pushMessage({ sessionId, seq, role: 'user', kind: 'text', payload: { text }, ts: this.now() })
      s.lastSeq = seq
      s.lastReadSeq = seq
      if (s.autoNamed && s.name === 'New session') {
        s.name = text.slice(0, 40)
        this.emit({ type: 'session_title', sessionId, title: s.name, auto: true })
      }
      this.emit({ type: 'state_change', sessionId, state: 'working' })
    },
    respondApproval: async (sessionId: string, requestId: string, decision: ApprovalDecision, _scope?: ApprovalScope) => {
      this.emit({ type: 'approval_resolved', sessionId, requestId, decision })
      this.emit({ type: 'turn_complete', sessionId })
    },
    answerQuestion: async (sessionId: string, requestId: string, answers: QuestionAnswer[]) => {
      this.emit({ type: 'question_resolved', sessionId, requestId })
      // 무엇이 돌아갔는지 화면에서 확인할 수 있어야 한다 (표시만 되고 답이 안 가면 반쪽이다)
      this.emit({
        type: 'message_delta',
        sessionId,
        role: 'assistant',
        text: `답 받음: ${answers.map((a) => a.answers.join('+')).join(' | ')}`,
      })
      this.emit({ type: 'turn_complete', sessionId })
    },
    reorderSessions: async (projectId: string, orderedIds: string[]) => {
      const mine = [...this.sessions.values()].filter((s) => s.projectId === projectId)
      const rank = new Map(orderedIds.map((id, i) => [id, i]))
      mine.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
      const others = [...this.sessions.entries()].filter(([, s]) => s.projectId !== projectId)
      this.sessions = new Map([...others, ...mine.map((s) => [s.id, s] as const)])
      return [...this.sessions.values()]
    },
    switchTool: async (sessionId: string, tool: ToolName) => {
      const s = this.sessions.get(sessionId)
      if (!s) throw Object.assign(new Error('Session not found'), { code: 'session_not_found' })
      // 실물과 같은 규칙: 도구를 바꾸면 이어갈 실마리를 끊는다
      const next = { ...s, tool, externalId: null, importedFrom: null, worktree: null, live: false }
      this.sessions.set(sessionId, next)
      this.emit({ type: 'state_change', sessionId, state: 'idle', reason: 'tool_changed' })
      return next
    },
    orchestrator: async () => {
      // 실물과 같은 규칙: 없으면 그 자리에서 만든다. 프로젝트에는 속하지 않는다
      const found = [...this.sessions.values()].find((x) => x.projectId === null)
      if (found) return found
      const id = `orc-${++this.idc}`
      const info = {
        id, projectId: null, tool: 'claude' as const, externalId: null, name: 'Orchestrator',
        autoNamed: false, state: 'idle' as const, archived: false, lastReadSeq: 0, lastSeq: 0,
        createdAt: this.now(), waitingSince: null, live: true, model: null, effort: null,
        permissionPreset: 'normal' as const, importedFrom: null, worktree: null,
        ...sessionLiveDefaults(),
      }
      this.sessions.set(id, info)
      return info
    },
    grid: async () => [...this.gridPanels],
    setGridView: async (sessionIds: string[]) => {
      this.gridPanels = sessionIds.filter((id) => this.sessions.has(id))
      return [...this.gridPanels]
    },
    models: async (tool: ToolName) => ({
      supported: true,
      models:
        tool === 'codex'
          ? [
              { id: 'gpt-5.6-terra', label: 'gpt-5.6-terra', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
              { id: 'gpt-5.6-terra-mini', label: 'gpt-5.6-terra-mini', efforts: [], defaultEffort: null },
            ]
          : [
              { id: 'sonnet', label: 'Sonnet', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: null },
              { id: 'opus', label: 'Opus', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: null },
              { id: 'fable', label: 'Fable', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: null },
              { id: 'haiku', label: 'Haiku', efforts: [], defaultEffort: null },
            ],
    }),
    interrupt: async (sessionId: string) => {
      this.emit({ type: 'state_change', sessionId, state: 'waiting_input', reason: 'interrupted' })
    },
    archiveSession: async (sessionId: string, archived = true) => {
      const s = this.sessions.get(sessionId)
      if (s) {
        s.archived = archived
        s.state = 'idle'
        s.waitingSince = null
        if (archived) s.live = false
      }
      this.emit({ type: 'state_change', sessionId, state: 'idle', reason: 'archived' })
    },
    /** 목에서도 워크트리를 흉내낸다 — UI가 "물어보고 지운다"를 시험할 수 있어야 한다 */
    worktreeStatus: async (sessionId: string) => {
      const s = this.sessions.get(sessionId)
      if (!s?.worktree) return null
      return { ...s.worktree, dirty: this.mockWorktreeDirty, changedFiles: this.mockWorktreeDirty ? 2 : 0 }
    },
    deleteSession: async (sessionId: string, _deleteWorktree = false) => {
      this.sessions.delete(sessionId)
      this.messages.delete(sessionId)
      this.emit({ type: 'session_deleted', sessionId })
    },
    updateSettings: async (
      sessionId: string,
      s: { model?: string | null; effort?: string | null; permissionPreset?: PermissionPreset },
    ) => {
      const sess = this.sessions.get(sessionId)
      if (!sess) throw Object.assign(new Error('Session not found'), { code: 'session_not_found' })
      if (s.model !== undefined) sess.model = s.model
      if (s.effort !== undefined) sess.effort = s.effort
      if (s.permissionPreset) sess.permissionPreset = s.permissionPreset
      return { ...sess }
    },
    restartSession: async (sessionId: string) => {
      const s = this.sessions.get(sessionId)
      if (!s) throw Object.assign(new Error('Session not found'), { code: 'session_not_found' })
      this.restarted.push(sessionId)
      if (this.unresumable.has(sessionId)) {
        return { session: { ...s }, resumed: false, reason: 'This session cannot be resumed' }
      }
      s.live = true
      return { session: { ...s }, resumed: true }
    },
    resumeSession: async (sessionId: string) => {
      const s = this.sessions.get(sessionId)
      if (!s) throw Object.assign(new Error('Session not found'), { code: 'session_not_found' })
      if (this.unresumable.has(sessionId)) {
        return { session: { ...s }, resumed: false, reason: 'This session cannot be resumed' }
      }
      s.live = true
      this.emit({ type: 'state_change', sessionId, state: 'idle', reason: 'resumed' })
      return { session: { ...s }, resumed: true }
    },
    /** 잠긴 대화에서 갈라져 나온다 — 사본을 가리키게 되므로 잠금이 풀린 것과 같아진다 */
    forkConversation: async (sessionId: string) => {
      const s = this.sessions.get(sessionId)
      if (!s) throw Object.assign(new Error('Session not found'), { code: 'session_not_found' })
      this.unresumable.delete(sessionId)
      s.live = true
      this.emit({ type: 'state_change', sessionId, state: 'idle', reason: 'resumed' })
      return { session: { ...s }, resumed: true }
    },
    /*
      실패는 실패로 돌려준다 — host(manager.rename)와 같은 규칙이다.
      조용히 넘기면 "이름을 바꿨는데 목록은 그대로"가 mock에서만 재현되지 않아,
      실제 앱에서만 터지는 종류의 버그가 된다.
    */
    rename: async (sessionId: string, name: string) => {
      const s = this.sessions.get(sessionId)
      if (!s) throw Object.assign(new Error(`Session not found: ${sessionId}`), { code: 'session_not_found' })
      const next = name.trim()
      if (!next) throw Object.assign(new Error('Session name cannot be empty'), { code: 'internal' })
      s.name = next
      s.autoNamed = false
      this.emit({ type: 'session_title', sessionId, title: next, auto: false })
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
    listExternalSessions: async (_projectId: string, tool: ToolName, _limit = 30) => {
      // host와 같은 규칙: 숨기지 않은 세션이 들고 있는 원본은 '이미 열려 있음'이다
      const known = new Map<string, string>()
      for (const s of this.sessions.values()) {
        if (s.tool !== tool || s.archived) continue
        for (const key of [s.importedFrom, s.externalId]) {
          if (key && !known.has(key)) known.set(key, s.id)
        }
      }
      return {
        ...this.externalSessions,
        sessions: this.externalSessions.sessions
          .filter((s) => s.tool === tool)
          .map((s) => ({ ...s, imported: known.has(s.externalId), importedAs: known.get(s.externalId) ?? null })),
      }
    },
    commands: async (_sessionId: string) => ({ ...this.commandState }),
    usage: async (_tool: ToolName) => ({ ...this.usageState }),
    capabilities: async (_tool: ToolName): Promise<AdapterCapabilities> => ({
      approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: ['image', 'file'],
    }),
    detect: async () => [
      { tool: 'claude' as const, installed: true, loggedIn: true, detail: 'mock 2.1.0' },
      { tool: 'codex' as const, installed: true, loggedIn: true, detail: 'mock codex' },
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
    reorder: async (orderedIds: string[]) => {
      const rank = new Map(orderedIds.map((id, i) => [id, i]))
      this.projectsList.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
      return [...this.projectsList]
    },
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
      if (!p) throw Object.assign(new Error('Project not found'), { code: 'internal' })
      return { ...p }
    },
  }

  /**
   * 목 터미널. 진짜 셸을 띄우지 않고 **cwd로 묶이는 성질**만 흉내낸다 —
   * 검증하려는 것은 "세션을 바꿔도 같은 터미널이 이어지는가"이지 셸 자체가 아니다.
   */
  terminalState: {
    byCwd: Map<string, { id: string; title: string; history: string; alive: boolean }[]>
    input: { terminalId: string; data: string }[]
    resized: { terminalId: string; cols: number; rows: number }[]
    closed: string[]
  } = { byCwd: new Map(), input: [], resized: [], closed: [] }
  private termHandlers = new Set<(e: { terminalId: string; data: string }) => void>()
  private termExitHandlers = new Set<(e: { terminalId: string; exitCode: number | null }) => void>()

  /** 테스트용: 터미널이 뭔가 출력한 상황을 만든다 */
  emitTerminal(terminalId: string, data: string): void {
    for (const [, list] of this.terminalState.byCwd) {
      for (const t of list) if (t.id === terminalId) t.history += data
    }
    for (const h of this.termHandlers) h({ terminalId, data })
  }

  private cwdOf(projectId: string): string {
    return this.projectsList.find((p) => p.id === projectId)?.path ?? projectId
  }

  readonly terminal: TerminalPort = {
    list: async (projectId: string) => {
      const cwd = this.cwdOf(projectId)
      return (this.terminalState.byCwd.get(cwd) ?? []).map((t) => ({
        terminalId: t.id, cwd, title: t.title, history: t.history, alive: t.alive,
      }))
    },
    create: async (projectId: string) => {
      const cwd = this.cwdOf(projectId)
      const list = this.terminalState.byCwd.get(cwd) ?? []
      const t = { id: `mock-term-${++this.idc}`, title: `Terminal ${list.length + 1}`, history: '', alive: true }
      list.push(t)
      this.terminalState.byCwd.set(cwd, list)
      return { terminalId: t.id, cwd, title: t.title, history: t.history, alive: true }
    },
    close: async (terminalId: string) => {
      this.terminalState.closed.push(terminalId)
      for (const [cwd, list] of this.terminalState.byCwd) {
        const next = list.filter((t) => t.id !== terminalId)
        if (next.length === list.length) continue
        next.forEach((t, i) => (t.title = `Terminal ${i + 1}`))
        if (next.length === 0) this.terminalState.byCwd.delete(cwd)
        else this.terminalState.byCwd.set(cwd, next)
      }
    },
    input: async (terminalId: string, data: string) => {
      this.terminalState.input.push({ terminalId, data })
    },
    resize: async (terminalId: string, cols: number, rows: number) => {
      this.terminalState.resized.push({ terminalId, cols, rows })
    },
    restart: async (terminalId: string) => {
      for (const [cwd, list] of this.terminalState.byCwd) {
        for (const t of list) {
          if (t.id !== terminalId) continue
          t.alive = true
          return { terminalId: t.id, cwd, title: t.title, history: t.history, alive: true }
        }
      }
      throw Object.assign(new Error('Terminal not found'), { code: 'internal' })
    },
    onOutput: (h: (e: { terminalId: string; data: string }) => void) => {
      this.termHandlers.add(h)
      return () => this.termHandlers.delete(h)
    },
    onExit: (h: (e: { terminalId: string; exitCode: number | null }) => void) => {
      this.termExitHandlers.add(h)
      return () => this.termExitHandlers.delete(h)
    },
  }

  readonly system: SystemPort = {
    notify: async (title: string, body: string) => {
      this.notifications.push({ title, body })
    },
    alert: async (kind: AlertKind, sound: boolean) => {
      this.alerts.push({ kind, sound })
    },
    setBadge: async (count: number) => {
      this.badge = count
    },
    openInIde: async (path: string, line?: number) => {
      this.opened.push({ path, line })
    },
    startWindowDrag: async () => {
      // 창을 끈 횟수 — "칸을 옮기려 했는데 앱 창이 움직였다"를 테스트가 볼 수 있어야 한다
      this.windowDrags++
    },
    pickDirectory: async () => this.nextPickedDirectory,
  }

  /** 창 끌기가 몇 번 시작됐나 (Playwright에서 확인) */
  windowDrags = 0

  /** 소리·독으로 부른 기록 — 배너가 죽어 있어도 이쪽은 울려야 한다 */
  alerts: { kind: AlertKind; sound: boolean }[] = []

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
