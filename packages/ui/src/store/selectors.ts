import { useMemo } from 'react'
import { buildInbox, countWaiting, detectFileConflicts, isUnread, type InboxItem } from '@cc/core'
import { useStore, type AppState } from './store.js'
import type { SessionSummary } from '@cc/core'

/**
 * 파생 상태는 전부 여기서 계산한다 (docs/state-management.md §3) — 저장 금지.
 * 주의: zustand 셀렉터가 매번 새 객체를 만들면 무한 리렌더가 난다.
 * 그래서 스토어에서는 안정된 참조(sessions 맵)만 꺼내고, 계산은 useMemo로 감싼다.
 */

const toCandidate = (x: SessionSummary) => ({
  id: x.id, projectId: x.projectId, name: x.name, state: x.state,
  waitingSince: x.waitingSince, lastSeq: x.lastSeq, lastReadSeq: x.lastReadSeq,
  archived: x.archived, preview: x.preview,
})

export function useInbox(now: number): InboxItem[] {
  const sessions = useStore((s) => s.sessions)
  return useMemo(() => buildInbox(Object.values(sessions).map(toCandidate), now), [sessions, now])
}

export function useCounts() {
  const sessions = useStore((s) => s.sessions)
  return useMemo(() => countWaiting(Object.values(sessions).map(toCandidate)), [sessions])
}

export function useSessionsOf(projectId: string): SessionSummary[] {
  const sessions = useStore((s) => s.sessions)
  return useMemo(
    () => Object.values(sessions).filter((x) => x.projectId === projectId && !x.archived),
    [sessions, projectId],
  )
}

/** 숨긴 세션 (기록은 남아 있고 언제든 다시 꺼낼 수 있다) */
export function useHiddenSessionsOf(projectId: string): SessionSummary[] {
  const sessions = useStore((s) => s.sessions)
  return useMemo(
    () => Object.values(sessions).filter((x) => x.projectId === projectId && x.archived),
    [sessions, projectId],
  )
}

export function useUnread(sessionId: string): boolean {
  return useStore((s) => {
    const x = s.sessions[sessionId]
    return x ? isUnread(x) : false
  })
}

export function useFocusedSession(): SessionSummary | undefined {
  return useStore((s) => (s.focusedSessionId ? s.sessions[s.focusedSessionId] : undefined))
}

/** 비포커스 세션의 승인 요청 = 전역 배너 대상 (FR-3) */
export function useBannerApproval() {
  const sessions = useStore((s) => s.sessions)
  const focusedId = useStore((s) => s.focusedSessionId)
  return useMemo(() => {
    const first = Object.values(sessions).find((x) => !x.archived && x.pendingApproval && x.id !== focusedId)
    return first ? { session: first, pending: first.pendingApproval! } : null
  }, [sessions, focusedId])
}

export function useConflicts() {
  const sessions = useStore((s) => s.sessions)
  return useMemo(() => detectFileConflicts(Object.values(sessions)), [sessions])
}

/** 훅이 아닌 곳(전역 단축키 핸들러 등)에서 쓰는 순수 계산 */
export function computeInbox(state: AppState, now = Date.now()): InboxItem[] {
  return buildInbox(Object.values(state.sessions).map(toCandidate), now)
}
