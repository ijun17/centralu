import { z } from 'zod'
import {
  ApprovalDecision,
  ApprovalDetail,
  ProtocolError,
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
  /** 컨텍스트 압축이 일어났다 — 대화창에 마커를 남긴다 (FR-14) */
  z.object({ ...base, type: z.literal('compaction') }),
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
