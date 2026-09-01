import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
import { applyEvent, detectFileConflicts, initialSession, markRead, rename } from './reducer.js'

const NOW = 1_000_000
const s0 = () => initialSession({ id: 's1', projectId: 'p1', name: '새 세션' })
const ev = (e: Record<string, unknown>) => ({ sessionId: 's1', ...e }) as NormalizedEvent

/** 실제 턴 하나의 이벤트 시퀀스 (스파이크에서 관찰한 순서) */
const TURN: NormalizedEvent[] = [
  ev({ type: 'message_delta', role: 'assistant', text: '작업을 ' }),
  ev({ type: 'tool_call', callId: 'c1', summary: { tool: 'Bash', title: 'npm run build', readOnly: false, paths: [] } }),
  ev({ type: 'approval_request', requestId: 'r1', detail: { kind: 'command', command: 'npm run build', cwd: '/p' } }),
  ev({ type: 'approval_resolved', requestId: 'r1', decision: 'allow' }),
  ev({ type: 'tool_result', callId: 'c1', ok: true, summary: 'exit 0' }),
  ev({ type: 'usage_update', tokens: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 } }),
  ev({ type: 'turn_complete' }),
]

const replay = (events: NormalizedEvent[], now = NOW) => events.reduce((s, e) => applyEvent(s, e, now), s0())

describe('이벤트 시퀀스 재생', () => {
  it('턴 하나를 재생하면 응답대기로 끝난다', () => {
    const s = replay(TURN)
    expect(s.state).toBe('waiting_input')
    expect(s.pendingApproval).toBeNull()
    expect(s.usage?.outputTokens).toBe(5)
  })

  it('승인 요청 중에는 waiting_approval + pendingApproval 보존', () => {
    const s = replay(TURN.slice(0, 3))
    expect(s.state).toBe('waiting_approval')
    expect(s.pendingApproval?.requestId).toBe('r1')
  })

  it('다른 requestId의 resolved는 pending을 지우지 않는다', () => {
    const s = applyEvent(replay(TURN.slice(0, 3)), ev({ type: 'approval_resolved', requestId: 'other', decision: 'allow' }), NOW)
    expect(s.pendingApproval?.requestId).toBe('r1')
  })

  it('멱등하지 않은 재생도 안전하다 (같은 이벤트 2회)', () => {
    const once = replay(TURN)
    const twice = replay([...TURN, ...TURN])
    expect(twice.state).toBe(once.state)
  })
})

describe('대기 시작 시각 (인박스 정렬의 근거)', () => {
  it('대기 진입 시 기록된다', () => {
    const s = replay(TURN, NOW)
    expect(s.waitingSince).toBe(NOW)
  })

  it('대기 상태끼리 전이해도 최초 시각을 유지한다', () => {
    let s = applyEvent(s0(), ev({ type: 'message_delta', role: 'assistant', text: 'x' }), NOW)
    s = applyEvent(s, ev({ type: 'approval_request', requestId: 'r', detail: { kind: 'other', raw: '{}' } }), NOW)
    const first = s.waitingSince
    s = applyEvent(s, ev({ type: 'error', error: { code: 'internal', message: 'x', retryable: false } }), NOW + 5000)
    expect(s.waitingSince).toBe(first)
  })

  it('작업 재개 시 초기화된다', () => {
    let s = replay(TURN)
    s = applyEvent(s, ev({ type: 'message_delta', role: 'assistant', text: '다시' }), NOW + 1000)
    expect(s.state).toBe('working')
    expect(s.waitingSince).toBeNull()
  })
})

describe('resume 직후 도착하는 승인·질문 (상태표가 삼키면 에이전트가 영원히 막힌다)', () => {
  it('idle에서 approval_request가 와도 대기로 표면화된다', () => {
    const s = applyEvent(s0(), ev({ type: 'approval_request', requestId: 'r9', detail: { kind: 'command', command: 'npm i', cwd: '/p' } }), NOW)
    expect(s.state).toBe('waiting_approval')
    expect(s.pendingApproval?.requestId).toBe('r9')
    expect(s.waitingSince).toBe(NOW)
  })

  it('idle에서 question_request도 마찬가지다', () => {
    const s = applyEvent(s0(), ev({ type: 'question_request', requestId: 'q9', questions: [{ question: '?', header: '', options: [], multiSelect: false }] }), NOW)
    expect(s.state).toBe('waiting_approval')
    expect(s.pendingQuestions).toHaveLength(1)
    expect(s.waitingSince).toBe(NOW)
  })

  it('waiting_input(턴 종료 후)에서 온 승인 요청도 삼키지 않는다', () => {
    const s = applyEvent(replay(TURN), ev({ type: 'approval_request', requestId: 'r10', detail: { kind: 'other', raw: '{}' } }), NOW + 1)
    expect(s.state).toBe('waiting_approval')
    expect(s.pendingApproval?.requestId).toBe('r10')
  })
})

describe('승인 대기 중 인터럽트 (막다른 상태 금지)', () => {
  it('waiting_approval에서 turn_complete가 오면 waiting_input으로 빠져나온다', () => {
    const s = applyEvent(replay(TURN.slice(0, 3)), ev({ type: 'turn_complete' }), NOW)
    expect(s.state).toBe('waiting_input')
  })

  it('빠져나올 때 죽은 승인·질문 카드도 함께 걷는다 — 클릭하면 죽은 requestId에 답하게 된다', () => {
    const waiting = applyEvent(
      applyEvent(replay(TURN.slice(0, 3)), ev({ type: 'question_request', requestId: 'q1', questions: [] }), NOW),
      ev({ type: 'turn_complete' }),
      NOW,
    )
    expect(waiting.state).toBe('waiting_input')
    expect(waiting.pendingApproval).toBeNull()
    expect(waiting.pendingQuestions).toEqual([])
  })
})

/*
 * 카드는 답할 수 있는 동안만 산다 — requestId가 죽는 길은 error만이 아니다.
 * resume(idle 복귀)·working 재개도 그 요청을 끝장내므로 카드를 함께 걷는다.
 * 상태(가시성)와 payload(액션 가능성)가 따로 놀면 응답 불가 카드가 남는다.
 */
describe('회복(idle/working 복귀) 시 카드 소거', () => {
  it('waiting_approval → idle(resume)이면 승인 카드가 걷힌다', () => {
    const s = applyEvent(replay(TURN.slice(0, 3)), ev({ type: 'state_change', state: 'idle', reason: 'resumed' }), NOW)
    expect(s.state).toBe('idle')
    expect(s.pendingApproval).toBeNull()
  })

  it('waiting_approval → working 재개면 카드가 걷힌다 (호스트가 유효한 요청은 다시 보낸다)', () => {
    const s = applyEvent(replay(TURN.slice(0, 3)), ev({ type: 'message_delta', role: 'assistant', text: '계속' }), NOW)
    expect(s.state).toBe('working')
    expect(s.pendingApproval).toBeNull()
  })

  it('새 승인 요청은 소거 위에 다시 선다', () => {
    const idle = applyEvent(replay(TURN.slice(0, 3)), ev({ type: 'state_change', state: 'idle', reason: 'resumed' }), NOW)
    const again = applyEvent(idle, ev({ type: 'approval_request', requestId: 'r2', detail: { kind: 'command', command: 'ls', cwd: '/' } }), NOW)
    expect(again.state).toBe('waiting_approval')
    expect(again.pendingApproval?.requestId).toBe('r2')
  })
})

describe('세션 이름 (FR-18)', () => {
  it('자동 이름은 session_title로 갱신된다', () => {
    const s = applyEvent(s0(), ev({ type: 'session_title', title: 'auth 리팩터링' }), NOW)
    expect(s.name).toBe('auth 리팩터링')
  })

  it('수동 변경 후에는 자동 갱신이 멈춘다', () => {
    const s = applyEvent(rename(s0(), '내가 정한 이름'), ev({ type: 'session_title', title: '자동' }), NOW)
    expect(s.name).toBe('내가 정한 이름')
  })

  /*
   * 사람이 고친 이름은 **몇 번째든** 다른 화면까지 가야 한다 (이슈 #5).
   * 예전엔 내 autoNamed만 보고 정해서, 두 번째 변경부터 조용히 버려졌다.
   */
  it('사람이 정한 이름(auto:false)은 이미 수동인 세션도 갱신한다', () => {
    const once = applyEvent(s0(), ev({ type: 'session_title', title: '가드 MCP', auto: false }), NOW)
    expect(once).toMatchObject({ name: '가드 MCP', autoNamed: false })
    const twice = applyEvent(once, ev({ type: 'session_title', title: '가드 MCP 2차', auto: false }), NOW)
    expect(twice.name).toBe('가드 MCP 2차')
  })

  it('사람이 정한 이름 뒤에 온 자동 이름은 버린다', () => {
    const named = applyEvent(s0(), ev({ type: 'session_title', title: '가드 MCP', auto: false }), NOW)
    const s = applyEvent(named, ev({ type: 'session_title', title: 'This session is being continued…', auto: true }), NOW)
    expect(s.name).toBe('가드 MCP')
  })
})

describe('바쁨의 종류 (activity)', () => {
  const working = () => applyEvent(s0(), ev({ type: 'state_change', state: 'working' }), NOW)

  it('압축 중임을 담되 상태는 여전히 working이다', () => {
    const s = applyEvent(working(), ev({ type: 'activity', activity: 'compacting' }), NOW)
    expect(s.activity).toBe('compacting')
    // 상태를 늘리지 않는 것이 요점이다 — state === 'working'을 보는 코드가 그대로 맞아야 한다
    expect(s.state).toBe('working')
  })

  it('턴이 끝나면 activity도 끝난다 — 도구가 끝났다고 말해주지 않아도', () => {
    const s = applyEvent(
      applyEvent(working(), ev({ type: 'activity', activity: 'compacting' }), NOW),
      ev({ type: 'turn_complete' }),
      NOW,
    )
    expect(s.activity).toBeNull()
  })

  it('압축 중 오류로 죽어도 "Compacting"이 남지 않는다', () => {
    const s = applyEvent(
      applyEvent(working(), ev({ type: 'activity', activity: 'compacting' }), NOW),
      ev({ type: 'error', error: { code: 'adapter_crashed', message: '프로세스 종료', retryable: true } }),
      NOW,
    )
    expect(s.activity).toBeNull()
  })
})

describe('한도·컨텍스트·오류', () => {
  it('limit_reached가 limited 상태와 해제 정보를 남긴다', () => {
    let s = applyEvent(s0(), ev({ type: 'message_delta', role: 'assistant', text: 'x' }), NOW)
    s = applyEvent(s, ev({ type: 'limit_reached', resumeAt: '2026-08-15T14:30:00Z', usedPercent: 21, windowMins: 10080 }), NOW)
    expect(s.state).toBe('limited')
    expect(s.limit).toEqual({ resumeAt: '2026-08-15T14:30:00Z', usedPercent: 21, windowMins: 10080 })
  })

  it('working 복귀 시 limit 정보가 정리된다', () => {
    let s = applyEvent(applyEvent(s0(), ev({ type: 'message_delta', role: 'assistant', text: 'x' }), NOW), ev({ type: 'limit_reached' }), NOW)
    s = applyEvent(s, ev({ type: 'state_change', state: 'working' }), NOW)
    expect(s.limit).toBeNull()
  })

  it('컨텍스트 게이지 값을 보관한다 (FR-14)', () => {
    const s = applyEvent(s0(), ev({ type: 'context_update', used: 84000, window: 200000, exactness: 'exact' }), NOW)
    expect(s.context).toEqual({ used: 84000, window: 200000, exactness: 'exact' })
  })

  it('오류는 error 상태와 메시지를 남긴다', () => {
    const s = applyEvent(s0(), ev({ type: 'error', error: { code: 'adapter_crashed', message: '죽음', retryable: true } }), NOW)
    expect(s.state).toBe('error')
    expect(s.lastError).toEqual({ code: 'adapter_crashed', message: '죽음' })
  })

  it('limited에서 message_delta로 재개해도 limit 배너가 정리된다', () => {
    let s = applyEvent(s0(), ev({ type: 'message_delta', role: 'assistant', text: 'x' }), NOW)
    s = applyEvent(s, ev({ type: 'limit_reached', resumeAt: '2026-08-15T14:30:00Z' }), NOW)
    s = applyEvent(s, ev({ type: 'message_delta', role: 'assistant', text: '재개' }), NOW + 1000)
    expect(s.state).toBe('working')
    expect(s.limit).toBeNull()
  })

  it('error에서 회복하면 lastError 배너가 정리된다', () => {
    let s = applyEvent(s0(), ev({ type: 'error', error: { code: 'adapter_crashed', message: '죽음', retryable: true } }), NOW)
    s = applyEvent(s, ev({ type: 'message_delta', role: 'assistant', text: '살아남' }), NOW + 1000)
    expect(s.state).toBe('working')
    expect(s.lastError).toBeNull()
  })

  it('idle 복귀도 회복이다 — limit·lastError가 남지 않는다', () => {
    let s = applyEvent(s0(), ev({ type: 'error', error: { code: 'internal', message: 'x', retryable: false } }), NOW)
    s = applyEvent(s, ev({ type: 'state_change', state: 'idle' }), NOW)
    expect(s.lastError).toBeNull()
  })

  it('error 진입 시 죽은 승인·질문 카드가 정리된다 (requestId가 죽었으므로)', () => {
    let s = applyEvent(replay(TURN.slice(0, 3)), ev({ type: 'question_request', requestId: 'q1', questions: [{ question: '?', header: '', options: [], multiSelect: false }] }), NOW)
    expect(s.pendingApproval).not.toBeNull()
    expect(s.pendingQuestions).toHaveLength(1)
    s = applyEvent(s, ev({ type: 'error', error: { code: 'adapter_crashed', message: '프로세스 종료', retryable: true } }), NOW)
    expect(s.state).toBe('error')
    expect(s.pendingApproval).toBeNull()
    expect(s.pendingQuestions).toEqual([])
  })
})

describe('읽음·아카이브', () => {
  it('읽음 위치는 뒤로 가지 않는다', () => {
    expect(markRead(markRead(s0(), 5), 2).lastReadSeq).toBe(5)
  })

})

describe('파일 충돌 감지 (FR-2 데이터 손실)', () => {
  it('두 세션이 같은 파일을 만지면 감지한다', () => {
    const a = applyEvent(initialSession({ id: 'a', projectId: 'p1', name: 'a' }), ev({ type: 'files_touched', paths: ['src/x.ts', 'src/a.ts'] }), NOW)
    const b = applyEvent(initialSession({ id: 'b', projectId: 'p1', name: 'b' }), { ...ev({ type: 'files_touched', paths: ['src/x.ts'] }), sessionId: 'b' } as NormalizedEvent, NOW)
    expect(detectFileConflicts([a, b])).toEqual([{ path: 'src/x.ts', sessionIds: ['a', 'b'] }])
  })

})

/** 생각의 양 (#58) — activity와 같은 수명: working을 벗어나면 죽는다 */
describe('thinkingTokens', () => {
  it('추정치가 누적되고 턴이 끝나면 사라진다', () => {
    const working = replay([ev({ type: 'state_change', state: 'working' })])
    const t1 = applyEvent(working, ev({ type: 'reasoning_delta', estTokens: 50 }), NOW)
    const t2 = applyEvent(t1, ev({ type: 'reasoning_delta', estTokens: 150 }), NOW)
    expect(t2.thinkingTokens).toBe(200)
    const done = applyEvent(t2, ev({ type: 'turn_complete' }), NOW)
    expect(done.thinkingTokens).toBeNull()
  })

  it('텍스트만 실린 조각(codex 요약)은 숫자를 만들지 않는다', () => {
    const working = replay([ev({ type: 'state_change', state: 'working' })])
    const s = applyEvent(working, ev({ type: 'reasoning_delta', text: '**검토 중**' }), NOW)
    expect(s.thinkingTokens).toBeNull()
  })
})

/** 계획 스냅샷 (#58, codex turn/plan/updated) — activity와 같은 수명 */
describe('plan', () => {
  const steps = [
    { text: 'Set up', status: 'completed' as const },
    { text: 'Run', status: 'inProgress' as const },
  ]

  it('스냅샷이 갈아끼워지고 턴이 끝나면 사라진다 — 남으면 끝난 턴의 계획이 거짓말한다', () => {
    const working = replay([ev({ type: 'state_change', state: 'working' })])
    const p1 = applyEvent(working, ev({ type: 'plan_update', steps: [steps[0]!] }), NOW)
    expect(p1.plan).toEqual([steps[0]])
    const p2 = applyEvent(p1, ev({ type: 'plan_update', steps }), NOW)
    expect(p2.plan).toEqual(steps) // 델타 합성이 아니라 교체다
    const done = applyEvent(p2, ev({ type: 'turn_complete' }), NOW)
    expect(done.plan).toBeNull()
  })

  it('working 동안의 다른 이벤트에는 살아남는다', () => {
    const working = replay([ev({ type: 'state_change', state: 'working' })])
    const p = applyEvent(working, ev({ type: 'plan_update', steps }), NOW)
    const after = applyEvent(p, ev({ type: 'message_delta', role: 'assistant', text: '진행' }), NOW)
    expect(after.plan).toEqual(steps)
  })
})
