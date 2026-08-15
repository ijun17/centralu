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
}
