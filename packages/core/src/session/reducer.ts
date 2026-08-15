import type {
  ApprovalDetail,
  NormalizedEvent,
  PermissionPreset,
  SessionState,
  TokenUsage,
} from '@cc/protocol'
import { transition } from './state-machine.js'

/**
 * 세션 요약 상태 (docs/state-management.md §2).
 * 비포커스 세션도 이것만은 유지한다 — 메시지 본문은 여기 없다 (§4 윈도잉).
 */
export type SessionSummary = {
  id: string
  projectId: string
  name: string
  autoNamed: boolean
  state: SessionState
  waitingSince: number | null
  lastSeq: number
  lastReadSeq: number
  archived: boolean
  /**
   * 프로세스가 살아 있는가 (FR-10).
   * host를 껐다 켜면 기록은 남지만 프로세스는 사라진다 — 그 상태를 UI가 알아야
   * "이어가기"를 권할 수 있다. 죽은 세션에 말을 걸고 기다리게 두는 것이 최악이다.
   */
  live: boolean
  /** 사이드바·인박스 미리보기 한 줄 */
  preview: string
  pendingApproval: { requestId: string; detail: ApprovalDetail } | null
  usage: TokenUsage | null
  context: { used: number; window: number; exactness: 'exact' | 'estimate' } | null
  limit: { resumeAt?: string; usedPercent?: number; windowMins?: number } | null
  lastError: { code: string; message: string } | null
  /** 동시 세션 파일 충돌 감지용 (FR-2) */
  touchedPaths: string[]
  /** 세션 헤더에서 바꾼다 (FR-7) */
  model: string | null
  permissionPreset: PermissionPreset
}

export function initialSession(init: Pick<SessionSummary, 'id' | 'projectId' | 'name'> & Partial<SessionSummary>): SessionSummary {
  return {
    autoNamed: true, state: 'idle', waitingSince: null, lastSeq: 0, lastReadSeq: 0,
    archived: false, live: true, preview: '', pendingApproval: null, usage: null, context: null,
    limit: null, lastError: null, touchedPaths: [], model: null, permissionPreset: 'normal', ...init,
  }
}

const PREVIEW_MAX = 80
const truncate = (s: string) => (s.length > PREVIEW_MAX ? s.slice(0, PREVIEW_MAX) + '…' : s)

/**
 * 유일한 상태 변경 지점. 순수 함수 — 같은 입력이면 같은 출력.
 * `now`를 인자로 받는 이유: 대기 시작 시각 기록이 테스트 가능해야 하기 때문.
 */
export function applyEvent(s: SessionSummary, event: NormalizedEvent, now: number): SessionSummary {
  const { state, illegal } = transition(s.state, event)
  const stateChanged = state !== s.state

  // 대기 진입 시각 기록 (인박스 정렬·경과 시간의 근거)
  const wasWaiting = s.state === 'waiting_approval' || s.state === 'waiting_input' || s.state === 'error'
  const isWaitingNow = state === 'waiting_approval' || state === 'waiting_input' || state === 'error'
  const waitingSince = isWaitingNow ? (wasWaiting && s.waitingSince != null ? s.waitingSince : now) : null

  const next: SessionSummary = illegal ? { ...s } : { ...s, state, waitingSince }

  switch (event.type) {
    case 'message_delta':
      return { ...next, preview: truncate((s.state === 'working' ? s.preview : '') + event.text) }
    case 'tool_call':
      return { ...next, preview: truncate(event.summary.title) }
    case 'approval_request':
      return { ...next, pendingApproval: { requestId: event.requestId, detail: event.detail } }
    case 'approval_resolved':
      return {
        ...next,
        pendingApproval: s.pendingApproval?.requestId === event.requestId ? null : s.pendingApproval,
      }
    case 'usage_update':
      return { ...next, usage: event.tokens }
    case 'context_update':
      return { ...next, context: { used: event.used, window: event.window, exactness: event.exactness } }
    case 'limit_reached':
      return {
        ...next,
        limit: { resumeAt: event.resumeAt, usedPercent: event.usedPercent, windowMins: event.windowMins },
      }
    case 'session_title':
      // 수동 이름 변경 시 자동 갱신 중단 (FR-18)
      return s.autoNamed ? { ...next, name: event.title } : next
    case 'files_touched':
      return { ...next, touchedPaths: [...new Set([...s.touchedPaths, ...event.paths])] }
    case 'error':
      return { ...next, lastError: { code: event.error.code, message: event.error.message } }
    case 'turn_complete':
      return next
    case 'state_change':
      // limited 해제 등으로 working 복귀 시 limit 정보 정리
      return stateChanged && state === 'working' ? { ...next, limit: null } : next
    default:
      return next
  }
}

/** 메시지 적재 시 seq 갱신 (읽음/안읽음의 근거) */
export function bumpSeq(s: SessionSummary, seq: number): SessionSummary {
  return seq > s.lastSeq ? { ...s, lastSeq: seq } : s
}

export function markRead(s: SessionSummary, seq: number): SessionSummary {
  return { ...s, lastReadSeq: Math.max(s.lastReadSeq, seq) }
}

export function rename(s: SessionSummary, name: string): SessionSummary {
  return { ...s, name, autoNamed: false }
}

export function archive(s: SessionSummary): SessionSummary {
  return { ...s, archived: true, state: 'idle', waitingSince: null, pendingApproval: null }
}

/** 같은 디렉토리 동시 세션 중 같은 파일을 만진 세션들 (FR-2 데이터 손실 경고) */
export function detectFileConflicts(sessions: readonly SessionSummary[]): { path: string; sessionIds: string[] }[] {
  const byPath = new Map<string, string[]>()
  for (const s of sessions) {
    if (s.archived) continue
    for (const p of s.touchedPaths) byPath.set(p, [...(byPath.get(p) ?? []), s.id])
  }
  return [...byPath.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([path, sessionIds]) => ({ path, sessionIds }))
}
