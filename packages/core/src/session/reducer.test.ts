import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
import { applyEvent, archive, detectFileConflicts, initialSession, markRead, rename } from './reducer.js'

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

describe('세션 이름 (FR-18)', () => {
  it('자동 이름은 session_title로 갱신된다', () => {
    const s = applyEvent(s0(), ev({ type: 'session_title', title: 'auth 리팩터링' }), NOW)
    expect(s.name).toBe('auth 리팩터링')
  })

  it('수동 변경 후에는 자동 갱신이 멈춘다', () => {
    const s = applyEvent(rename(s0(), '내가 정한 이름'), ev({ type: 'session_title', title: '자동' }), NOW)
    expect(s.name).toBe('내가 정한 이름')
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
})

describe('읽음·아카이브', () => {
  it('읽음 위치는 뒤로 가지 않는다', () => {
    expect(markRead(markRead(s0(), 5), 2).lastReadSeq).toBe(5)
  })

  it('아카이브하면 대기에서 빠지고 pending이 정리된다', () => {
    const s = archive(replay(TURN.slice(0, 3)))
    expect(s.archived).toBe(true)
    expect(s.state).toBe('idle')
    expect(s.pendingApproval).toBeNull()
  })
})

describe('파일 충돌 감지 (FR-2 데이터 손실)', () => {
  it('두 세션이 같은 파일을 만지면 감지한다', () => {
    const a = applyEvent(initialSession({ id: 'a', projectId: 'p1', name: 'a' }), ev({ type: 'files_touched', paths: ['src/x.ts', 'src/a.ts'] }), NOW)
    const b = applyEvent(initialSession({ id: 'b', projectId: 'p1', name: 'b' }), { ...ev({ type: 'files_touched', paths: ['src/x.ts'] }), sessionId: 'b' } as NormalizedEvent, NOW)
    expect(detectFileConflicts([a, b])).toEqual([{ path: 'src/x.ts', sessionIds: ['a', 'b'] }])
  })

  it('아카이브된 세션은 충돌로 치지 않는다', () => {
    const a = applyEvent(initialSession({ id: 'a', projectId: 'p1', name: 'a' }), ev({ type: 'files_touched', paths: ['x'] }), NOW)
    const b = archive(applyEvent(initialSession({ id: 'b', projectId: 'p1', name: 'b' }), ev({ type: 'files_touched', paths: ['x'] }), NOW))
    expect(detectFileConflicts([a, b])).toEqual([])
  })
})
