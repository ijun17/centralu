/**
 * 앱의 오류 묶음 (M4 C-6) — 앱이 뜨지 못했거나, 죽었거나, 도구가 실패했을 때 그 순간을 한 덩어리로 든다.
 *
 * 쓰는 쪽은 사람이다: 앱 화면이 "만드는 세션에 보내기"를 내밀고, 사람이 누르면 이 묶음이 만드는 세션에 간다.
 * **자동으로 보내지 않는다** — 에이전트가 사람 모르게 고치고 깨뜨리기를 되풀이하는 것을 막는다(플랜 C-6). 그래서
 * host는 모으고 물으면 답하기만 한다.
 *
 * 들어가는 것: 무엇이(종류·이유), 언제, 어느 도구가 어떤 인자로(요약 — 실행 기록과 같이 비밀은 가린다), 그때 앱이
 * 표준에러에 찍은 마지막 줄들. 스파이크 S-6에서 만드는 에이전트를 가장 오래 헤매게 한 것이 "서버는 떠 있는데 이유가
 * 어디에도 없다"였다 — 표준에러가 이 묶음의 몸통이다.
 */

export type AppErrorKind = 'start' | 'crash' | 'tool'

export type AppErrorBundle = {
  kind: AppErrorKind
  at: number
  /** 한 줄 이유 — 뜨지 못한 까닭, 끝난 모양, 도구가 돌려준 실패 */
  message: string
  /** 앱의 표준에러 마지막 줄들 (비밀은 가린 뒤) */
  stderr: string[]
  /** 실패한 도구 (도구 오류만) */
  tool: string | null
  /** 그 호출의 인자 요약 — 비밀은 이름으로 가린다 (도구 오류만) */
  args: string | null
  runId: string | null
  /**
   * 이 실패가 사람의 결정에서 왔다 (D-4) — 이 호출(또는 그 아래 사슬)의 부탁을 사람이 거절했다. 앱의 버그가 아니므로 화면은 오류로
   * 보이지 않고 그 결정으로 말한다(되돌리는 자리는 그 앱의 기록 판: Permissions → Forget). 만드는 세션에도 보내지 않는다 — 보내면
   * 만드는 에이전트가 멀쩡한 코드를 "고친다". 도구 실패의 묶음에만 선다.
   */
  denied: { appId: string; projectId: string | null; name: string; capability: string; text: string } | null
  /** 만드는 세션에 그대로 보낼 수 있는 글 */
  text: string
}

/** 앱마다 들고 있는 묶음의 수 — 최근 것만. host가 다시 뜨면 비워진다(오래 남는 것은 실행 기록의 몫이다) */
export const ERRORS_KEPT = 10

const KIND_LABEL: Record<AppErrorKind, string> = {
  start: 'the app could not start',
  crash: "the app's process ended",
  tool: 'a tool call failed',
}

export function errorBundle(app: string, input: Omit<AppErrorBundle, 'text' | 'denied'> & { denied?: AppErrorBundle['denied'] }): AppErrorBundle {
  const b = { ...input, denied: input.denied ?? null }
  const lines = [`App ${app}: ${KIND_LABEL[b.kind]} (${new Date(b.at).toISOString()})`]
  if (b.tool) lines.push(`Tool: ${b.tool}`)
  if (b.args !== null) lines.push(`Arguments: ${b.args}`)
  if (b.runId) lines.push(`Run id: ${b.runId}`)
  lines.push(`Reason: ${b.message}`)
  if (b.denied) lines.push(`The person denied this: ${b.denied.name} may not ${b.denied.text}`)
  lines.push(b.stderr.length ? `stderr (last lines):\n${b.stderr.join('\n')}` : 'stderr: (the app printed nothing)')
  return { ...b, text: lines.join('\n') }
}
