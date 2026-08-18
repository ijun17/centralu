/**
 * 지금 화면에 무엇이 보이는가 — 응답 완료 바람이 불지 말지의 근거.
 *
 * 파일 이름이 Gust.tsx와 **대소문자만 달라서는 안 된다.** macOS 파일시스템은
 * 대소문자를 구분하지 않아 번들러가 엉뚱한 파일을 문다 — 타입체크는 통과하는데
 * 화면이 통째로 빈 채로 뜬다 (시연하다 실제로 겪었다).
 *
 * 끝난 세션이 지금 화면에 있을 때만 분다. 안 보이는 세션까지 쓸어버리면,
 * 다른 것을 읽는 동안 관계없는 바람이 계속 지나간다 — 세션이 여럿일수록 심해진다.
 * 화면 밖에서 끝난 것은 이미 뱃지와 알림이 말한다.
 *
 * "지금 보고 있는 것이 끝났다"는 사실 하나만 몸으로 알려주는 게 이 애니메이션의 몫이다.
 */
export type View = 'focus' | 'grid' | 'orchestrator'

export type Onscreen = {
  focusedSessionId: string | null
  orchestratorId: string | null
  gridPanels: readonly string[]
}

export function isOnScreen(view: View, sessionId: string, ctx: Onscreen): boolean {
  if (view === 'focus') return ctx.focusedSessionId === sessionId
  if (view === 'orchestrator') return ctx.orchestratorId === sessionId
  // 그리드는 여러 개가 동시에 보인다 — 그중 하나만 끝나도 화면에서 끝난 것이다
  return ctx.gridPanels.includes(sessionId)
}
