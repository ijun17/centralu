import type { QuestionAnswer, ApprovalDecision } from '@cc/protocol'
import type { InboxItem, SessionSummary, WaitingCounts } from '@cc/core'
import type { AppId } from './contract.js'
import { appHost } from './host.js'

/**
 * 통행증 (#81) — **앱이 코어를 만지는 유일한 문.**
 *
 * 여기 있는 것이 앱이 가질 수 있는 전부다. 전부 위임이다: 판정도 상태도 이미
 * 호스트에 있다 — 이 파일은 발명하지 않고 좁힌다. 늘리는 것은 앱의 필요가
 * 증명될 때만 — 늘어난 줄 하나하나가 앱이 기대는 호스트 표면이 된다
 * (#81의 "살아 있는 부분", 그 표면의 타입은 host.ts).
 *
 * 위임처는 임포트가 아니라 **얹힌 구현**이다 (#97): 이 층은 스토어도 인박스도
 * 모른 채 자기가 필요한 모양만 안다.
 */

// ── view (읽기 전용) ─────────────────────────────────────────────

export type { InboxItem } from '@cc/core'
export type { SessionSummary } from '@cc/core'

export function useInbox(now: number): InboxItem[] {
  return appHost().useInbox(now)
}

export function useCounts(): WaitingCounts {
  return appHost().useCounts()
}

export function useSessionSummaries(): Record<string, SessionSummary> {
  return appHost().useSessionSummaries()
}

export function useFocusedSessionId(): string | null {
  return appHost().useFocusedSessionId()
}

/** 세션이 마지막으로 **말한** 문장 (#80 레일) — 대화가 없으면 null, 호출자가 preview로 물러난다 */
export function useLastWords(sessionId: string): string | null {
  return appHost().useLastWords(sessionId)
}

/** 말 이후에 도구가 돌고 있으면 그 제목 — 서사(말)의 보조 줄 (#80 레일) */
export function useRunningTool(sessionId: string): string | null {
  return appHost().useRunningTool(sessionId)
}

/** 앱 자신의 문서 — 처음 쓰는 순간 불러온다 */
export function useAppState<T>(id: AppId): T | null {
  return appHost().useAppState<T>(id)
}

export function useAppEnabled(id: AppId): boolean {
  return appHost().useAppEnabled(id)
}

// ── actions (허용 목록 — 호스트 액션의 얇은 위임) ────────────────────

export function respondApproval(sessionId: string, requestId: string, decision: ApprovalDecision): void {
  appHost().respondApproval(sessionId, requestId, decision)
}

export function answerQuestion(sessionId: string, requestId: string, answers: QuestionAnswer[]): void {
  appHost().answerQuestion(sessionId, requestId, answers)
}

export function send(sessionId: string, text: string): void {
  appHost().send(sessionId, text)
}

export function focusSession(id: string, opts?: { preferGrid?: boolean }): void {
  appHost().focusSession(id, opts)
}

export function markRead(sessionId: string): void {
  appHost().markRead(sessionId)
}

/** 자기 네임스페이스의 문서 교체 — 다른 앱의 문서는 타입이 막는다 (AppId 유니온) */
export function setAppState(id: AppId, doc: unknown): void {
  appHost().setAppState(id, doc)
}

/** 앱의 host 도구를 사람 권한으로 부른다 (#81) — 업무 만들기 등. 결과 텍스트를 돌려준다 */
export function invokeAppTool(
  id: AppId,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError?: boolean }> {
  return appHost().invokeAppTool(id, name, args)
}
