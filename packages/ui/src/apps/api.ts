import type { QuestionAnswer, ApprovalDecision } from '@cc/protocol'
import type { InboxItem, SessionSummary, WaitingCounts } from '@cc/core'
import type { AppId } from './contract.js'
import { appHost } from './host.js'

/**
 * The pass (#81) — the only door through which an app touches core.
 *
 * What is here is the whole of what an app can have. All of it delegates: the judgment and the
 * state already live in the host — this file invents nothing, it only narrows. It grows only
 * when an app's need is proven, since every added line becomes a piece of host surface that some
 * app now leans on (the "living part" of #81, with that surface's types living in host.ts).
 *
 * What it delegates to is an attached implementation, not an import (#97): this layer knows
 * nothing of the store or the inbox, only the shape it needs.
 */

// ── view (read-only) ─────────────────────────────────────────────

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

/** The last sentence the session spoke (#80 rail) — null with no conversation, and the caller
 * falls back to a preview */
export function useLastWords(sessionId: string): string | null {
  return appHost().useLastWords(sessionId)
}

/** If a tool is running after that speech, its title — a secondary line to the narration (#80
 * rail) */
export function useRunningTool(sessionId: string): string | null {
  return appHost().useRunningTool(sessionId)
}

/** The app's own document — loaded the moment it is first used */
export function useAppState<T>(id: AppId): T | null {
  return appHost().useAppState<T>(id)
}

export function useAppEnabled(id: AppId): boolean {
  return appHost().useAppEnabled(id)
}

// ── actions (allowlist — a thin delegation to host actions) ────────────────────

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

/**
 * Replaces the document in this app's own namespace.
 *
 * What used to block writing another app's document was the AppId union, and that union was
 * opened up in M4 P-1 — there was only ever one member anyway, so what it blocked was never
 * "someone else's app", only a typo. A compiled app writes its own id as a literal. An external
 * app in M4 does not go through this door at all — its screen runs in an iframe, and the host
 * decides which app it is by the frame the message came from (docs/plans/apps-plan.md, "there is
 * one call path").
 */
export function setAppState(id: AppId, doc: unknown): void {
  appHost().setAppState(id, doc)
}

/** Calls an app's host tool with the person's own permission (#81) — e.g. creating a task.
 * Returns the result text */
export function invokeAppTool(
  id: AppId,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError?: boolean }> {
  return appHost().invokeAppTool(id, name, args)
}
