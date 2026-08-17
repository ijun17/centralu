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

export function useUnread(sessionId: string): boolean {
  return useStore((s) => {
    const x = s.sessions[sessionId]
    return x ? isUnread(x) : false
  })
}

export function useFocusedSession(): SessionSummary | undefined {
  return useStore((s) => (s.focusedSessionId ? s.sessions[s.focusedSessionId] : undefined))
}

/**
 * 사이드바에서 **지금 고른 것**.
 *
 * 컨트롤 센터를 보고 있으면 세션도 프로젝트도 고른 것이 아니다 — 고른 것은 컨트롤 센터다.
 * 예전에는 세션 줄이 `focusedSessionId`만 봐서, 컨트롤 센터에 들어가도 세션이 계속
 * 골라진 것처럼 밝게 남아 있었다 (도그푸딩). 화면에 밝은 것이 둘이면 어느 쪽을 보고
 * 있는지 화면이 스스로 모순된다.
 *
 * 한 곳에서 계산하는 이유: 세션 줄과 프로젝트 줄이 각자 판단하면 언젠가 한쪽만 고쳐진다.
 */
export function useSelectedSessionId(): string | null {
  return useStore((s) => (s.view === 'focus' ? s.focusedSessionId : null))
}

export function useIsProjectSelected(projectId: string): boolean {
  return useStore((s) => s.view === 'focus' && s.focusedProjectId === projectId && !s.focusedSessionId)
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
