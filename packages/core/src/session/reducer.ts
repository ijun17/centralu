import type {
  ToolName,
  ApprovalDetail,
  NormalizedEvent,
  PermissionPreset,
  Question,
  SessionActivity,
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
  /** 오케스트레이터만 null — 프로젝트를 가로지르는 세션이라 어디에도 속하지 않는다 */
  projectId: string | null
  /**
   * 이 세션이 쓰는 도구.
   *
   * 프로젝트의 기본 도구와 다를 수 있다 — 한 프로젝트에서 claude 세션과 codex 세션을
   * 섞어 쓸 수 있기 때문이다. 없을 때 프로젝트 기본값으로 대신하면 헤더·사용량이
   * 틀린 도구를 가리킨다 (도그푸딩: 제목이 비슷한 두 세션을 다른 도구로 착각했다).
   */
  tool: ToolName
  name: string
  autoNamed: boolean
  state: SessionState
  /**
   * 바쁜 동안 무엇을 하느라 바쁜가 (state를 세분한다, 대체하지 않는다).
   * null이면 그냥 답을 기다리는 중.
   */
  activity: SessionActivity | null
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
  /**
   * 답을 기다리는 선택지들 (AskUserQuestion).
   *
   * **목록이다.** 승인은 단일 필드라 두 번째 요청이 첫 번째를 덮어 답할 길이 사라졌다 —
   * 그 실수를 여기서 반복하지 않는다. 한 번에 최대 4개 질문이 한 장으로 오고,
   * 장이 여럿 겹칠 수도 있다.
   */
  pendingQuestions: { requestId: string; questions: Question[] }[]
  usage: TokenUsage | null
  context: { used: number; window: number; exactness: 'exact' | 'estimate' } | null
  limit: { resumeAt?: string; usedPercent?: number; windowMins?: number } | null
  lastError: { code: string; message: string } | null
  /** 동시 세션 파일 충돌 감지용 (FR-2) */
  touchedPaths: string[]
  /** 세션 헤더에서 바꾼다 (FR-7) */
  model: string | null
  /** 추론 강도. 지원하지 않는 모델이면 null이다 (단계는 모델마다 다르다) */
  effort: string | null
  permissionPreset: PermissionPreset
  /**
   * 이 세션이 도는 워크트리 (FR-2 옵션). null이면 프로젝트 디렉토리에서 직접 돈다.
   * 화면이 이걸 알아야 "왜 프로젝트 폴더의 파일이 안 바뀌지"를 겪지 않는다.
   */
  worktree: { path: string; branch: string } | null
}

export function initialSession(init: Pick<SessionSummary, 'id' | 'projectId' | 'name'> & Partial<SessionSummary>): SessionSummary {
  return {
    autoNamed: true, state: 'idle', activity: null, waitingSince: null, lastSeq: 0, lastReadSeq: 0,
    archived: false, live: true, preview: '', pendingApproval: null, pendingQuestions: [], usage: null, context: null,
    limit: null, lastError: null, touchedPaths: [], model: null, effort: null, permissionPreset: 'normal',
    worktree: null,
    tool: 'claude' as const, ...init,
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

  /*
   * 바쁨의 종류는 바쁨보다 오래 살지 못한다.
   *
   * 압축 중에 프로세스가 죽거나 턴이 끝나버리면 도구는 "끝났다"는 신호를 못 보낸다.
   * 그때 activity가 남아 있으면 화면은 영원히 "Compacting"이라고 거짓말한다 —
   * 그래서 working에서 벗어나는 순간 함께 지운다.
   */
  const activity = event.type === 'activity' ? event.activity : state === 'working' ? s.activity : null

  /*
   * 회복하면 배너도 함께 내려간다.
   *
   * limit·lastError는 "지금 막혀 있다"는 배너의 근거인데, 한도가 풀리거나 오류에서
   * 살아나 다시 일하기 시작해도 남아 있으면 화면은 계속 막혀 있다고 거짓말한다 —
   * working/idle 진입은 곧 회복이므로 그 순간 지운다.
   */
  const recovered = !illegal && stateChanged && (state === 'working' || state === 'idle')
  /*
   * 승인·질문 카드는 **답할 수 있는 동안만** 산다.
   *
   * requestId가 죽는 길은 error만이 아니다: 승인 대기 중 인터럽트(turn_complete →
   * waiting_input)도, resume으로 idle 복귀도, working 재개도 그 요청을 끝장낸다.
   * 카드를 남겨두면 클릭이 죽은 요청에 답하려다 던진다 — 상태(가시성)와 payload
   * (액션 가능성)가 따로 놀면 안 된다. 회복 후 요청이 유효하면 호스트가 다시 보낸다
   * (위의 강제 표면화). 새 요청은 아래 switch가 이 소거 위에 다시 세운다.
   */
  const cardsDead =
    !illegal &&
    stateChanged &&
    (state === 'error' || recovered || (s.state === 'waiting_approval' && state === 'waiting_input'))
  const next: SessionSummary = illegal
    ? { ...s }
    : {
        ...s, state, waitingSince, activity,
        ...(recovered ? { limit: null, lastError: null } : {}),
        ...(cardsDead ? { pendingApproval: null, pendingQuestions: [] } : {}),
      }

  switch (event.type) {
    case 'message_delta':
      return { ...next, preview: truncate((s.state === 'working' ? s.preview : '') + event.text) }
    case 'tool_call':
      return { ...next, preview: truncate(event.summary.title) }
    case 'question_request':
      // 같은 id가 다시 오면 갈아 끼우고, 아니면 뒤에 쌓는다 (덮지 않는다)
      return {
        ...next,
        pendingQuestions: [
          ...s.pendingQuestions.filter((q) => q.requestId !== event.requestId),
          { requestId: event.requestId, questions: event.questions },
        ],
      }
    case 'question_resolved':
      return { ...next, pendingQuestions: s.pendingQuestions.filter((q) => q.requestId !== event.requestId) }
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
    case 'state_change': // limited 해제 등 회복 시 배너 정리는 위 recovered에서 일괄 처리
      return next
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
  return { ...s, archived: true, state: 'idle', waitingSince: null, pendingApproval: null, pendingQuestions: [] }
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
