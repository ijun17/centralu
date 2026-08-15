import type {
  AdapterCapabilities,
  ApprovalDecision,
  ApprovalScope,
  NormalizedEvent,
  PermissionPreset,
  ToolName,
} from '@cc/protocol'

/**
 * 어댑터 계약 (docs/agent-host.md §2).
 * 규칙: 외부 SDK 타입은 adapters/<tool>/ 밖으로 한 발짝도 못 나온다 (anti-corruption).
 * 어댑터의 유일한 출력은 NormalizedEvent다.
 */

export type CreateSessionOpts = {
  sessionId: string
  cwd: string
  model?: string
  permissionPreset: PermissionPreset
  resumeExternalId?: string
}

/** 도구가 보관 중인 이전 세션 한 건 (도구 고유 타입은 여기까지 오지 않는다) */
export type ExternalSessionSummary = {
  externalId: string
  title: string
  updatedAt: number
  createdAt?: number
  branch?: string
}

/** 복원용 대화 한 줄. 도구를 막론하고 '사람의 말'과 '모델의 말'만 남긴다 */
export type HistoryMessage = { role: 'user' | 'assistant'; text: string; ts?: number }

export type DetectResult = { tool: ToolName; installed: boolean; loggedIn: boolean; detail: string }

export type EventSink = (event: NormalizedEvent) => void

export interface SessionHandle {
  readonly sessionId: string
  readonly externalId: string | null
  send(text: string): void
  /** matcher는 core가 계산해 UI가 전달한다 (경계 규칙: host는 core를 모른다) */
  respondApproval(requestId: string, decision: ApprovalDecision, scope?: ApprovalScope, matcher?: string): void
  /** 저장된 '항상 허용' 규칙 주입 — 재시작 후에도 유지되도록 (FR-10, C-2) */
  applyRules?(matchers: readonly string[]): void
  /** 모델·권한 변경 (다음 턴부터). 지원하지 않으면 구현하지 않는다 */
  updateSettings?(settings: { model?: string | null; permissionPreset?: PermissionPreset }): void
  interrupt(): void
  dispose(): Promise<void>
}

export interface AgentAdapter {
  readonly tool: ToolName
  readonly capabilities: AdapterCapabilities
  detect(): Promise<DetectResult>
  createSession(opts: CreateSessionOpts, emit: EventSink): Promise<SessionHandle>
  /**
   * 이 디렉토리에서 도구가 보관 중인 이전 세션 목록.
   * 구현하지 않으면 '지원 안 함'으로 처리된다 — 지원 여부는 capabilities.listExternal이 말한다.
   * 구버전 도구를 만나면 던져도 된다: 매니저가 이유와 함께 degrade한다.
   */
  listExternalSessions?(cwd: string, limit: number): Promise<ExternalSessionSummary[]>
  /** 이전 세션의 대화를 읽는다 (표시용 스냅샷. 모델의 실제 컨텍스트는 도구가 갖고 있다) */
  readExternalHistory?(externalId: string, cwd: string, limit: number): Promise<HistoryMessage[]>
}
