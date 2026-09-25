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
  /** 만드는 세션에 그대로 보낼 수 있는 글 */
  text: string
}

/** 앱마다 들고 있는 묶음의 수 — 최근 것만. host가 다시 뜨면 비워진다(오래 남는 것은 실행 기록의 몫이다) */
export const ERRORS_KEPT = 10

const KIND_LABEL: Record<AppErrorKind, string> = {
  start: '앱이 뜨지 못했습니다',
  crash: '앱 프로세스가 끝났습니다',
  tool: '도구 호출이 실패했습니다',
}

export function errorBundle(app: string, b: Omit<AppErrorBundle, 'text'>): AppErrorBundle {
  const lines = [`앱 ${app}: ${KIND_LABEL[b.kind]} (${new Date(b.at).toISOString()})`]
  if (b.tool) lines.push(`도구: ${b.tool}`)
  if (b.args !== null) lines.push(`인자: ${b.args}`)
  if (b.runId) lines.push(`실행 id: ${b.runId}`)
  lines.push(`이유: ${b.message}`)
  lines.push(b.stderr.length ? `표준에러 (마지막 줄들):\n${b.stderr.join('\n')}` : '표준에러: (아무것도 찍지 않았습니다)')
  return { ...b, text: lines.join('\n') }
}
