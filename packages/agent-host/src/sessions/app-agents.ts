import type { NormalizedEvent, StoredMessage } from '@cc/protocol'

/**
 * 앱이 부탁한 에이전트 (M4 D-1) — 세션에 무엇을 보내고, 끝난 세션에서 무엇을 답으로 읽는가.
 *
 * 세션을 세우고 기다리는 일은 매니저가 한다(`SessionManager.runAppAgent`). 보내는 글의 틀은 대화 안 화면의 말과 같은 것을
 * 쓴다(`manager.ts`의 `appMessageFrame`). 여기는 그 뒤의 일만 다룬다: 턴의 결말을 기다리는 것과, 마지막 답을 대화 기록에서
 * 골라내는 규칙.
 */

/**
 * 턴의 마지막 답 — 대화 기록의 끝에서 마지막 도구 호출 뒤에 선 에이전트의 글.
 *
 * "마지막 글 하나"가 아니라 "마지막 도구 호출 뒤의 글"인 이유: 에이전트는 글을 쓰고, 도구를 부르고, 다시 쓴다. 도구 앞의
 * 글은 계획이지 답이 아니다. 추론 요약(`reasoning`)은 답이 아니므로 건너뛰고, 도구 호출·결과·승인·마커·사람의 말을
 * 만나면 멈춘다. 끝에 글이 없으면(도구 호출로 턴이 끝났다) 빈 답이다 — 앞의 계획을 답인 척 돌려주지 않는다.
 */
export function finalAnswer(messages: readonly StoredMessage[]): string {
  const parts: string[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'assistant' && m.kind === 'reasoning') continue
    if (m.role === 'assistant' && m.kind === 'text') {
      parts.unshift(String((m.payload as { text?: unknown }).text ?? ''))
      continue
    }
    break
  }
  return parts.join('\n\n').trim()
}

/**
 * 앱이 답을 기다리는 세션 하나 (M4 D-1) — 그 세션의 이벤트를 보고 턴의 결말을 정한다.
 *
 *   turn_complete   답이 났다(구조화 출력이 있으면 함께). 단 사람이 멈춘 턴의 끝은 답이 아니다 — 멈췄다고 돌려준다
 *   error           턴이 실패했다(도구가 죽은 것 포함)
 *   limit_reached   사용량 한도 — 기다려도 이 턴은 풀리지 않는다
 *   승인·질문        사람을 기다린다 — 앱에 한 줄 알린다(앱이 멈춘 것이 아니라 사람을 기다린다는 것)
 *
 * 한 번 정해지면 그 뒤의 이벤트는 보지 않는다.
 */
export class AgentRunWait {
  /** 사람이 그 세션의 턴을 멈췄다 (`SessionManager.interrupt`) */
  stoppedByPerson = false
  /** 사람이 그 세션을 지웠다 — 끝맺을 세션이 없다 */
  deleted = false
  readonly done: Promise<{ output?: unknown }>
  private settle!: { resolve: (v: { output?: unknown }) => void; reject: (e: Error) => void }
  private settled = false

  constructor(
    private notify: (message: string) => void,
    private sessionName: () => string,
  ) {
    this.done = new Promise((resolve, reject) => (this.settle = { resolve, reject }))
    // 기다리는 쪽이 붙기 전에 실패해도 처리되지 않은 거절로 새지 않게
    this.done.catch(() => {})
  }

  onEvent(e: NormalizedEvent): void {
    if (this.settled) return
    switch (e.type) {
      case 'turn_complete':
        if (this.stoppedByPerson) return this.fail(new Error('the person stopped the agent before it finished'))
        this.settled = true
        return this.settle.resolve(e.output === undefined ? {} : { output: e.output })
      case 'error':
        return this.fail(new Error(this.stoppedByPerson ? 'the person stopped the agent before it finished' : `the agent's turn failed: ${e.error.message}`))
      case 'limit_reached':
        return this.fail(new Error(`the agent reached its usage limit${e.resumeAt ? ` (it resets at ${e.resumeAt})` : ''}`))
      case 'approval_request':
        return this.notify(`waiting for the person to approve a step in "${this.sessionName()}"`)
      case 'question_request':
        return this.notify(`waiting for the person to answer a question in "${this.sessionName()}"`)
    }
  }

  fail(err: Error): void {
    if (this.settled) return
    this.settled = true
    this.settle.reject(err)
  }
}
