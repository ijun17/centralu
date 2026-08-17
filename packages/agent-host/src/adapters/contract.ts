import type {
  AdapterCapabilities,
  ModelOption,
  UsageSnapshot,
  ApprovalDecision,
  ApprovalScope,
  NormalizedEvent,
  PermissionPreset,
  ToolName,
} from '@cc/protocol'

/**
 * 어댑터 계약 (docs/agent-host.md §2).
 *
 * 규칙: 외부 SDK 타입은 adapters/<tool>/ 밖으로 한 발짝도 못 나온다 (anti-corruption).
 *
 * 어댑터가 다루는 축이 셋이다. 무엇에 매여 있는지가 곧 어디에 놓이는지다:
 *   세션  — SessionHandle의 메서드 (대화·승인·슬래시 명령)
 *   디렉토리 — AgentAdapter의 cwd 인자 메서드 (이전 세션 목록)
 *   계정  — AgentAdapter의 인자 없는 메서드 (사용량·한도)
 *
 * **선택 메서드로 능력을 표현한다.** capabilities에 같은 걸 또 적지 않는다 —
 * 플래그와 구현이 어긋나면 조용히 아무 일도 안 하게 된다 (실제로 겪었다).
 */

/**
 * 오케스트레이터에게만 주는 도구 (FR-11).
 *
 * **여기가 접근 범위의 경계다.** 이 인터페이스가 줄 수 있는 것이 곧 오케스트레이터가
 * 할 수 있는 전부다 — 이 앱이 관리하는 세션 밖으로 나갈 방법이 아예 없다.
 * 파일도, 프로젝트도, 다른 도구도 여기 없다.
 *
 * 도구 중립적으로 둔다. Claude는 인프로세스 MCP로, 다른 도구는 자기 방식으로
 * 노출하면 된다 — SDK 타입은 adapters/<tool>/ 밖으로 한 발짝도 못 나온다.
 */
export type OrchestratedSession = {
  sessionId: string
  name: string
  project: string
  state: string
  tool: ToolName
  /** 마지막으로 무슨 일이 있었는지 한 줄 */
  preview: string
}

export type OrchestratorTools = {
  /** 지금 이 앱이 관리하는 세션들 (오케스트레이터 자신과 아카이브는 뺀다) */
  listSessions(): Promise<OrchestratedSession[]>
  /**
   * 한 세션에 일을 시킨다. 대상이 아니면 이유를 돌려준다 — 조용히 실패하지 않는다.
   *
   * `reportBack`이면 그 세션의 턴이 끝날 때 오케스트레이터에게 한 번 알린다.
   * 기본이 꺼짐인 이유: 끝날 때마다 깨우면 서로 깨우는 고리가 되고, 턴 값도 두 배가 된다.
   */
  sendToSession(sessionId: string, text: string, reportBack?: boolean): Promise<{ ok: boolean; error?: string }>
}

export type CreateSessionOpts = {
  sessionId: string
  cwd: string
  model?: string
  /** 추론 강도. 모델마다 단계가 달라 문자열 그대로 나른다 */
  effort?: string
  permissionPreset: PermissionPreset
  resumeExternalId?: string
  /** 주어지면 이 세션은 오케스트레이터다 — 어댑터가 자기 방식으로 도구를 붙인다 */
  orchestratorTools?: OrchestratorTools
  /**
   * 앱이 보증하는 역할 설명. 도구의 기본 프롬프트에 **덧붙인다**.
   *
   * 파일(AGENTS.md)로 두지 않는 이유: 사람이 지우거나 잘못 고치면 함께 사라진다.
   * 사람이 정할 몫과 우리가 지켜야 할 몫은 같은 자리에 두지 않는다.
   */
  systemPromptAppend?: string
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
  updateSettings?(settings: {
    model?: string | null
    effort?: string | null
    permissionPreset?: PermissionPreset
  }): void
  /**
   * 이 세션에서 쓸 수 있는 슬래시 명령(스킬).
   * 도구가 아직 준비 중이면 던져도 된다 — 매니저가 캐시로 물러난다.
   */
  listCommands?(): Promise<{ name: string; description?: string; argumentHint?: string }[]>
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

  /**
   * 계정 사용량·한도 (FR-9).
   *
   * 세션도 디렉토리도 아닌 **계정**의 성질이라 인자가 없다.
   * 구독 한도만 다룬다 — 추가 결제(크레딧)는 범위 밖이다.
   * 못 가져오면 던진다: 매니저가 이유와 함께 degrade한다.
   */
  listUsage?(): Promise<UsageSnapshot>

  /**
   * 고를 수 있는 모델과 각 모델이 지원하는 추론 강도.
   *
   * 사용량과 같은 **계정** 축이라 인자가 없다 — 어느 디렉토리에서 묻든 답이 같다.
   * 목록을 우리가 적지 않기 위한 창구다: 도구가 새 모델을 내면 여기로 그냥 따라온다.
   * 구버전 도구를 만나면 던져도 된다 — 매니저가 이유와 함께 degrade한다.
   */
  listModels?(): Promise<ModelOption[]>
}
