import { useEffect } from 'react'
import type { ApprovalDecision, QuestionAnswer } from '@cc/protocol'
import type { SessionSummary } from '@cc/core'
import type { AppHostApi } from '../apps/host.js'
import type { AppId } from '../apps/contract.js'
import { useStore } from './store.js'
import { useCounts, useInbox } from './selectors.js'

/**
 * This product's own implementation of the surface the app runtime requires (#97).
 *
 * The direction is inverted here: the store imports the runtime's contract (apps/host.ts), and
 * the runtime knows nothing about the store. The opposite direction — the runtime importing the
 * store — was the exact knot that stopped the runtime from compiling the moment the inbox was
 * removed.
 *
 * There are spots where the name an app uses (api.ts) differs from the name the store uses
 * (setAppDoc, etc). The translation happens once, here — the runtime-side name has to be the
 * wording an app author reads.
 */

function useSessionSummaries(): Record<string, SessionSummary> {
  return useStore((s) => s.sessions)
}

function useFocusedSessionId(): string | null {
  return useStore((s) => s.focusedSessionId)
}

/**
 * The last sentence the session spoke (#80 rail).
 *
 * preview is a sidebar hint, so it gets overwritten by the tool title the moment a tool call
 * comes in — using it as the narration leaves only a line like "pnpm verify" with all context
 * gone (dogfooding, 2026-09-05). The authoritative source that tells speech and tools apart is
 * the conversation (chat). A session with no conversation loaded yet (never opened this session,
 * never seen live) returns null, and the caller falls back to preview.
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
      if (it.kind === 'user') break // The person spoke and there is no answer yet — an old answer is not shown as the narration
    }
    return null
  })
}

/** If a tool is running after that speech, its title — a secondary line to the narration (#80 rail) */
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

/** The app's own document — loaded the moment it is first used (the store does not know the app list: no cycles allowed) */
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
