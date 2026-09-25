import { z } from 'zod'
import {
  AppId,
  ApprovalDecision,
  Attachment,
  ApprovalDetail,
  ProtocolError,
  Question,
  SessionActivity,
  SessionGoal,
  SessionState,
  TokenUsage,
  ToolSummary,
  UpdateStatus,
} from './entities.js'

/**
 * 어댑터 → 앱 방향의 정규화 이벤트 (docs/protocol.md §2).
 * 도구별 차이는 어댑터가 흡수하고, UI/core는 이 타입만 안다.
 */
const base = { sessionId: z.string() }

/**
 * 세션에 속하지 않는 이벤트 (`error`, `update_status`).
 *
 * `sessionId`를 **없애지 않고 optional로 둔다.** 키 자체가 없는 분기를 하나 넣으면
 * 유니온 전체에서 `e.sessionId`가 타입 오류가 되어, 세션 이벤트만 다루는 코드까지
 * 전부 고쳐야 한다 — 앱 전역 사건 하나를 더한 대가로는 너무 크고, 그 수선이 지나간
 * 자리마다 실수가 들어갈 틈이 생긴다. 받는 쪽은 이미 `if (!sessionId) return`으로
 * 걸러내고 있으므로, 없는 값을 없다고 말하는 데는 이 모양으로 충분하다.
 */
const appScoped = { sessionId: z.string().optional() }

/**
 * host가 이 이벤트를 기록으로 남기며 매긴 **세션 내 메시지 번호** (store의 messages.seq).
 *
 * 안읽음 추적(lastSeq/lastReadSeq)은 반드시 이 번호로만 해야 한다. UI의 렌더 키는
 * 전 세션 공용 카운터라서, 그 값이 세션별 lastSeq로 새어 들어가면 큰 세션을 본 뒤
 * 작은 세션의 last_read_seq가 부풀려 저장되어 **안읽음 배지가 영구히 꺼진다** (실측).
 * 기록으로 남는 이벤트에만 붙는다 (envelope의 전역 방송 seq와는 다른 번호다).
 */
const persistedSeq = { seq: z.number().optional() }

/**
 * 한 대화에서 동시에 살아 있는 앱 화면의 수 (M4 B-1, 플랜 "살아 있는 대화 안 화면은 최근 몇 개로 제한한다").
 * 넘치면 가장 오래 살아 있던 화면이 teardown 뒤 자리표시로 접힌다. host(인스턴스와 그것이 붙드는 앱)와
 * UI(그려진 프레임)가 같은 수를 지킨다 — 한쪽만 지키면 다른 쪽에서 새어 나간다(UI가 없어도 host는 앱을
 * 놓아야 하고, host의 알림이 늦어도 UI는 프레임을 줄여야 한다).
 */
export const APP_VIEWS_LIVE_PER_SESSION = 3

/**
 * 외부 앱의 "바뀌었다"를 낸 호출의 주인 (M4 B-5) — host 런타임의 호출자(`AppCaller`) 모양 그대로다. 화면이 부른
 * 것이면 그 화면의 인스턴스 id가 실린다. 그 화면은 자기가 낸 바뀜을 다시 듣지 않는다 — 답으로 이미 받았다.
 *
 * 모양을 좁게 묶지 않는다. 부르는 쪽의 종류가 늘었을 때 이 칸 때문에 이벤트가 검사에서 떨어지면, 열린 화면이
 * 갱신을 영영 받지 못한다. 받는 쪽이 읽는 것은 `view`의 `instanceId` 하나다.
 */
export const AppChangeCause = z.looseObject({ kind: z.string(), instanceId: z.string().optional() })
export type AppChangeCause = z.infer<typeof AppChangeCause>

export const NormalizedEvent = z.discriminatedUnion('type', [
  z.object({ ...base, ...persistedSeq, type: z.literal('message_delta'), role: z.enum(['assistant']), text: z.string() }),
  /**
   * 모델의 추론이 보이는 만큼만 (#58 실측, 2026-08-26).
   *
   * 두 도구가 내놓는 것이 다르다 — 그래서 두 필드가 다 optional이다:
   *   codex: 요약 **텍스트**가 스트리밍된다 (item/reasoning/summaryTextDelta,
   *          단 thread 설정에 model_reasoning_summary를 켜야만 온다) → text
   *   claude: thinking 본문이 통째로 암호화라 텍스트가 없다 — thinking_delta에는
   *          estimated_tokens만 실려 온다 → estTokens (증분)
   * 없는 내용을 있는 척하지 않는다: text가 있으면 기록(kind 'reasoning')까지 남고,
   * estTokens뿐이면 "생각 중 ~N" 진행 표시로만 살다가 턴이 끝나면 사라진다.
   */
  z.object({
    ...base,
    ...persistedSeq,
    type: z.literal('reasoning_delta'),
    text: z.string().optional(),
    estTokens: z.number().optional(),
  }),
  /**
   * 에이전트가 세운 계획의 현재 상태 (#58 실측, codex turn/plan/updated).
   *
   * **매번 전체 스냅샷이 온다** — 델타가 아니므로 받는 쪽이 이전 상태를 기억할 필요가
   * 없다 (settings_changed와 같은 이유). 실측에서 계획은 item으로는 오지 않았다:
   * 이 알림을 버리면 codex의 계획 도구 사용은 화면 어디에도 나타나지 않는다.
   *
   * persistedSeq가 없는 것은 결정이다: 진행 표시지 답이 아니다 — activity와 같은
   * 수명으로 화면에서만 살고, 턴이 끝나면 사라진다. (실측된 explanation은 null뿐이라
   * 싣지 않는다 — 관찰되면 그때 더한다.)
   */
  z.object({
    ...base,
    type: z.literal('plan_update'),
    steps: z.array(z.object({ text: z.string(), status: z.enum(['pending', 'inProgress', 'completed']) })),
  }),
  /**
   * 실행 중인 도구의 출력 조각 (#58 실측, codex item/commandExecution/outputDelta).
   *
   * 완료 시점의 tool_result가 aggregatedOutput으로 전체를 다시 실어 오므로
   * 기록하지 않는다 — 이건 "지금 뭐가 나오고 있나"를 보여주는 표시 전용 조각이다.
   * (실측: 첫 조각은 스트림이 붙기 전에 소비될 수 있다 — 완전한 사본이 아니라
   * 살아 있다는 증거로 취급할 것.)
   *
   * 서브에이전트의 걸음도 이 길로 온다 (#98): callId는 그것을 띄운 Agent 호출이고,
   * text는 걸음마다 한 줄이다. 부모의 대화에 줄을 세우지 않고 그 카드에만 붙는다 —
   * 받는 쪽은 callId로 주인을 찾아야 한다 (자리로 찾으면 열린 남의 카드에 붙는다).
   */
  z.object({ ...base, type: z.literal('tool_output_delta'), callId: z.string(), text: z.string() }),
  /**
   * 사람의 말이 대화에 더해졌다.
   *
   * **UI가 자기가 보낸 것만 그리면 되던 시절에는 없어도 됐다.** 그런데 오케스트레이터가
   * send_to_session으로 남의 세션에 말을 걸면서 사용자 메시지의 생산자가 둘이 됐다 —
   * 그때부터 UI를 거치지 않은 말은 화면에 나타날 길이 없었다 (저장은 됐다).
   *
   * seq를 함께 보내는 이유: 보낸 UI는 이미 낙관적으로 그려 뒀으므로 같은 말을 두 번
   * 그리면 안 된다. 받는 쪽이 그것을 가려낼 수 있어야 한다.
   */
  z.object({
    ...base,
    type: z.literal('user_message'),
    seq: z.number(),
    text: z.string(),
    /*
     * 출처 (FR-11). 없으면 사람이 직접 친 말 — 그래서 optional이고 옛 프레임과 호환된다.
     * 채우는 곳은 둘뿐: 오케스트레이터의 send_to_session, 워커의 완료 보고(reportBack).
     * 화면은 이 값으로 "시켜서 들어온 말"을 사람 말과 다르게 그린다.
     */
    from: z.object({ sessionId: z.string(), name: z.string() }).optional(),
    /*
     * 대화 안 앱 화면이 보낸 말 (M4 B-1·B-4). 사람이 읽고 보내기로 골랐지만 **쓴 것은 앱이다** —
     * 화면은 이 값으로 사람 말과 다르게 그린다. 에이전트에게는 host가 "앱의 글"로 감싼 모양이 간다
     * (#120과 같은 규칙: 남의 글은 옮기는 자리에서 표시한다). 세션이 아니라서 `from`과 따로 둔다.
     */
    fromApp: z.object({ appId: z.string(), projectId: z.string().nullable(), name: z.string() }).optional(),
    /*
     * 함께 실어 보낸 첨부 (M4 C-5). UI가 보낸 말은 화면이 이미 첨부째 그려 두어서 필요 없었다. 앱 화면 아래 입력줄의
     * 말처럼 host가 넣은 말은 이 이벤트가 화면에 나타나는 유일한 길이라, 없으면 붙여 넣은 스크린샷이 기록을 다시 읽기
     * 전까지 말풍선에서 빠진다. 경로와 이름만 — 이미지 바이트는 기록을 읽을 때 host가 다시 싣는다.
     */
    attachments: z.array(Attachment).optional(),
  }),
  z.object({ ...base, ...persistedSeq, type: z.literal('tool_call'), callId: z.string(), summary: ToolSummary }),
  z.object({
    ...base,
    ...persistedSeq,
    type: z.literal('tool_result'),
    callId: z.string(),
    ok: z.boolean(),
    summary: z.string().default(''),
  }),
  /**
   * 대화 안 앱 화면 (M4 B-1) — 세션의 에이전트가 **화면이 달린** 앱 도구를 불렀다. 그 호출 카드
   * (`callId`, 어댑터의 `tool_call`과 같은 id) 아래에 화면이 선다.
   *
   *   open       host가 화면 인스턴스를 열었다. `instanceId`와 도구 입력(`toolInput`)이 실린다
   *   result     호출이 끝났다. 앱의 답 그대로(`toolResult`) — 화면의 tool-result가 된다
   *   cancelled  답 없이 끝났다(취소·거절·앱이 못 뜸). `reason`이 화면의 tool-cancelled가 된다
   *   rejected   화면을 열지 않았다 — 도구가 선언한 화면이 그 앱의 것이 아니다(사칭 차단). 이유가 실린다
   *   closed     host가 인스턴스를 닫았다(상한, 앱이 사라짐, 신뢰를 잃음). 화면은 teardown 뒤 자리표시로 접힌다
   *
   * `kept`는 result·cancelled에 실린다: host가 입력과 결과를 들고 있어 **도구를 다시 부르지 않고**
   * 화면을 다시 열 수 있는가(`apps.inlineReopen`). 결과가 너무 크면 들고 있지 않는다.
   *
   * 기록에는 open과 rejected만 남는다(`seq`) — 본문(입력·결과) 없이 "이 카드에는 어느 앱의 화면이
   * 있었다"는 사실만. 다시 연 UI는 그것으로 자리표시를 세운다. 결과 본문은 host의 메모리에만 있다.
   */
  z.object({
    ...base,
    ...persistedSeq,
    type: z.literal('app_view'),
    callId: z.string(),
    appId: AppId,
    projectId: z.string().nullable(),
    tool: z.string(),
    phase: z.enum(['open', 'result', 'cancelled', 'rejected', 'closed']),
    instanceId: z.string().optional(),
    toolInput: z.record(z.string(), z.unknown()).optional(),
    toolResult: z.looseObject({ content: z.array(z.unknown()) }).optional(),
    reason: z.string().optional(),
    kept: z.boolean().optional(),
  }),
  z.object({ ...base, ...persistedSeq, type: z.literal('approval_request'), requestId: z.string(), detail: ApprovalDetail }),
  z.object({
    ...base,
    ...persistedSeq,
    type: z.literal('approval_resolved'),
    requestId: z.string(),
    decision: ApprovalDecision,
  }),
  /*
   * 에이전트가 선택지를 내밀었다 (AskUserQuestion).
   *
   * 승인과 **다른 이벤트**인 이유: 승인은 예/아니오지만 이건 여러 질문 × 여러 선택지고,
   * 답이 모델에게 돌아가야 한다. 승인 카드에 억지로 얹으면 둘 다 망가진다.
   */
  z.object({
    ...base,
    type: z.literal('question_request'),
    requestId: z.string(),
    questions: z.array(Question),
  }),
  z.object({ ...base, type: z.literal('question_resolved'), requestId: z.string() }),
  /*
   * 에이전트가 대화에 이미지를 내놓았다 (#40).
   *
   * 실측한 두 갈래를 하나로 접는다: Claude는 tool_result 안에 base64로 실어 오고
   * (스크린샷·이미지 Read), Codex는 imageView 항목에 **경로만** 실어 온다 —
   * 경로 쪽은 어댑터가 파일을 읽어 data를 채운 뒤에 내보낸다. UI는 항상 같은
   * 모양(data URL)만 그린다.
   *
   * **persistedSeq가 없는 것은 결정이다** (2026-08-24): 표시 전용. DB는 텍스트만
   * 남고, 이미지는 터미널 스크롤백처럼 재시작하면 사라진다. 사람들이 지난 이미지를
   * 찾으러 돌아가는 것이 도그푸딩에서 보이면 그때 재검토한다.
   *
   * data가 비어 있으면 note가 이유를 말한다 (너무 큼, 못 읽음 — 실패는 보이게).
   */
  z.object({
    ...base,
    type: z.literal('message_image'),
    mime: z.string(),
    /** base64. 비어 있으면 표시 실패 — note를 보라 */
    data: z.string(),
    /** 이미지가 디스크에 있으면 그 출처 (Codex imageView) */
    path: z.string().optional(),
    note: z.string().optional(),
  }),
  z.object({ ...base, type: z.literal('turn_complete') }),
  z.object({ ...base, type: z.literal('state_change'), state: SessionState, reason: z.string().optional() }),
  z.object({ ...base, type: z.literal('usage_update'), tokens: TokenUsage }),
  z.object({
    ...base,
    type: z.literal('context_update'),
    used: z.number(),
    window: z.number(),
    exactness: z.enum(['exact', 'estimate']),
  }),
  z.object({
    ...base,
    type: z.literal('limit_reached'),
    /** ISO8601. 도구가 알려주는 해제 예상 시각 (FR-9) */
    resumeAt: z.string().optional(),
    /** Codex가 제공 (M0 확인) */
    usedPercent: z.number().optional(),
    windowMins: z.number().optional(),
  }),
  /**
   * 세션 이름이 바뀌었다.
   *
   * **누가 지었는지를 함께 나른다.** 예전엔 제목만 실어 보냈고, 받는 쪽은
   * "지금 이 세션이 자동 이름인가"라는 자기 상태만 보고 적용 여부를 정했다.
   * 그래서 사람이 고친 이름은 **첫 번째 변경만 퍼지고 두 번째부터는 조용히 무시**됐다
   * (한 번 고치면 autoNamed가 내려가 그 뒤로는 이 이벤트를 전부 버렸다).
   *
   * auto=false는 "사람이 정했다"는 뜻이고, 그 이름은 자동 이름이 다시 덮지 않는다 (FR-18).
   * 생략하면 자동 이름이다 — 옛 버전이 보낸 프레임도 그대로 해석된다.
   */
  z.object({ ...base, type: z.literal('session_title'), title: z.string(), auto: z.boolean().default(true) }),
  /** 동시 세션 충돌 감지·최근 수정 파일 하이라이트용 (FR-2, FR-5) */
  z.object({ ...base, type: z.literal('files_touched'), paths: z.array(z.string()) }),
  /** 지금 무엇을 하느라 바쁜가 — null이면 평범한 응답 대기 */
  z.object({ ...base, type: z.literal('activity'), activity: SessionActivity.nullable() }),
  /** 컨텍스트 압축이 일어났다 — 대화창에 마커를 남긴다 (FR-14) */
  z.object({
    ...base,
    ...persistedSeq,
    type: z.literal('compaction'),
    /**
     * 실패도 마커로 남긴다. 조용히 넘기면 압축이 안 된 채로 대화가 이어지는데
     * 사용자는 왜 컨텍스트가 그대로인지 알 수 없다
     * (실측: "Not enough messages to compact." — 지금까지 통째로 삼키고 있었다).
     */
    failed: z.boolean().default(false),
    reason: z.string().optional(),
    /** 얼마나 줄었나. 도구가 알려줄 때만 (Claude compact_metadata) */
    before: z.number().optional(),
    after: z.number().optional(),
  }),
  /**
   * 이 세션은 인수인계로 태어났고, 전임자의 노트가 여기 박혀 있다 (#102).
   *
   * **기록이 필요한 이유가 컴팩션 마커와 같다**: 첫 메시지가 노트 전문이던 시절에는
   * 그 글이 대화에 저절로 남았지만, 이제 첫 메시지는 경로만 나른다. 에이전트가 쓴
   * 노트는 전임자가 사라지면 다시 만들 수 없으므로, 파일보다 오래 사는 곳에 둔다.
   *
   * `note`가 optional인 것은 의도다 — **방송에는 싣지 않는다.** 노트는 메가바이트가
   * 될 수 있고, 화면에 그리는 것은 한 줄짜리 마커뿐이다. 원문은 저장된 payload에만 있다.
   */
  z.object({
    ...base,
    ...persistedSeq,
    type: z.literal('handoff'),
    /** 전임 세션의 이름 — 마커에 적히는 유일한 값 */
    from: z.string(),
    note: z.string().optional(),
    /**
     * 전임 세션의 id (#106) — 저장된 마커에만 실린다. 이 세션이 물려받은 노트 파일이
     * 누구의 이름으로 놓여 있는지를 아는 유일한 길이고, 기동 시 고아 청소의 근거다.
     */
    fromSessionId: z.string().optional(),
  }),
  /** 밖에서 이어간 대화를 따라잡았다 — UI가 기록을 다시 읽는 신호 */
  /**
   * 오케스트레이터가 이 세션의 설정을 바꿨다 (#30).
   *
   * 사람이 화면에서 바꾼 것은 RPC 응답으로 돌아가므로 이벤트가 필요 없다 — 이건
   * **사람이 아닌 손**이 바꾼 경우를 위한 길이다. 흔적 없는 설정 변경은 이 코드베이스가
   * 반복해서 고쳐 온 조용한-행동 문제 그 자체라, 값과 함께 방송해 토스트로 남긴다.
   * 셋 다 스냅샷(새 값 전체)이다 — 델타면 받는 쪽이 이전 값을 기억해야 한다.
   */
  z.object({
    ...base,
    type: z.literal('settings_changed'),
    model: z.string().nullable(),
    effort: z.string().nullable(),
    verbosity: z.string().nullable(),
    /** 응답 속도. 스냅샷 규칙은 위 셋과 같다 — 옛 프레임엔 없으므로 optional */
    serviceTier: z.string().nullable().optional(),
  }),
  z.object({ ...base, type: z.literal('history_synced'), added: z.number() }),
  /** 세션이 삭제됐다 — 다른 창·재연결에서도 목록이 맞아야 한다 */
  z.object({ ...base, type: z.literal('session_deleted') }),
  /**
   * 세션이 **host 쪽에서** 생겼다 (#69).
   *
   * UI가 직접 만든 세션은 RPC 응답으로 알지만, host가 스스로 만드는 세션 —
   * 워크트리 고아 입양이 세우는 매니저, 오케스트레이터의 create_session — 은
   * 알 길이 없었다: 모르는 세션의 이벤트는 보관함(pendingEvents)에 들어가는데,
   * 보관함을 비우는 조건이 "세션이 등록되면"이라 등록 이벤트 없이는 영영 남았다.
   * 재연결 후 listSessions로만 나타나는 세션은 "목록에 바로 나타난다"는
   * create_session 도구 설명과 어긋난 채였다.
   *
   * 세션 전체를 싣는다 — id만 보내면 받는 쪽이 다시 fetch해야 하고, 그 fetch가
   * 도착하기 전 이벤트는 여전히 갈 곳이 없다.
   */
  z.object({ ...base, type: z.literal('session_created'), session: z.unknown() }),
  /**
   * 워크트리 브랜치가 프로젝트 줄기에 다 들어갔다 (#69). 감지는 host가 하고
   * (기동·프로젝트 git 새로고침), 화면은 배지를 켠다. 정리(트리 제거)는 사람이
   * 삭제 대화에서 한다 — 이 이벤트는 사실의 통지이지 행동이 아니다.
   */
  z.object({ ...base, type: z.literal('worktree_merged') }),
  /**
   * 워크트리 브랜치의 PR 상태를 알게 됐다 (#76 stage 3). gh로 측정한 통지다 —
   * worktree_merged와 같은 문법: 사실의 통지이지 행동이 아니다. PR이 병합(스쿼시 포함)
   * 되면 worktree_merged가 뒤따른다 — 이 이벤트는 배지(번호·상태·링크)의 근거다.
   */
  z.object({
    ...base,
    type: z.literal('worktree_pr'),
    pr: z.object({ number: z.number(), state: z.enum(['open', 'merged', 'closed']), url: z.string() }),
  }),
  /**
   * 골 상태 통지 (2026-09-07). null이면 걷혔다(달성 포함) — 판정은 도구가 하고
   * 우리는 나른다. 살아-있는-동안 사실이다: 재시작 뒤 codex는 thread/goal/get으로
   * 다시 묻고, claude는 다음 Stop 훅 판정 때 다시 배운다.
   */
  z.object({ ...base, type: z.literal('goal'), goal: SessionGoal.nullable() }),
  /**
   * The update picture changed (issue #43).
   *
   * **The only event here that belongs to no session** — `error` already proved the
   * union can carry one (its `sessionId` is optional), so this rides the same rails
   * instead of growing a second stream. Everything downstream that keys off
   * `sessionId` already guards for its absence.
   *
   * It exists because the host checks on a schedule of its own: a check that lands
   * six hours into a running window has no RPC reply to ride home on, and without
   * this the answer would sit in the host until the next launch — which is exactly
   * the long-running window the schedule was for.
   */
  z.object({ ...appScoped, type: z.literal('update_status'), status: UpdateStatus }),
  /**
   * 앱 문서가 바뀌었다 (#81) — 일부러 거칠다: 무엇이 바뀌었는지는 싣지 않고,
   * 받은 쪽이 apps.state로 다시 읽는다. 앱마다 이벤트 모양을 만들면
   * 프로토콜이 앱을 알게 된다.
   */
  z.object({ ...appScoped, type: z.literal('app_state_changed'), appId: AppId }),
  /**
   * 외부 앱의 도구 호출이 끝났다 (M4 A-4) — `app_state_changed`와 같은 뜻, 같은 거칠기다:
   * 무엇이 바뀌었는지는 싣지 않고, 받은 쪽이 다시 읽는다. 외부 앱의 상태는 앱 프로세스에
   * 살아서, "다시 읽는다"는 apps.state가 아니라 그 앱의 상태 도구를 다시 부르는 것이다
   * (화면에는 `centralu/notifications/changed`로 옮겨진다, B-5).
   *
   * 이름을 나눈 이유: 내장 앱의 그 이벤트를 받으면 UI는 `apps.state(appId)`를 다시 읽는다.
   * 같은 이름을 쓰면 외부 앱의 호출마다 쓸모없는 왕복이 하나씩 생기고, 내장 앱의 상태 칸에
   * 외부 앱 id가 섞인다. 앱은 (프로젝트, id)로 하나라 프로젝트도 싣는다 — null은 사용자 폴더 앱.
   * 앱에 닿지 않은 호출(거절)과 읽기만 하는 도구(`readOnlyHint: true`)의 호출에는 오지 않는다: 아무것도 바뀌지
   * 않았다. host는 앱마다 250ms씩 모아 보낸다(한 앱에 초당 4번까지). `cause`는 모은 호출이 모두 한 주인의
   * 것일 때만 실린다 — 섞였으면 빠진다(모두가 듣는다).
   */
  z.object({
    ...appScoped,
    type: z.literal('external_app_state_changed'),
    appId: AppId,
    projectId: z.string().nullable(),
    cause: AppChangeCause.optional(),
  }),
  /**
   * 외부 앱 목록이 달라졌다 (M4 A-8) — 앱이 생기거나 사라지거나 고쳐졌고, 프로젝트 신뢰가
   * 바뀌었고, 앱이 뜨거나 내리거나 실패했다. 같은 거칠기다: 싣는 것이 없고, 받은 쪽이
   * `apps.list`를 다시 읽는다. 사이드바의 앱 줄과 고정 화면의 "뜨는 중·멈춤·이유"가 이것을 따른다.
   *
   * `external_app_state_changed`와 나눈 이유: 그쪽은 **앱 안의 값**이 바뀌었다는 뜻이라 열린
   * 화면이 다시 읽고, 이쪽은 **앱의 자리와 상태**가 바뀌었다는 뜻이라 목록이 다시 읽는다.
   * 도구 호출 하나마다 목록을 다시 읽을 까닭이 없다.
   */
  z.object({ ...appScoped, type: z.literal('external_apps_changed') }),
  /**
   * 감시 중인 디렉토리에서 뭔가 바뀌었다 (#34 — Finder·터미널·에이전트, 출처 불문).
   *
   * 세션이 아니라 **프로젝트**의 사건이라 `update_status`와 같은 길(appScoped)을 탄다.
   * dirs는 **어느 디렉토리를 다시 읽어야 하는지**만 말한다 — 무엇이 어떻게 바뀌었는지는
   * 싣지 않는다. 플랫폼마다 이벤트의 정밀도가 달라서(macOS는 rename 뭉뚱그림) 그 정보를
   * 실으면 셋 중 한 플랫폼에서만 맞는 말이 된다. 다시 읽기는 어차피 한 번의 listDir다.
   */
  z.object({ ...appScoped, type: z.literal('fs_changed'), projectId: z.string(), dirs: z.array(z.string()) }),
  z.object({ ...appScoped, type: z.literal('error'), error: ProtocolError }),
])
export type NormalizedEvent = z.infer<typeof NormalizedEvent>

export type NormalizedEventType = NormalizedEvent['type']

/**
 * 모르는 이벤트 타입은 무시한다 (docs/protocol.md §4 — 추가는 버전 불변).
 * 수신 경계에서만 호출할 것.
 */
export function parseEventLenient(raw: unknown): NormalizedEvent | null {
  const r = NormalizedEvent.safeParse(raw)
  return r.success ? r.data : null
}
