import type { ApprovalDecision, QuestionAnswer } from '@cc/protocol'
import type { InboxItem, SessionSummary, WaitingCounts } from '@cc/core'
import type { AppId } from './contract.js'

/**
 * What the runtime requires of the host (#97) — the back side of the pass.
 *
 * api.ts is the only door through which an app touches core, and this file writes down what has
 * to exist on the other side of that door. api.ts used to import the store directly — that made
 * the layer that carries apps lean on one specific passenger it happened to be carrying (the
 * inbox), and removing that passenger would stop the runtime from compiling. The direction is now
 * reversed: the runtime only declares the shape it needs, and the host attaches an implementation
 * at startup (store/app-host.ts).
 *
 * This type is exactly the size of the surface. It grows only when an app's need is proven.
 */
export type AppHostApi = {
  // ── view (read-only) ─────────────────────────────────────────────
  useInbox(now: number): InboxItem[]
  useCounts(): WaitingCounts
  useSessionSummaries(): Record<string, SessionSummary>
  useFocusedSessionId(): string | null
  useLastWords(sessionId: string): string | null
  useRunningTool(sessionId: string): string | null
  useAppState<T>(id: AppId): T | null
  useAppEnabled(id: AppId): boolean

  // ── actions ─────────────────────────────────────────────────────
  respondApproval(sessionId: string, requestId: string, decision: ApprovalDecision): void
  answerQuestion(sessionId: string, requestId: string, answers: QuestionAnswer[]): void
  send(sessionId: string, text: string): void
  focusSession(id: string, opts?: { preferGrid?: boolean }): void
  markRead(sessionId: string): void
  setAppState(id: AppId, doc: unknown): void
  invokeAppTool(
    id: AppId,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; isError?: boolean }>
}

let attached: AppHostApi | null = null

/**
 * Once at startup, before any app is rendered (app/App.tsx).
 *
 * This is module-level registration — not a container, not a context. Since there is exactly one
 * host and it must always stand before any app, what is gained here is not freedom to inject, it
 * is direction.
 */
export function attachAppHost(impl: AppHostApi): void {
  attached = impl
}

export function appHost(): AppHostApi {
  if (!attached) {
    throw new Error('The app host is not attached yet — attachAppHost() must run before the first render')
  }
  return attached
}
