import { z } from 'zod'
import {
  ApprovalDecision,
  ApprovalDetail,
  ProtocolError,
  SessionActivity,
  SessionState,
  TokenUsage,
  ToolSummary,
} from './entities.js'

/**
 * 어댑터 → 앱 방향의 정규화 이벤트 (docs/protocol.md §2).
 * 도구별 차이는 어댑터가 흡수하고, UI/core는 이 타입만 안다.
 */
const base = { sessionId: z.string() }

export const NormalizedEvent = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('message_delta'), role: z.enum(['assistant']), text: z.string() }),
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
  z.object({ ...base, type: z.literal('tool_call'), callId: z.string(), summary: ToolSummary }),
  z.object({
    ...base,
    type: z.literal('tool_result'),
    callId: z.string(),
    ok: z.boolean(),
    summary: z.string().default(''),
  }),
  z.object({ ...base, type: z.literal('approval_request'), requestId: z.string(), detail: ApprovalDetail }),
  z.object({
    ...base,
    type: z.literal('approval_resolved'),
    requestId: z.string(),
    decision: ApprovalDecision,
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
  z.object({ ...base, type: z.literal('session_title'), title: z.string() }),
  /** 동시 세션 충돌 감지·최근 수정 파일 하이라이트용 (FR-2, FR-5) */
  z.object({ ...base, type: z.literal('files_touched'), paths: z.array(z.string()) }),
  /** 지금 무엇을 하느라 바쁜가 — null이면 평범한 응답 대기 */
  z.object({ ...base, type: z.literal('activity'), activity: SessionActivity.nullable() }),
  /** 컨텍스트 압축이 일어났다 — 대화창에 마커를 남긴다 (FR-14) */
  z.object({
    ...base,
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
  z.object({ ...base, type: z.literal('history_synced'), added: z.number() }),
  /** 세션이 삭제됐다 — 다른 창·재연결에서도 목록이 맞아야 한다 */
  z.object({ ...base, type: z.literal('session_deleted') }),
  z.object({ sessionId: z.string().optional(), type: z.literal('error'), error: ProtocolError }),
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
