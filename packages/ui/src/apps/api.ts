import { useEffect } from 'react'
import type { QuestionAnswer, ApprovalDecision } from '@cc/protocol'
import { useStore } from '../store/store.js'
import type { SessionSummary } from '@cc/core'
import type { AppId } from './contract.js'

/**
 * 통행증 (#81) — **앱이 코어를 만지는 유일한 문.**
 *
 * 여기 있는 것이 앱이 가질 수 있는 전부다. 대부분 재수출이다: 인박스 판정은
 * @cc/core에, 액션은 스토어에 이미 있다 — 이 파일은 발명하지 않고 좁힌다.
 * 늘리는 것은 앱의 필요가 증명될 때만 — 늘어난 줄 하나하나가 앱이 기대는
 * 코어 표면이 된다 (#81의 "살아 있는 부분").
 */

// ── view (읽기 전용) ─────────────────────────────────────────────

export { useInbox, useCounts } from '../store/selectors.js'
export type { InboxItem } from '@cc/core'
export type { SessionSummary } from '@cc/core'

export function useSessionSummaries(): Record<string, SessionSummary> {
  return useStore((s) => s.sessions)
}

export function useFocusedSessionId(): string | null {
  return useStore((s) => s.focusedSessionId)
}

/** 앱 자신의 문서 — 처음 쓰는 순간 불러온다 (스토어는 앱 목록을 모른다: 순환 금지) */
export function useAppState<T>(id: AppId): T | null {
  const doc = useStore((s) => s.apps[id]?.doc)
  const ensure = useStore((s) => s.ensureAppState)
  useEffect(() => void ensure(id), [id, ensure])
  return (doc as T) ?? null
}

export function useAppEnabled(id: AppId): boolean {
  const enabled = useStore((s) => s.apps[id]?.enabled)
  const ensure = useStore((s) => s.ensureAppState)
  useEffect(() => void ensure(id), [id, ensure])
  return enabled ?? true
}

// ── actions (허용 목록 — 스토어 액션의 얇은 위임) ────────────────────

export function respondApproval(sessionId: string, requestId: string, decision: ApprovalDecision): void {
  void useStore.getState().respondApproval(sessionId, requestId, decision)
}

export function answerQuestion(sessionId: string, requestId: string, answers: QuestionAnswer[]): void {
  void useStore.getState().answerQuestion(sessionId, requestId, answers)
}

export function send(sessionId: string, text: string): void {
  void useStore.getState().send(sessionId, text)
}

export function focusSession(id: string, opts?: { preferGrid?: boolean }): void {
  useStore.getState().focusSession(id, opts)
}

export function markRead(sessionId: string): void {
  void useStore.getState().markRead(sessionId)
}

/** 자기 네임스페이스의 문서 교체 — 다른 앱의 문서는 타입이 막는다 (AppId 유니온) */
export function setAppState(id: AppId, doc: unknown): void {
  void useStore.getState().setAppDoc(id, doc)
}
