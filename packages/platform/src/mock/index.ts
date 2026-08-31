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
  UpdateStatus,
} from '@cc/protocol'
import {
  APP_VERSION,
  isNewerVersion,
  osPathBaseName,
  sessionLiveDefaults,
  wireBaseName,
  wireJoin,
  wireSegments,
} from '@cc/protocol'
import type { AgentPort, AlertKind, ConnectionState, FsEntry, FsFile, Platform, ProjectPort, SystemPort, TerminalPort, Unsubscribe, UpdatePort, WorkspaceSnapshot } from '../ports/index.js'

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
  /** 소개 화면에서 고른 오케스트레이터 도구 (#63) — 실물은 app_settings에 적는다 */
  orchestratorTool: ToolName = 'claude'
  /** 테스트용: 재개 불가로 만들 세션들 */
  readonly unresumable = new Set<string>()
  readonly notifications: { title: string; body: string }[] = []
  readonly opened: { path: string; line?: number }[] = []
  badge = 0
  /** 테스트용: projects.gitStatus를 몇 번 물었나 — 디바운스가 도는지 보는 눈 (이슈 #41) */
  gitStatusCalls = 0

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
    // 이 mock에는 물어볼 OS가 없다. 맥 표기를 답으로 정한다 — 개발도 E2E도 맥에서 돌고,
    // 이 자리에서 자판을 짐작하기 시작하면 테스트가 도는 기계에 따라 결과가 달라진다.
    shortcutKeys: { mod: '⌘', alt: '⌥', join: '' },
    // 같은 이유로 맥의 이름을 답으로 정한다 — E2E가 도는 기계를 짐작하기 시작하면
    // 화면에 뭐가 쓰일지가 테스트마다 달라진다.
    fileManagerName: 'Finder',
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
        } else if (event.type === 'context_update') {
          /*
           * 실물(host)과 같은 규칙: 컨텍스트 사용량은 **세션에 남는다** (이슈 #48).
           *
           * 목이 이걸 흘리는 동안, 목록을 다시 받는 모든 경로(앱 재시작·재연결)에서
           * 눈금이 `—`로 돌아갔다 — 실물은 그 값을 들고 있으므로, 이 자리가 비어 있으면
           * E2E는 실물이 만들 수 없는 상태를 정상으로 보고 지나간다.
           */
          s.context = { used: event.used, window: event.window, exactness: event.exactness }
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
          // 추론 요약 (#58) — 실물과 같은 규칙: 텍스트가 실렸을 때만 기록
          : event.type === 'reasoning_delta' && event.text ? ('reasoning' as const)
          // 시켜서 들어온 말 (FR-11). 실물 payload는 {text, from}이고 이벤트가 그 둘을
          // 그대로 갖고 있어, 복원(messagesToChat)이 같은 화면을 되살린다
          : event.type === 'user_message' ? ('text' as const)
          : event.type === 'compaction' ? ('marker' as const)
          // 이미지도 영속된다 (#40 2차). 실물은 파일+경로지만 목의 디스크는 메모리다 —
          // payload에 바이트를 그대로 두면 loadMessages가 실물과 같은 화면을 되살린다
          : event.type === 'message_image' ? ('image' as const)
          : null
        if (kind) {
          const seq = (this.messages.get(s.id)?.length ?? 0) + 1
          this.pushMessage({
            sessionId: s.id, seq,
            role:
              event.type === 'message_delta' || event.type === 'reasoning_delta' ? 'assistant'
              : event.type === 'user_message' ? 'user'
              : 'system',
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
  /** fs.watch로 등록된 감시 집합 (#34) — 테스트가 "화면이 뭘 감시해 달랬는지"를 본다 */
  watchedDirs = new Map<string, string[]>()

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

  /** 테스트용: 휴지통으로 보낸 것과 파일 관리자에서 열어본 것 (#18/#19) */
  readonly trashed: string[] = []
  readonly revealed: string[] = []

  /**
   * 루트 밖으로 나가는 경로는 **목에서도** 거절한다.
   *
   * 목에는 진짜 파일 시스템이 없으니 검사도 필요 없다고 넘길 뻔한 자리다. 그러면
   * "프로젝트 밖은 못 건드린다"가 실물에만 있는 규칙이 되고, 그 차이는 E2E(브라우저 목)에
   * 영원히 안 보인다 — 계약 테스트가 실제로 여기서 갈라진 것을 잡았다.
   * 문자열만 보고 판정할 수 있다: 조각을 세면서 `..`로 내려간 깊이가 음수가 되면 밖이다.
   *
   * The segments come from `wireSegments` rather than from a `/` written here (#47). Reading the
   * separator out of the protocol instead of assuming it is what makes this check the *same*
   * check the host runs: both sides now name one encoding, so a path that means two things on
   * two machines cannot mean the right thing here and the wrong thing there.
   */
  private requireInside(rel: string): void {
    const fail = () => {
      throw Object.assign(new Error('Path is outside the project'), { code: 'internal' })
    }
    if (rel.startsWith('/')) fail()
    let depth = 0
    for (const seg of wireSegments(rel)) {
      if (seg === '' || seg === '.') continue
      if (seg === '..') depth -= 1
      else depth += 1
      if (depth < 0) fail()
    }
  }

  /** `a/b/c.ts` → `a/b` (루트는 `''`) — 목의 entries가 부모 경로로 묶여 있으므로 */
  private parentOf(path: string): string {
    const cut = path.lastIndexOf('/')
    return cut < 0 ? '' : path.slice(0, cut)
  }

  /**
   * 목에서 항목 하나를 떼어낸다. 폴더면 그 아래 목록·파일까지 같이 따라온다 —
   * 실물에서 폴더를 옮기면 안의 것이 함께 가므로, 목이 껍데기만 옮기면
   * "옮겼는데 안이 비었다"가 **목에서만** 일어나지 않는 종류의 차이가 된다.
   */
  private detach(path: string): FsEntry | null {
    const parent = this.parentOf(path)
    const siblings = this.fsState.entries[parent] ?? []
    const entry = siblings.find((e) => e.path === path)
    if (!entry) return null
    this.fsState.entries[parent] = siblings.filter((e) => e.path !== path)
    return entry
  }

  /** 옮기거나 지울 때 딸려 가는 것들 — 하위 목록과 파일 내용 */
  private takeSubtree(path: string): { entries: Record<string, FsEntry[]>; files: Record<string, string> } {
    const under = (p: string) => p === path || p.startsWith(`${path}/`)
    const entries: Record<string, FsEntry[]> = {}
    const files: Record<string, string> = {}
    for (const [dir, list] of Object.entries(this.fsState.entries)) {
      if (!under(dir)) continue
      entries[dir] = list
      delete this.fsState.entries[dir]
    }
    for (const [file, text] of Object.entries(this.fsState.files)) {
      if (!under(file)) continue
      files[file] = text
      delete this.fsState.files[file]
    }
    return { entries, files }
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
    // 감시 집합을 기록만 한다 — 테스트는 emit으로 fs_changed를 직접 흘려 화면 반응을 본다
    watch: async (projectId: string, paths: string[]) => {
      this.watchedDirs.set(projectId, [...paths])
      return { watched: paths.length }
    },
    readFile: async (_projectId: string, path: string): Promise<FsFile> => ({
      text: this.fsState.files[path] ?? '',
      truncated: false,
      binary: false,
      bytes: (this.fsState.files[path] ?? '').length,
    }),
    /**
     * 실물(host의 `moveEntry`)과 **같은 거절 규칙**을 지킨다: 자리가 차 있으면 옮기지
     * 않고 무엇과 부딪혔는지 말하고, 폴더를 자기 안으로는 못 넣고, 제자리 드롭은
     * 실패가 아니라 `moved: false`다. 목이 실물보다 너그러우면 E2E는 초록인데
     * 실제 앱에서만 다르게 동작하는 자리가 생긴다.
     */
    move: async (_projectId: string, from: string, toDir: string) => {
      this.requireInside(from)
      this.requireInside(toDir)
      const name = wireBaseName(from)
      const path = wireJoin(toDir, name)
      if (path === from) return { path, moved: false }
      if (path.startsWith(`${from}/`)) {
        throw Object.assign(new Error(`Cannot move ${name} into itself`), { code: 'internal' })
      }
      if ((this.fsState.entries[toDir] ?? []).some((e) => e.path === path)) {
        throw Object.assign(new Error(`${path} already exists — nothing was moved`), { code: 'internal' })
      }
      const entry = this.detach(from)
      if (!entry) throw Object.assign(new Error(`${from} is no longer there`), { code: 'internal' })
      const sub = this.takeSubtree(from)
      const rekey = (p: string) => path + p.slice(from.length)
      for (const [dir, list] of Object.entries(sub.entries)) {
        this.fsState.entries[rekey(dir)] = list.map((e) => ({ ...e, path: rekey(e.path) }))
      }
      for (const [file, text] of Object.entries(sub.files)) this.fsState.files[rekey(file)] = text
      this.fsState.entries[toDir] = [...(this.fsState.entries[toDir] ?? []), { ...entry, path }]
      return { path, moved: true }
    },
    importFile: async (_projectId: string, toDir: string, name: string, dataBase64: string) => {
      this.requireInside(toDir)
      // 이름은 마지막 조각만 쓴다 — 실물과 같은 규칙이라, 이름에 경로가 섞여 와도
      // 목적지 밖으로 나가지 못한다
      const leaf = wireBaseName(name)
      const path = wireJoin(toDir, leaf)
      if ((this.fsState.entries[toDir] ?? []).some((e) => e.path === path)) {
        throw Object.assign(new Error(`${path} already exists — nothing was written`), { code: 'internal' })
      }
      this.fsState.entries[toDir] = [
        ...(this.fsState.entries[toDir] ?? []),
        { name: leaf, path, isDir: false, ignored: false },
      ]
      this.fsState.files[path] = atob(dataBase64)
      return { path }
    },
    trash: async (_projectId: string, path: string) => {
      this.requireInside(path)
      if (!this.detach(path)) throw Object.assign(new Error(`${path} is no longer there`), { code: 'internal' })
      this.takeSubtree(path)
      this.trashed.push(path)
      return { supported: true }
    },
    reveal: async (_projectId: string, path: string) => {
      this.requireInside(path)
      this.revealed.push(path)
      return { supported: true }
    },
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
        ? { path: `/mock/worktrees/${id}`, branch: params.worktreeBranch?.trim() || `centralu/${id.slice(-8)}` }
        : null
      /*
       * 실물과 같은 규칙 (#69, manager.managerFor): 워크트리 세션은 태어나는 순간부터
       * 매니저 아래에 선다. 매니저는 자식을 가진 보통 세션이고, 없으면 행만 만든다
       * (live=false — 프로세스는 말을 걸 때 태어난다).
       */
      let parentSessionId: string | null = null
      if (worktree && params.projectId) {
        const withKids = new Set([...this.sessions.values()].map((x) => x.parentSessionId).filter(Boolean))
        let mgr = [...this.sessions.values()].find(
          (x) => x.projectId === params.projectId && !x.worktree && withKids.has(x.id) && !x.archived,
        )
        if (!mgr) {
          const mgrId = `mock-manager-${++this.idc}`
          mgr = {
            id: mgrId, projectId: params.projectId, kind: 'worker', tool: params.tool, externalId: null,
            name: 'Worktrees', autoNamed: false, state: 'idle', archived: false, lastReadSeq: 0, lastSeq: 0,
            createdAt: this.now(), waitingSince: null, live: false, model: null, effort: null, verbosity: null,
            serviceTier: null, permissionPreset: 'normal', importedFrom: null, worktree: null,
            parentSessionId: null, ...sessionLiveDefaults(),
          }
          this.sessions.set(mgrId, mgr)
          this.emit({ type: 'session_created', sessionId: mgrId, session: mgr })
        }
        parentSessionId = mgr.id
      }
      const info: SessionInfo = {
        id, projectId: params.projectId, kind: 'worker', tool: params.tool, externalId: `ext-${id}`, worktree,
        parentSessionId,
        effort: params.effort ?? null, verbosity: params.verbosity ?? null, serviceTier: params.serviceTier ?? null,
        // 실물과 같은 규칙 (#69): 사람이 브랜치를 정했으면 그 이름이 세션 이름이고, 자동 이름이 덮지 않는다
        name: (params.worktreeBranch?.trim() || undefined) ?? params.initialPrompt?.slice(0, 40) ?? 'New session',
        autoNamed: !params.worktreeBranch?.trim(), state: 'idle',
        archived: false, lastReadSeq: 0, lastSeq: 0, createdAt: this.now(), waitingSince: null, live: true,
        model: params.model ?? null, permissionPreset: params.permissionPreset ?? 'normal',
        importedFrom: params.importHistory ? (params.resumeExternalId ?? null) : null,
        ...sessionLiveDefaults(),
      }
      if (params.resumeExternalId) info.externalId = params.resumeExternalId
      this.sessions.set(id, info)
      // 실물과 같은 규칙: 마지막에 고른 도구가 그 프로젝트의 기본값이 된다 (manager.createSession)
      const owner = this.projectsList.find((p) => p.id === params.projectId)
      if (owner) owner.defaultTool = params.tool
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
      /*
       * 실물과 같은 규칙: 도구를 바꾸면 이어갈 실마리를 끊고, **모델과 딸린 설정도 놓는다**
       * (실측으로 확인된 규칙 — manager.switchTool 주석 참고: 'sonnet'을 든 채 codex로
       * 가면 첫 턴이 400으로 죽는다). 워크트리는 디렉토리 사실이라 도구와 무관하다.
       */
      const next = {
        ...s, tool, externalId: null, importedFrom: null, live: false,
        model: null, effort: null, verbosity: null, serviceTier: null,
      }
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
        // 실물과 같은 규칙: 도구는 소개 화면의 선택을 따른다 (#63)
        id, projectId: null, kind: 'orchestrator' as const, tool: this.orchestratorTool, externalId: null, name: 'Orchestrator',
        autoNamed: false, state: 'idle' as const, archived: false, lastReadSeq: 0, lastSeq: 0,
        createdAt: this.now(), waitingSince: null, live: true, model: null, effort: null, verbosity: null, serviceTier: null,
        permissionPreset: 'normal' as const, importedFrom: null, worktree: null, parentSessionId: null,
        ...sessionLiveDefaults(),
      }
      this.sessions.set(id, info)
      return info
    },
    // 실물과 같은 규칙 (#63): 화면 열기는 묻기만 한다 — 만드는 것은 첫 질문의 orchestrator()다
    orchestratorPeek: async () => [...this.sessions.values()].find((x) => x.projectId === null) ?? null,
    configureOrchestrator: async (tool: ToolName) => {
      this.orchestratorTool = tool
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
              // 실측 모양 그대로: 티어는 큰 모델에만 있다 (priority = Fast, 1.5x)
              { id: 'gpt-5.6-terra', label: 'gpt-5.6-terra', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', tiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed, increased usage' }] },
              { id: 'gpt-5.6-terra-mini', label: 'gpt-5.6-terra-mini', efforts: [], defaultEffort: null, tiers: [] },
            ]
          : [
              { id: 'sonnet', label: 'Sonnet', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: null, tiers: [] },
              { id: 'opus', label: 'Opus', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: null, tiers: [] },
              { id: 'fable', label: 'Fable', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: null, tiers: [] },
              { id: 'haiku', label: 'Haiku', efforts: [], defaultEffort: null, tiers: [] },
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
      s: { model?: string | null; effort?: string | null; verbosity?: string | null; serviceTier?: string | null; permissionPreset?: PermissionPreset },
    ) => {
      const sess = this.sessions.get(sessionId)
      if (!sess) throw Object.assign(new Error('Session not found'), { code: 'session_not_found' })
      if (s.model !== undefined) sess.model = s.model
      if (s.effort !== undefined) sess.effort = s.effort
      if (s.verbosity !== undefined) sess.verbosity = s.verbosity
      if (s.serviceTier !== undefined) sess.serviceTier = s.serviceTier
      if (s.permissionPreset) sess.permissionPreset = s.permissionPreset
      return { ...sess }
    },
    setSessionKind: async (sessionId: string, kind: SessionInfo['kind']) => {
      const sess = this.sessions.get(sessionId)
      if (!sess) throw Object.assign(new Error('Session not found'), { code: 'session_not_found' })
      // 실물과 같은 규칙 (#13): 중앙 오케스트레이터는 역할을 못 바꾼다
      if (sess.projectId === null) {
        throw Object.assign(new Error('The central orchestrator cannot change roles'), { code: 'internal' })
      }
      sess.kind = kind
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
    capabilities: async (tool: ToolName): Promise<AdapterCapabilities> => ({
      approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: ['image', 'file'],
      // 실물과 같은 모양: codex만 응답 길이 노브가 있다 (#54) — UI가 이 배열로 행을 그린다
      verbosities: tool === 'codex' ? ['low', 'medium', 'high'] : [],
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

  /**
   * 프로젝트를 돌려줄 때 변경 수를 **gitState에서 다시 센다** (이슈 #41).
   *
   * 실물 host에서 사이드바의 숫자와 깃 패널의 목록은 같은 `git status` 한 번의 두 가지
   * 읽기다. 목이 숫자를 따로 들고 있으면 테스트가 파일 목록을 바꿔도 숫자는 옛것이
   * 남는데, 그건 실물이 만들 수 없는 불일치다 — 이 파일 머리말의 계약이 그것이다.
   */
  private withGit(p: ProjectInfo): ProjectInfo {
    return p.git ? { ...p, git: { ...p.git, changedFiles: this.gitState.files.length } } : { ...p }
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
      /*
       * The name is the directory's last segment under **either** separator (#47).
       *
       * This one is not a wire path — a project's directory is native, and it is the one string
       * that arrives here still spelled the way its own machine spells it. The host names the
       * project with `basename` from `node:path`, which reads `\` on Windows; reading only `/`
       * here meant the mock would have called a project `C:\Users\me\proj` while the host called
       * it `proj`, and e2e — which only ever runs the mock — would have stayed green about it.
       */
      const info: ProjectInfo = {
        id: `mock-project-${++this.idc}`, path, name: osPathBaseName(path) || path,
        defaultTool: 'claude', commands: [], worktreeSetup: null,
        git: { branch: 'main', changedFiles: 0, isRepo: true },
      }
      this.projectsList.push(info)
      return info
    },
    list: async () => this.projectsList.map((p) => this.withGit(p)),
    gitStatus: async (projectId: string) => {
      this.gitStatusCalls++
      const p = this.projectsList.find((x) => x.id === projectId)
      if (!p) throw Object.assign(new Error('Project not found'), { code: 'internal' })
      return this.withGit(p)
    },
    /**
     * 등록된 셸 명령 (이슈 #44).
     *
     * **host와 똑같이 빈 줄을 걷어낸다.** 목이 실물보다 너그러우면 E2E는 초록인데
     * 실제 앱에서만 다르게 동작하는 자리가 생긴다 — 이 파일 머리말의 계약이 그것이다.
     */
    setCommands: async (projectId: string, commands: string[]) => {
      const p = this.projectsList.find((x) => x.id === projectId)
      if (!p) throw Object.assign(new Error('Project not found'), { code: 'internal' })
      p.commands = commands.map((c) => c.trim()).filter(Boolean)
      return [...p.commands]
    },
    // 실물과 같은 규칙 (#69): 빈 설정은 null로 눕는다 — 목이 더 너그러우면 계약이 흩어진다
    setWorktreeSetup: async (projectId: string, setup: { command: string; copyFiles: string[] } | null) => {
      const p = this.projectsList.find((x) => x.id === projectId)
      if (!p) throw Object.assign(new Error('Project not found'), { code: 'internal' })
      const clean = setup
        ? { command: setup.command.trim(), copyFiles: setup.copyFiles.map((f) => f.trim()).filter(Boolean) }
        : null
      p.worktreeSetup = clean && (clean.command || clean.copyFiles.length) ? clean : null
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

  /** 자주 쓰는 명령어 실행 상태 (#60). 키는 실물과 같은 (projectId, command) 짝 */
  commandRuns = new Map<string, { command: string; runId: string; running: boolean; exitCode: number | null; startedAt: number; history: string }>()
  private runKey(projectId: string, command: string): string {
    return `${projectId}\u0000${command}`
  }
  /** 테스트용: 돌고 있는 실행이 출력을 뱉는 상황 (터미널과 같은 레인으로 나간다) */
  emitCommandOutput(projectId: string, command: string, data: string): void {
    const r = this.commandRuns.get(this.runKey(projectId, command))
    if (!r) return
    r.history += data
    for (const h of this.termHandlers) h({ terminalId: r.runId, data })
  }
  /** 테스트용: 실행이 끝나는 상황 — 단발성 명령의 결말 */
  exitCommand(projectId: string, command: string, exitCode: number): void {
    const r = this.commandRuns.get(this.runKey(projectId, command))
    if (!r || !r.running) return
    r.running = false
    r.exitCode = exitCode
    for (const h of this.termExitHandlers) h({ terminalId: r.runId, exitCode })
  }

  // 실물과 같은 계약 (#60): 명령별 마지막 실행 하나, 재실행은 죽이고 교체, 로그는 살아있는 동안
  readonly commands = {
    run: async (projectId: string, command: string, _cols: number, _rows: number) => {
      const r = {
        command,
        runId: `mock-run-${++this.idc}`,
        running: true,
        exitCode: null as number | null,
        startedAt: this.now(),
        history: '',
      }
      this.commandRuns.set(this.runKey(projectId, command), r)
      const { history: _h, ...rest } = r
      return rest
    },
    stop: async (projectId: string, command: string) => {
      // 실물은 kill 뒤 onExit이 온다 — 목은 그 결말을 바로 낸다 (130 = SIGINT 관례)
      this.exitCommand(projectId, command, 130)
    },
    state: async (projectId: string) => {
      const out = []
      for (const [k, r] of this.commandRuns) {
        if (!k.startsWith(`${projectId}\u0000`)) continue
        const { history: _h, ...rest } = r
        out.push(rest)
      }
      return out
    },
    log: async (projectId: string, command: string) => {
      const r = this.commandRuns.get(this.runKey(projectId, command))
      return r ? { ...r } : null
    },
    resize: async () => {},
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

  /** Public so tests can look inside */
  workspaceSnapshot: WorkspaceSnapshot | null = null

  /**
   * The snapshot also survives a reload through localStorage when the page has one
   * (issue #20). The real host keeps it on disk, so "the arrangement survives a
   * relaunch" is only testable against this mock if the mock's snapshot outlives the
   * page too. Unit tests run in node, where touching `localStorage` throws — the
   * try/catch keeps the in-memory field serving them alone, exactly as before.
   */
  readonly workspace = {
    save: async (s: WorkspaceSnapshot) => {
      this.workspaceSnapshot = s
      try {
        localStorage.setItem('cc-mock-workspace', JSON.stringify(s))
      } catch {
        /* node, or storage denied — the in-memory copy still works */
      }
    },
    load: async (): Promise<WorkspaceSnapshot | null> => {
      if (this.workspaceSnapshot) return this.workspaceSnapshot
      try {
        const raw = localStorage.getItem('cc-mock-workspace')
        return raw ? (JSON.parse(raw) as WorkspaceSnapshot) : null
      } catch {
        return null
      }
    },
  }

  /**
   * 테스트용: 레지스트리가 `latest`로 들고 있는 척할 버전 (이슈 #43).
   * null이면 못 닿은 것 — '최신이다'와 다르다.
   */
  registryVersion: string | null = null

  /** 테스트용: `npm i -g`가 실패하는 상황 (진짜로 돌리지는 않는다) */
  updateFails: string | null = null

  private updateStatus: UpdateStatus = {
    current: APP_VERSION,
    latest: null,
    newer: false,
    auto: true,
    phase: 'idle',
    error: null,
    checkedAt: null,
  }

  /**
   * 앱 업데이트 (이슈 #43).
   *
   * **실물과 같은 규칙을 지킨다.** 특히 두 가지: 비교는 protocol의 것을 쓰고
   * (`isNewerVersion` — 목이 자기 규칙을 만들면 갈라지는 것이 안 보인다), 설치는
   * **끝나기 전에** 답하고 나머지는 이벤트로 보낸다. 여기서 `npm i -g`를 흉내만 내는
   * 것이 아니라 아예 돌리지 않는 것도 계약이다 — 테스트가 기계를 고쳐서는 안 된다.
   */
  readonly updates: UpdatePort = {
    status: async (force = false) => {
      // 실물과 같다: 자동 확인이 꺼져 있으면 사람이 누르기 전엔 아무 데도 안 묻는다
      if (!force && !this.updateStatus.auto) return { ...this.updateStatus }
      if (!force && this.updateStatus.checkedAt !== null) return { ...this.updateStatus }
      if (this.updateStatus.phase === 'updating' || this.updateStatus.phase === 'restart_required') {
        return { ...this.updateStatus }
      }
      return this.runUpdateCheck()
    },
    setAuto: async (enabled: boolean) => {
      if (this.updateStatus.auto === enabled) return { ...this.updateStatus }
      this.setUpdateStatus({ auto: enabled })
      // 켠 사람은 지금 묻고 있는 것이다 — 6시간 뒤가 아니라
      return enabled ? this.runUpdateCheck() : { ...this.updateStatus }
    },
    apply: async () => {
      if (this.updateStatus.phase === 'updating') return { ...this.updateStatus }
      const latest = this.updateStatus.latest
      if (!this.updateStatus.newer || !latest) {
        this.setUpdateStatus({ phase: 'failed', error: 'There is no newer version to install' })
        return { ...this.updateStatus }
      }
      this.setUpdateStatus({ phase: 'updating', error: null })
      /*
       * 끝은 **답을 준 뒤에** 알린다. 설치는 RPC 제한 시간을 넘기는 일이라 실물도 그렇게
       * 동작하고, 그래서 "설치 중 → 다시 시작하세요"는 이벤트로만 도착한다.
       */
      setTimeout(() => {
        if (this.updateFails) this.setUpdateStatus({ phase: 'failed', error: this.updateFails })
        else this.setUpdateStatus({ phase: 'restart_required', error: null })
      }, 0)
      return { ...this.updateStatus }
    },
  }

  private runUpdateCheck(): UpdateStatus {
    if (this.registryVersion === null) {
      // 못 닿았다 — 지난번에 알아낸 것은 그대로 둔다 (실물과 같은 규칙)
      this.setUpdateStatus({ phase: 'idle', error: 'Could not reach the registry — check the network' })
      return { ...this.updateStatus }
    }
    this.setUpdateStatus({
      latest: this.registryVersion,
      newer: isNewerVersion(this.registryVersion, this.updateStatus.current),
      phase: 'idle',
      error: null,
      checkedAt: this.now(),
    })
    return { ...this.updateStatus }
  }

  private setUpdateStatus(patch: Partial<UpdateStatus>): void {
    this.updateStatus = { ...this.updateStatus, ...patch }
    this.emit({ type: 'update_status', status: { ...this.updateStatus } })
  }

  /** 시나리오 헬퍼: 레지스트리에 새 버전이 올라온 상황을 만든다 (Playwright에서 사용) */
  offerUpdate(version: string): void {
    this.registryVersion = version
    this.runUpdateCheck()
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
