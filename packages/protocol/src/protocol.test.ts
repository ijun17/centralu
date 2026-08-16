/**
 * 골든 테스트 (M1 플랜 T1-1). 여기 픽스처는 "이 버전이 파싱할 수 있어야 하는 메시지"의 고정 목록이다.
 * 스키마를 바꿀 때 이 파일이 깨지면 = 하위 호환 파괴. 필드 추가는 여기를 깨지 않아야 한다 (docs/protocol.md §4).
 */
import { describe, expect, it } from 'vitest'
import {
  NormalizedEvent,
  PROTOCOL_VERSION,
  parseClientFrame,
  parseEventLenient,
  parseServerFrame,
} from './index.js'

const GOLDEN_EVENTS_V1: unknown[] = [
  { type: 'message_delta', sessionId: 's1', role: 'assistant', text: '안녕' },
  { type: 'tool_call', sessionId: 's1', callId: 'c1', summary: { tool: 'Bash', title: 'npm test', readOnly: false, paths: [] } },
  { type: 'tool_result', sessionId: 's1', callId: 'c1', ok: true, summary: 'exit 0' },
  { type: 'approval_request', sessionId: 's1', requestId: 'r1', detail: { kind: 'command', command: 'npm run build', cwd: '/p' } },
  { type: 'approval_request', sessionId: 's1', requestId: 'r2', detail: { kind: 'file_edit', path: 'a.ts', diffPreview: '+x', multi: false } },
  { type: 'approval_request', sessionId: 's1', requestId: 'r3', detail: { kind: 'other', raw: '{}' } },
  { type: 'approval_resolved', sessionId: 's1', requestId: 'r1', decision: 'allow' },
  { type: 'turn_complete', sessionId: 's1' },
  { type: 'state_change', sessionId: 's1', state: 'waiting_input' },
  { type: 'usage_update', sessionId: 's1', tokens: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.01 } },
  { type: 'context_update', sessionId: 's1', used: 1000, window: 200000, exactness: 'exact' },
  { type: 'limit_reached', sessionId: 's1', resumeAt: '2026-08-15T14:30:00Z', usedPercent: 21, windowMins: 10080 },
  { type: 'session_title', sessionId: 's1', title: 'auth 리팩터링' },
  { type: 'files_touched', sessionId: 's1', paths: ['src/a.ts'] },
  { type: 'compaction', sessionId: 's1' },
  { type: 'history_synced', sessionId: 's1', added: 2 },
  { type: 'session_deleted', sessionId: 's1' },
  { type: 'error', sessionId: 's1', error: { code: 'adapter_crashed', message: '프로세스 종료', retryable: true } },
]

describe('golden: v1 이벤트 전종', () => {
  it.each(GOLDEN_EVENTS_V1.map((e) => [(e as { type: string }).type, e] as const))(
    '%s 파싱',
    (_type, raw) => {
      const parsed = NormalizedEvent.safeParse(raw)
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
    },
  )

  it('모든 이벤트 타입이 픽스처에 있다 (새 타입 추가 시 골든도 추가하도록 강제)', () => {
    const covered = new Set(GOLDEN_EVENTS_V1.map((e) => (e as { type: string }).type))
    const declared = NormalizedEvent.options.map((o) => o.shape.type.value as string)
    expect([...new Set(declared)].sort()).toEqual([...covered].sort())
  })
})

describe('전방 호환 (docs/protocol.md §4)', () => {
  it('모르는 이벤트 타입은 무시한다 (throw 아님)', () => {
    expect(parseEventLenient({ type: 'future_event_from_v2', sessionId: 's1' })).toBeNull()
  })

  it('알려진 이벤트에 모르는 필드가 붙어도 파싱된다', () => {
    const r = parseEventLenient({ type: 'turn_complete', sessionId: 's1', futureField: 123 })
    expect(r?.type).toBe('turn_complete')
  })

  it('필수 필드가 빠지면 거부한다', () => {
    expect(parseEventLenient({ type: 'message_delta', sessionId: 's1' })).toBeNull()
  })
})

describe('봉투', () => {
  it('hello / rpc 클라이언트 프레임', () => {
    expect(parseClientFrame({ kind: 'hello', token: 't', protocolVersion: PROTOCOL_VERSION }).success).toBe(true)
    expect(parseClientFrame({ kind: 'rpc', id: '1', method: 'agents.send', params: {} }).success).toBe(true)
    expect(parseClientFrame({ kind: 'nope' }).success).toBe(false)
  })

  it('hello_ok / event / res 서버 프레임', () => {
    expect(parseServerFrame({ kind: 'hello_ok', protocolVersion: 1, resyncRequired: false, currentSeq: 0 }).success).toBe(true)
    expect(parseServerFrame({ kind: 'event', seq: 1, event: GOLDEN_EVENTS_V1[0] }).success).toBe(true)
    expect(parseServerFrame({ kind: 'res', id: '1', ok: true, result: {} }).success).toBe(true)
    expect(
      parseServerFrame({ kind: 'res', id: '1', ok: false, error: { code: 'internal', message: 'x', retryable: false } })
        .success,
    ).toBe(true)
  })

  it('seq는 이벤트 푸시에 필수다 (재연결 복원의 근거)', () => {
    expect(parseServerFrame({ kind: 'event', event: GOLDEN_EVENTS_V1[0] }).success).toBe(false)
  })
})
