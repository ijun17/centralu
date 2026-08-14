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
  respondApproval(requestId: string, decision: ApprovalDecision, scope?: ApprovalScope): void
  interrupt(): void
  dispose(): Promise<void>
}

export interface AgentAdapter {
  readonly tool: ToolName
  readonly capabilities: AdapterCapabilities
  detect(): Promise<DetectResult>
  createSession(opts: CreateSessionOpts, emit: EventSink): Promise<SessionHandle>
}
