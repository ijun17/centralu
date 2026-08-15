import type {
  AdapterCapabilities,
  ApprovalDecision,
  ApprovalScope,
  CreateSessionParams,
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
  send(sessionId: string, text: string): Promise<void>
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
  /** 죽은 세션을 되살린다 (FR-10). resumed=false면 이유가 함께 온다 */
  resumeSession(sessionId: string): Promise<{ session: SessionInfo; resumed: boolean; reason?: string }>
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

/** M1에서는 정의만 — 구현은 M2 (docs/plans/m1-plan.md 범위 밖) */
export interface FsPort {
  listDir(path: string): Promise<{ name: string; isDir: boolean }[]>
  readFile(path: string): Promise<string>
}

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

export interface Platform {
  agents: AgentPort
  projects: ProjectPort
  system: SystemPort
  capabilities: PlatformCapabilities
  dispose(): Promise<void>
}
