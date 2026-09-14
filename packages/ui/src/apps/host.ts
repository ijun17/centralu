import type { ApprovalDecision, QuestionAnswer } from '@cc/protocol'
import type { InboxItem, SessionSummary, WaitingCounts } from '@cc/core'
import type { AppId } from './contract.js'

/**
 * 런타임이 호스트에게 **요구하는** 것 (#97) — 통행증의 뒷면.
 *
 * api.ts는 앱이 코어를 만지는 유일한 문이고, 이 파일은 그 문 너머에 무엇이 있어야
 * 하는지를 적는다. 전에는 api.ts가 스토어를 직접 임포트했다 — 그러면 앱을 태우는
 * 층이 자기가 태운 승객 하나(인박스)에 기대게 되고, 그 승객을 지우면 런타임이
 * 컴파일되지 않는다. 이제 방향이 반대다: 런타임은 필요한 모양만 선언하고,
 * 호스트가 기동 때 구현을 얹는다 (store/app-host.ts).
 *
 * 이 타입이 곧 표면의 크기다. 늘리는 것은 앱의 필요가 증명될 때만.
 */
export type AppHostApi = {
  // ── view (읽기 전용) ─────────────────────────────────────────────
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
 * 기동에 한 번, **아무 앱도 그려지기 전에** (app/App.tsx).
 *
 * 모듈 수준 등록이다 — 컨테이너도 컨텍스트도 아니다. 호스트가 하나뿐이고 앱보다
 * 반드시 먼저 서기 때문에, 여기서 얻는 것은 주입의 자유가 아니라 **방향**이다.
 */
export function attachAppHost(impl: AppHostApi): void {
  attached = impl
}

export function appHost(): AppHostApi {
  if (!attached) {
    throw new Error('앱 호스트가 아직 붙지 않았습니다 — attachAppHost()가 첫 렌더보다 먼저여야 합니다')
  }
  return attached
}
