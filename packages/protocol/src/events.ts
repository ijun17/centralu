import { z } from 'zod'
import {
  ApprovalDecision,
  ApprovalDetail,
  ProtocolError,
  Question,
  SessionActivity,
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

export const NormalizedEvent = z.discriminatedUnion('type', [
  z.object({ ...base, ...persistedSeq, type: z.literal('message_delta'), role: z.enum(['assistant']), text: z.string() }),
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
  z.object({ ...base, type: z.literal('user_message'), seq: z.number(), text: z.string() }),
  z.object({ ...base, ...persistedSeq, type: z.literal('tool_call'), callId: z.string(), summary: ToolSummary }),
  z.object({
    ...base,
    ...persistedSeq,
    type: z.literal('tool_result'),
    callId: z.string(),
    ok: z.boolean(),
    summary: z.string().default(''),
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
  }),
  z.object({ ...base, type: z.literal('history_synced'), added: z.number() }),
  /** 세션이 삭제됐다 — 다른 창·재연결에서도 목록이 맞아야 한다 */
  z.object({ ...base, type: z.literal('session_deleted') }),
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
