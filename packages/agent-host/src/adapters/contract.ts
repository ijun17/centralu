import type {
  AdapterCapabilities,
  ModelOption,
  UsageSnapshot,
  ApprovalDecision,
  ApprovalScope,
  NormalizedEvent,
  PermissionPreset,
  QuestionAnswer,
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
  /** 워크트리 브랜치가 줄기에 들어갔는가 (#69) — 매니저가 "끝난 일"을 스스로 판단하는 근거 */
  merged?: boolean
  /** 이 브랜치의 PR (#76 stage 3) — gh로 측정. "리뷰 대기"와 "그냥 진행 중"을 가른다 */
  pr?: { number: number; state: 'open' | 'merged' | 'closed' }
  tool: ToolName
  /** 마지막으로 무슨 일이 있었는지 한 줄 */
  preview: string
  /** 마지막으로 움직인 시각 — 어느 세션이 '지금 이야기'인지 가른다 */
  lastActive?: string
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
  /**
   * 다 끝난 워크트리 브랜치 세션을 정리한다 (#76 하드 게이트) — 매니저 전용.
   *
   * 유일한 파괴 권한이고, propose가 아니라 power인 이유는 게이트다: host가 삭제
   * 순간에 **증명 가능하게 무손실**임을 측정했을 때만 실행된다(커밋 안 된 변경 없음 +
   * 지금 팁이 줄기에 들어갔음). 증명 밖의 모든 삭제는 여전히 사람의 일이다.
   */
  deleteWorktreeSession(sessionId: string): Promise<{ ok: boolean; error?: string }>
  /**
   * 한 세션의 최근 대화를 읽는다.
   *
   * 이게 없어서 오케스트레이터는 보고가 부실할 때 **확인할 방법이 아예 없었다** —
   * list_sessions의 한 줄과 보고가 같은 소스라 우회도 안 됐다.
   * 사양서(FR-11)에는 처음부터 있던 도구다.
   */
  readSession(
    sessionId: string,
    limit?: number,
    opts?: {
      /** recall이 준 seq. 그 언저리를 읽는다 — 찾은 대목으로 바로 가는 길 */
      around?: number
      /** 도구 호출 본문까지 펼칠지. 기본은 접는다 (스크립트 전문이 대화를 덮는다) */
      tools?: boolean
    },
  ): Promise<{ ok: boolean; error?: string; lines?: string[]; state?: string }>
  /**
   * 지난 대화에서 찾는다 — **프로젝트를 가로지르는 기억**.
   *
   * 기억을 따로 저장하지 않는 이유: 무엇을 기억할지 누가 정하느냐는 문제를 새로 만들고,
   * 증류된 요약은 원본이 바뀌어도 그대로 남는다. 우리는 대화를 하나도 지우지 않으므로
   * **찾을 수만 있으면 그게 기억이다.**
   */
  /**
   * 세션을 보관하거나 되돌린다.
   *
   * 막힌 창을 푸는 방법이 앱 재시작 아니면 아카이브→복구인데, 오케스트레이터는
   * 둘 다 못 해서 결국 사람에게 넘겨야 했다 (도그푸딩). 되돌릴 수 있는 일이라 준다.
   */
  /**
   * 워커 세션을 하나 만든다 (#13).
   *
   * 만들기는 주고 지우기는 안 주는 이유: 만든 세션은 사람이 목록에서 보고 되돌릴 수
   * 있지만(보관·삭제 모두 사람 손에 있다), 지우기는 대화 기록까지 사라져 되돌릴 수 없다.
   */
  createSession(opts: {
    /** 프로젝트 이름 또는 id — 오케스트레이터는 어느 프로젝트에도 속하지 않으므로 반드시 가리켜야 한다 */
    project?: string
    tool?: ToolName
    /** 세션 이름. 주면 자동 이름이 덮지 않는다 */
    name?: string
    /** 만들자마자 보낼 첫 지시 */
    firstMessage?: string
  }): Promise<{ ok: boolean; error?: string; sessionId?: string; name?: string }>
  /**
   * 한 세션의 성능 설정을 바꾼다 (#30).
   *
   * **권한 프리셋이 이 타입에 없는 것이 곧 결정이다.** 오케스트레이터가 프리셋을
   * auto로 바꿀 수 있으면 "대신 승인할 수 없다"는 규칙이 뒷문으로 무너진다 —
   * 항목을 검사해서 막는 게 아니라 표현할 수 없게 한다.
   * 변경은 화면에 이벤트로 알려진다 — 흔적 없는 설정 변경 금지.
   */
  updateSessionSettings(
    sessionId: string,
    s: { model?: string | null; effort?: string | null; verbosity?: string | null; serviceTier?: string | null },
  ): Promise<{ ok: boolean; error?: string }>
  recall(
    query: string,
    limit?: number,
  ): Promise<{
    hits: {
      sessionId: string
      session: string
      project: string
      snippet: string
      /** read_session의 around로 넘기면 그 대목으로 간다 */
      seq: number
      at?: string
    }[]
  }>
  /**
   * MCP 서버 설치를 **사람에게 제안한다** (도그푸딩 요청 — Playwright 같은 능력을
   * 스스로 갖추고 싶을 때). propose-not-power 규칙 그대로: 이 호출은 아무것도
   * 설치하지 않는다. 사람이 승인하면 앱이 등록하고 오케스트레이터를 재시작한다 —
   * 임의 명령 실행의 등록이라, 승인 없는 설치는 곧 뒷문이다.
   */
  proposeMcpServer(spec: {
    name: string
    command: string
    args: string[]
    why?: string
  }): Promise<{ ok: boolean; error?: string }>
  /**
   * 재사용할 작업 절차(스킬)를 **사람에게 제안한다** (#71). 스킬은 파일이 아니라
   * 앱 DB에 산다 — 워커 세션은 파일은 쓸 수 있지만 DB는 못 쓰므로, 낮은 권한이
   * 오케스트레이터의 지시문에 닿는 길이 열리지 않는다. 승인 전에는 아무 영향이 없다:
   * 스킬은 모든 세션에 지시할 수 있는 에이전트에 대한 **영구적 영향력**이라,
   * 자가 저작이 승인 없이 남으면 주입된 텍스트가 곧 영구 권한이 된다.
   */
  proposeSkill(spec: { name: string; content: string; why?: string }): Promise<{ ok: boolean; error?: string }>
}

export type CreateSessionOpts = {
  sessionId: string
  cwd: string
  model?: string
  /** 추론 강도. 모델마다 단계가 달라 문자열 그대로 나른다 */
  effort?: string
  /** 응답 길이 (#54). capabilities.verbosities가 비어 있는 어댑터는 무시한다 */
  verbosity?: string
  /** 응답 속도 (codex의 service_tier). 지원 티어는 모델 목록(ModelOption.tiers)이 말한다 */
  serviceTier?: string
  permissionPreset: PermissionPreset
  resumeExternalId?: string
  /** 주어지면 이 세션은 앱 도구를 받는다 — 어댑터가 자기 방식으로 붙인다 */
  orchestratorTools?: OrchestratorTools
  /**
   * 사람이 승인한 추가 MCP 서버 (오케스트레이터 전용). propose_mcp_server →
   * 승인 → 재시작의 결과가 여기로 온다. 어댑터는 이 목록을 자기 MCP 설정에
   * 그대로 병기한다 — 등록은 앱이, 실행 여부는 이 목록이 전부다.
   */
  extraMcpServers?: { name: string; command: string; args: string[] }[]
  /**
   * 받는 도구 묶음 (#69). 'orchestrator'는 전부, 'manager'는 워크트리 매니저의
   * 부분집합(제안·조회·지시)이다. orchestratorTools가 있을 때만 뜻이 있다.
   * 노출과 실행 양쪽이 같은 판정(profileAllows)을 쓴다 — 노출만 좁히면
   * 이름을 아는 쪽이 그냥 부른다.
   */
  toolProfile?: 'orchestrator' | 'manager' | 'scoped'
  /**
   * 앱이 보증하는 역할 설명. 도구의 기본 프롬프트에 **덧붙인다**.
   *
   * 파일(AGENTS.md)로 두지 않는 이유: 사람이 지우거나 잘못 고치면 함께 사라진다.
   * 사람이 정할 몫과 우리가 지켜야 할 몫은 같은 자리에 두지 않는다.
   */
  systemPromptAppend?: string
  /**
   * 도구를 **인프로세스로 못 붙이는** 어댑터가 host로 돌아올 길.
   *
   * Claude는 필요 없다(함수가 그대로 도구가 된다). Codex는 스레드별 config로
   * stdio 서버만 물릴 수 있어서 별도 프로세스가 뜨고, 그 프로세스가 이 주소로 돌아온다.
   */
  orchestratorBridge?: { url: string; token: string }
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
  /**
   * 승인 응답. **닿았는지를 돌려준다** (false = 그런 요청이 없다).
   *
   * 조용히 무시하면 화면은 승인 카드를 붙든 채 영원히 남는다 — 눌러도 아무 일이
   * 없고, 사용자는 명령이 실행됐는지 아닌지도 알 수 없다. 도그푸딩에서 실제로 이렇게 막혔다.
   */
  respondApproval(requestId: string, decision: ApprovalDecision, scope?: ApprovalScope, matcher?: string): boolean
  /**
   * 선택지에 답한다 (AskUserQuestion). 승인과 같은 규칙 — **닿았는지를 돌려준다.**
   * 이 도구를 지원하지 않는 어댑터는 구현하지 않는다.
   */
  answerQuestion?(requestId: string, answers: QuestionAnswer[]): boolean
  /** 저장된 '항상 허용' 규칙 주입 — 재시작 후에도 유지되도록 (FR-10, C-2) */
  applyRules?(matchers: readonly string[]): void
  /** 모델·권한 변경 (다음 턴부터). 지원하지 않으면 구현하지 않는다 */
  updateSettings?(settings: {
    model?: string | null
    effort?: string | null
    verbosity?: string | null
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

  /**
   * 도구 쪽 대화 원본을 **정말로** 지운다 (도그푸딩 요청 — "진짜로 삭제").
   *
   * 우리 세션 삭제는 우리 DB만 걷어냈다: codex rollout(실측 550MB)·claude JSONL은
   * 도구의 것이라 남겨 뒀다. 남기는 것이 기본이라는 규칙은 그대로다 — 이 메서드는
   * 사람이 체크박스로 명시한 경우에만 불린다. 실패하면 던진다: 매니저가 우리 쪽
   * 삭제를 멈추고 그대로 알린다 ("지웠다"고 말했는데 원본이 남는 것이 최악이다).
   */
  deleteExternalConversation?(externalId: string, cwd: string): Promise<void>
  /**
   * 죽은 도구의 마지막 컴팩트 요약 (#78) — 있으면 인수인계 기록의 머리가 된다.
   *
   * **도구 프로세스 없이** 동작해야 한다: 이 메서드가 불리는 순간은 그 도구의
   * 서비스가 중단됐을 때다. codex는 롤아웃 파일에서 읽고, claude는 스트림에
   * 요약 본문이 안 실려 구현이 없다 — 없으면 기록 빌더가 원문 압축으로 물러난다.
   */
  lastCompactSummary?(externalId: string): Promise<string | null>
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

  /**
   * 잠긴 대화에서 **갈라져 나온다** — 새 externalId를 돌려준다.
   *
   * 왜 필요한가: 도구에 따라 한 대화의 쓰기 권한은 하나뿐이다. codex는 잠금으로
   * 막고("already has an active writer"), 그러면 이 앱에서는 그 대화를 이어갈 방법이
   * 아예 없었다 — 사람이 다른 앱을 닫으러 가는 것 말고는.
   *
   * 그런데 **막히는 건 쓰기 하나뿐이다.** 실측으로 확인한 것:
   *   thread/resume  ❌ 잠김
   *   thread/read    ✅ 잠겨 있어도 읽힌다 (우리는 이미 우리 저장소로 읽고 있다)
   *   thread/fork    ✅ 잠겨 있어도 갈라진다
   *
   * 그래서 막다른 길이 아니라 갈림길이다. 원본은 건드리지 않고 사본에서 이어간다.
   * 이 능력이 없는 어댑터는 구현하지 않는다 — claude는 애초에 잠그지 않으므로 필요 없다
   * (동시 resume이 그대로 동작한다는 것도 실측으로 확인했다).
   */
  forkConversation?(externalId: string, cwd: string): Promise<string>
}
