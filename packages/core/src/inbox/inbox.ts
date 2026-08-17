import type { SessionState } from '@cc/protocol'
import { URGENCY, isWaiting } from '../session/state-machine.js'
import { isUnread } from '../unread/unread.js'

/**
 * 인박스 = 파생 상태 (docs/state-management.md §3). 절대 저장하지 않는다.
 * 정렬: 긴급도 → 안읽음 → 대기 시작 오름차순 (오래 기다린 것부터).
 */

export type InboxCandidate = {
  id: string
  /** 오케스트레이터는 프로젝트가 없다 */
  projectId: string | null
  name: string
  state: SessionState
  waitingSince: number | null
  lastSeq: number
  lastReadSeq: number
  archived: boolean
  preview?: string
}

export type InboxItem = InboxCandidate & {
  unread: boolean
  urgency: number
  waitingMs: number
}

export function buildInbox(sessions: readonly InboxCandidate[], now: number): InboxItem[] {
  return sessions
    .filter((s) => !s.archived && isWaiting(s.state))
    .map((s) => ({
      ...s,
      unread: isUnread(s),
      urgency: URGENCY[s.state],
      waitingMs: s.waitingSince == null ? 0 : Math.max(0, now - s.waitingSince),
    }))
    .sort(
      (a, b) =>
        a.urgency - b.urgency ||
        Number(b.unread) - Number(a.unread) ||
        (a.waitingSince ?? Infinity) - (b.waitingSince ?? Infinity) ||
        a.id.localeCompare(b.id),
    )
}

/** 전역 카운터 — 절대 합산하지 않는다 (FR-12: "승인 2 · 응답대기 3") */
export type WaitingCounts = { approval: number; error: number; input: number }

export function countWaiting(sessions: readonly InboxCandidate[]): WaitingCounts {
  const c: WaitingCounts = { approval: 0, error: 0, input: 0 }
  for (const s of sessions) {
    if (s.archived) continue
    if (s.state === 'waiting_approval') c.approval++
    else if (s.state === 'error') c.error++
    else if (s.state === 'waiting_input') c.input++
  }
  return c
}

/**
 * "다음 대기로 이동" (FR-17). 현재 세션 다음 항목으로 순환.
 * 인박스 정렬 순서를 그대로 따르므로 승인 → 오류 → 응답대기 순.
 */
export function nextWaitingSession(inbox: readonly InboxItem[], currentId: string | null): string | null {
  if (inbox.length === 0) return null
  if (currentId == null) return inbox[0]!.id
  const idx = inbox.findIndex((i) => i.id === currentId)
  if (idx === -1) return inbox[0]!.id
  return inbox[(idx + 1) % inbox.length]!.id
}

/** 항목 처리 후 자동 이동 대상 (FR-15). 처리된 항목은 이미 목록에서 빠졌다고 가정. */
export function afterHandled(inbox: readonly InboxItem[], handledId: string): string | null {
  const remaining = inbox.filter((i) => i.id !== handledId)
  return remaining[0]?.id ?? null
}
