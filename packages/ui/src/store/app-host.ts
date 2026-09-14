import { useEffect } from 'react'
import type { ApprovalDecision, QuestionAnswer } from '@cc/protocol'
import type { SessionSummary } from '@cc/core'
import type { AppHostApi } from '../apps/host.js'
import type { AppId } from '../apps/contract.js'
import { useStore } from './store.js'
import { useCounts, useInbox } from './selectors.js'

/**
 * 앱 런타임이 요구하는 표면의 **이 제품 쪽 구현** (#97).
 *
 * 방향이 여기서 뒤집힌다: 스토어가 런타임의 계약(apps/host.ts)을 임포트하고,
 * 런타임은 스토어를 모른다. 반대 방향 — 런타임이 스토어를 임포트하던 것 — 이
 * 인박스를 지우면 런타임이 컴파일되지 않게 만들던 그 매듭이었다.
 *
 * 앱이 쓰는 이름(api.ts)과 스토어가 쓰는 이름(setAppDoc 등)이 다른 자리가 있다.
 * 번역은 여기서 한 번 한다 — 런타임 쪽 이름은 앱 저자가 읽는 말이어야 한다.
 */

function useSessionSummaries(): Record<string, SessionSummary> {
  return useStore((s) => s.sessions)
}

function useFocusedSessionId(): string | null {
  return useStore((s) => s.focusedSessionId)
}

/**
 * 세션이 마지막으로 **말한** 문장 (#80 레일).
 *
 * preview는 사이드바 힌트라 툴 호출이 오면 도구 제목으로 덮인다 — 서사로 쓰면
 * "pnpm verify" 한 줄만 남아 맥락이 사라진다 (도그푸딩 2026-09-05). 말과 도구를
 * 가르는 정본은 대화(chat)다. 대화가 아직 안 실린 세션(이번 기동에서 연 적도,
 * 살아 움직인 적도 없음)은 null — 호출자가 preview로 물러난다.
 */
function useLastWords(sessionId: string): string | null {
  return useStore((s) => {
    const items = s.chat[sessionId]
    if (!items) return null
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]!
      if (it.kind === 'assistant' && it.text.trim()) {
        const lines = it.text.trim().split('\n').filter(Boolean)
        return (lines[lines.length - 1] ?? '').slice(0, 160)
      }
      if (it.kind === 'user') break // 사람이 말한 뒤 아직 답이 없다 — 옛 답을 서사로 내밀지 않는다
    }
    return null
  })
}

/** 말 이후에 도구가 돌고 있으면 그 제목 — 서사(말)의 보조 줄 (#80 레일) */
function useRunningTool(sessionId: string): string | null {
  return useStore((s) => {
    const items = s.chat[sessionId]
    if (!items) return null
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]!
      if (it.kind === 'tool') return `${it.tool}: ${it.title}`.slice(0, 80)
      if (it.kind === 'assistant' || it.kind === 'user') return null
    }
    return null
  })
}

/** 앱 자신의 문서 — 처음 쓰는 순간 불러온다 (스토어는 앱 목록을 모른다: 순환 금지) */
function useAppState<T>(id: AppId): T | null {
  const doc = useStore((s) => s.apps[id]?.doc)
  const ensure = useStore((s) => s.ensureAppState)
  useEffect(() => void ensure(id), [id, ensure])
  return (doc as T) ?? null
}

function useAppEnabled(id: AppId): boolean {
  const enabled = useStore((s) => s.apps[id]?.enabled)
  const ensure = useStore((s) => s.ensureAppState)
  useEffect(() => void ensure(id), [id, ensure])
  return enabled ?? true
}

export const storeAppHost: AppHostApi = {
  useInbox,
  useCounts,
  useSessionSummaries,
  useFocusedSessionId,
  useLastWords,
  useRunningTool,
  useAppState,
  useAppEnabled,

  respondApproval(sessionId: string, requestId: string, decision: ApprovalDecision): void {
    void useStore.getState().respondApproval(sessionId, requestId, decision)
  },
  answerQuestion(sessionId: string, requestId: string, answers: QuestionAnswer[]): void {
    void useStore.getState().answerQuestion(sessionId, requestId, answers)
  },
  send(sessionId: string, text: string): void {
    void useStore.getState().send(sessionId, text)
  },
  focusSession(id: string, opts?: { preferGrid?: boolean }): void {
    useStore.getState().focusSession(id, opts)
  },
  markRead(sessionId: string): void {
    void useStore.getState().markRead(sessionId)
  },
  setAppState(id: AppId, doc: unknown): void {
    void useStore.getState().setAppDoc(id, doc)
  },
  invokeAppTool(id: AppId, name: string, args: Record<string, unknown>) {
    return useStore.getState().invokeAppTool(id, name, args)
  },
}
