import type {
  AdapterCapabilities,
  ApprovalDecision,
  ApprovalScope,
  Attachment,
  CreateSessionParams,
  ExternalSession,
  PermissionPreset,
  GitBranch,
  GitCommit,
  GitDiff,
  GitFileStatus,
  NormalizedEvent,
  ProjectInfo,
  SessionInfo,
  StoredMessage,
  ToolName,
} from '@cc/protocol'

/**
 * Platform 포트 (docs/platform-abstraction.md §2).
 * ui가 아는 유일한 외부 세계. 구현(web/tauri/mock)은 apps 진입점만 안다.
 *
 * 규칙:
 *  - 모든 메서드는 Promise 반환 (동기 구현이라도 — IPC로 바뀌어도 시그니처 불변)
 *  - 스트림은 subscribe(handler): Unsubscribe 형태로 통일
 *  - 입출력 타입은 전부 protocol의 것. 구현 세부(WS 프레임, invoke 이름) 노출 금지
 */

export type Unsubscribe = () => void

export type PlatformError = {
  code: string
  message: string
  retryable: boolean
}

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'resync_required'

export interface AgentPort {
  createSession(params: CreateSessionParams): Promise<SessionInfo>
  send(sessionId: string, text: string, attachments?: Attachment[]): Promise<void>
  /** 붙여넣은 이미지를 저장하고 경로를 받는다 (base64를 대화 기록에 넣지 않기 위해) */
  saveAttachment(sessionId: string, name: string, mime: string, dataBase64: string): Promise<Attachment>
  respondApproval(
    sessionId: string,
    requestId: string,
    decision: ApprovalDecision,
    scope?: ApprovalScope,
    /** '항상 허용'의 대상 패턴 (core가 계산) */
    matcher?: string,
  ): Promise<void>
  interrupt(sessionId: string): Promise<void>
  archiveSession(sessionId: string): Promise<void>
  /** 완전 삭제 — 아카이브와 달리 기록도 사라진다 */
  deleteSession(sessionId: string): Promise<void>
  /**
   * 도구가 보관 중인 이전 세션 (터미널에서 만든 것 포함).
   * supported=false면 이유가 함께 온다 — 구버전 도구에서도 '새 세션'은 막지 않는다.
   */
  listExternalSessions(
    projectId: string,
    tool: ToolName,
    limit?: number,
  ): Promise<{ supported: boolean; reason?: string; sessions: ExternalSession[] }>
  /** 죽은 세션을 되살린다 (FR-10). resumed=false면 이유가 함께 온다 */
  resumeSession(sessionId: string): Promise<{ session: SessionInfo; resumed: boolean; reason?: string }>
  /** 모델·권한을 대화 도중에 바꾼다 (FR-7) */
  updateSettings(
    sessionId: string,
    settings: { model?: string | null; permissionPreset?: PermissionPreset },
  ): Promise<SessionInfo>
  rename(sessionId: string, name: string): Promise<void>
  markRead(sessionId: string, seq: number): Promise<void>
  listSessions(): Promise<SessionInfo[]>
  loadMessages(sessionId: string, limit?: number, beforeSeq?: number): Promise<StoredMessage[]>
  capabilities(tool: ToolName): Promise<AdapterCapabilities>
  detect(): Promise<{ tool: ToolName; installed: boolean; loggedIn: boolean; detail: string }[]>
  /** 이벤트 스트림 — 구독 시점 이후의 이벤트를 받는다 */
  subscribe(handler: (event: NormalizedEvent) => void): Unsubscribe
  onConnectionChange(handler: (state: ConnectionState) => void): Unsubscribe
}

export interface ProjectPort {
  add(path: string): Promise<ProjectInfo>
  list(): Promise<ProjectInfo[]>
  gitStatus(projectId: string): Promise<ProjectInfo>
}

/**
 * 파일 트리·뷰어 (FR-5, FR-6 / C-1).
 * lazy 목록이 원칙 — 열어본 디렉토리만 읽는다 (대형 저장소에서 가벼움 유지).
 */
export interface FsPort {
  /** 한 단계만 읽는다. ignored는 .gitignore에 걸리는 항목 (git이 알려준 것을 재사용) */
  listDir(projectId: string, relPath: string): Promise<FsEntry[]>
  readFile(projectId: string, relPath: string): Promise<FsFile>
}

export type FsEntry = { name: string; path: string; isDir: boolean; ignored: boolean }
export type FsFile = { text: string; truncated: boolean; binary: boolean; bytes: number }

export interface SystemPort {
  notify(title: string, body: string): Promise<void>
  setBadge(count: number): Promise<void>
  openInIde(path: string, line?: number): Promise<void>
  /** 디렉토리 선택. 데스크톱은 네이티브 피커, 웹 dev는 경로 입력으로 폴백한다 (FR-19) */
  pickDirectory(): Promise<string | null>
}

export type PlatformCapabilities = {
  osNotifications: boolean
  dockBadge: boolean
  globalShortcuts: boolean
  processSupervision: boolean
  openInIde: boolean
}

/**
 * 깃 조회·조작 (FR-4, B-1 신설).
 * 구현은 host의 dev-services에 있다 — git2(Rust) 이관은 측정으로 병목이 확인될 때까지 보류.
 */
export interface GitPort {
  status(projectId: string): Promise<GitFileStatus[]>
  diff(projectId: string, path: string, staged?: boolean): Promise<GitDiff>
  log(projectId: string, limit?: number): Promise<GitCommit[]>
  commitDetail(projectId: string, sha: string): Promise<{ files: string[]; diff: string; truncated: boolean }>
  branches(projectId: string): Promise<GitBranch[]>
  /** dryRun이면 무엇이 충돌하는지만 알려준다 (막지 말고 보이게) */
  checkout(projectId: string, branch: string, dryRun?: boolean): Promise<{ ok: boolean; conflicts: string[]; message?: string }>
  stage(projectId: string, paths: string[], unstage?: boolean): Promise<void>
  commit(projectId: string, message: string): Promise<{ ok: boolean; message?: string }>
  push(projectId: string): Promise<{ ok: boolean; message?: string }>
}

/** 워크스페이스 스냅샷 (C-3) — 창을 껐다 켜도 보던 자리로 돌아온다 */
export type WorkspaceSnapshot = {
  focusedSessionId?: string | null
  tab?: string
}

/** 대화 검색·승인 규칙 관리 (E-1, E-4) */
export interface SearchPort {
  messages(query: string, limit?: number): Promise<{ sessionId: string; seq: number; snippet: string }[]>
}

export interface ApprovalRulesPort {
  list(): Promise<{ id: number; scope: string; matcher: string; decision: string; createdAt: number }[]>
  remove(id: number): Promise<void>
}

export interface WorkspacePort {
  save(snapshot: WorkspaceSnapshot): Promise<void>
  load(): Promise<WorkspaceSnapshot | null>
}

export interface Platform {
  agents: AgentPort
  projects: ProjectPort
  system: SystemPort
  git: GitPort
  fs: FsPort
  search: SearchPort
  rules: ApprovalRulesPort
  workspace: WorkspacePort
  capabilities: PlatformCapabilities
  dispose(): Promise<void>
}
