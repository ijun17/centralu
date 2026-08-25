/**
 * 계약 테스트 (T3-2): 실 SDK 없이, 스파이크에서 관찰한 실제 메시지 형태를 픽스처로 검증한다.
 * SDK 형식이 바뀌면 여기가 먼저 깨진다.
 */
import { describe, expect, it } from 'vitest'
import { approvalDetail, normalizeMessage, toolSummary } from './normalize.js'

const SID = 's1'
const n = (msg: unknown) => normalizeMessage(msg, SID)

describe('스트리밍 델타', () => {
  it('stream_event content_block_delta → message_delta', () => {
    const out = n({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '안녕' } },
    })
    expect(out).toEqual([{ type: 'message_delta', sessionId: SID, role: 'assistant', text: '안녕' }])
  })

  it('텍스트가 아닌 델타는 무시한다', () => {
    expect(n({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta' } } })).toEqual([])
  })
})

/*
 * 델타 없이 오는 본문 (도그푸딩: "클코 사용량 스킬 메시지로 안되는데?").
 *
 * /usage처럼 CLI가 로컬에서 합성하는 답은 stream_event가 0개고 통짜 assistant
 * 메시지 하나다 (실측 — 델타 0 · 본문 1,046자). 본문을 델타로만 그리면 명령은
 * 실행됐는데 답이 화면에 영영 안 나타난다. 반대로 스트리밍된 턴에서 또 내면
 * 같은 글이 두 번 붙는다 — textStreamed 플래그가 그 갈림길이다.
 */
describe('델타 없이 온 assistant 본문', () => {
  const assistant = {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: '사용량: 18%' }] },
  }

  it('델타가 없었으면 통짜 본문을 message_delta로 낸다 — /usage의 답이 이 길로 온다', () => {
    const events = normalizeMessage(assistant, SID, { textStreamed: false })
    expect(events).toContainEqual({ type: 'message_delta', sessionId: SID, role: 'assistant', text: '사용량: 18%' })
  })

  it('델타로 이미 나간 본문은 또 내지 않는다 — 두 번 붙으면 그게 새 버그다', () => {
    const events = normalizeMessage(assistant, SID, { textStreamed: true })
    expect(events.filter((e) => e.type === 'message_delta')).toEqual([])
  })

  it('로컬 명령 출력(system/local_command_output)도 본문이다 — 같은 부류의 일반 채널', () => {
    const events = normalizeMessage(
      { type: 'system', subtype: 'local_command_output', content: '명령 출력 내용' },
      SID,
    )
    expect(events).toContainEqual({ type: 'message_delta', sessionId: SID, role: 'assistant', text: '명령 출력 내용' })
  })
})

describe('도구 호출 (스파이크 실제 형태)', () => {
  it('Bash tool_use → tool_call (명령 전문이 title)', () => {
    const out = n({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm run build' } }] },
    })
    expect(out[0]).toMatchObject({ type: 'tool_call', callId: 'tu1', summary: { tool: 'Bash', title: 'npm run build', readOnly: false } })
  })

  it('Write tool_use → tool_call + files_touched (충돌 감지용)', () => {
    const out = n({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tu2', name: 'Write', input: { file_path: '/tmp/hello.txt', content: 'hi' } }] },
    })
    expect(out.map((e) => e.type)).toEqual(['tool_call', 'files_touched'])
    expect(out[1]).toMatchObject({ type: 'files_touched', paths: ['/tmp/hello.txt'] })
  })

  it('조회성 도구는 readOnly로 표시된다 (카드 접힘 정책)', () => {
    expect(toolSummary('Read', { file_path: '/a.ts' }).readOnly).toBe(true)
    expect(toolSummary('Bash', { command: 'ls' }).readOnly).toBe(false)
  })

  it('tool_result → ok 판정', () => {
    const out = n({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'M0_SPIKE_OK' }] } })
    expect(out[0]).toMatchObject({ type: 'tool_result', callId: 'tu1', ok: true, summary: 'M0_SPIKE_OK' })
    const err = n({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'nope', is_error: true }] } })
    expect(err[0]).toMatchObject({ ok: false })
  })
})

describe('승인 요청 정규화 (배너 판정의 입력)', () => {
  it('Bash → command (배너 제자리 승인 가능)', () => {
    expect(approvalDetail('Bash', { command: 'npm test' }, '/p')).toEqual({ kind: 'command', command: 'npm test', cwd: '/p' })
  })

  it('Write/Edit → file_edit (diff 확인 필요)', () => {
    const d = approvalDetail('Edit', { file_path: '/a.ts', new_string: 'const a = 1' }, '/p')
    expect(d).toMatchObject({ kind: 'file_edit', path: '/a.ts', diffPreview: 'const a = 1', multi: false })
  })

  it('그 외 → other', () => {
    expect(approvalDetail('WebFetch', { url: 'http://x' }, '/p').kind).toBe('other')
  })
})

describe('한도 (M0 발견: rate_limit_event)', () => {
  it('allowed면 이벤트 없음', () => {
    expect(n({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1786750200 } })).toEqual([])
  })

  it('차단이면 limit_reached + 해제 시각 ISO 변환', () => {
    const out = n({ type: 'rate_limit_event', rate_limit_info: { status: 'blocked', resetsAt: 1786750200, rateLimitType: 'five_hour' } })
    expect(out[0]).toMatchObject({ type: 'limit_reached', resumeAt: new Date(1786750200 * 1000).toISOString(), windowMins: 300 })
  })
})

describe('result 메시지 (usage·컨텍스트·완료)', () => {
  const RESULT = {
    type: 'result',
    subtype: 'success',
    total_cost_usd: 0.0078,
    modelUsage: {
      'claude-haiku-4-5-20251001': {
        inputTokens: 18, outputTokens: 186, cacheReadInputTokens: 54830,
        cacheCreationInputTokens: 697, contextWindow: 200000,
      },
    },
  }

  it('modelUsage로 컨텍스트를 계산하지 않는다 (누적값이라 창을 넘어선다)', () => {
    /*
     * modelUsage는 세션 누적이다. 캐시 재읽기가 매 턴 더해지므로
     * 이걸 더해 쓰면 턴이 쌓일수록 비율이 폭주한다 — 실측 "컨텍스트 533%".
     * 지금 창의 점유는 SDK의 getContextUsage()가 알고, 어댑터가 그걸 물어서 낸다.
     */
    expect(n(RESULT).find((e) => e.type === 'context_update')).toBeUndefined()
  })

  it('usage와 비용을 싣는다', () => {
    const u = n(RESULT).find((e) => e.type === 'usage_update')
    expect(u).toMatchObject({ tokens: { outputTokens: 186, costUsd: 0.0078 } })
  })

  it('성공이면 turn_complete로 끝난다', () => {
    expect(n(RESULT).at(-1)).toEqual({ type: 'turn_complete', sessionId: SID })
  })

  it('실패면 error를 낸다', () => {
    const out = n({ ...RESULT, subtype: 'error_max_turns', is_error: true, result: '최대 턴 초과' })
    expect(out.at(-1)).toMatchObject({ type: 'error', error: { code: 'internal', message: '최대 턴 초과' } })
  })
})

/*
 * 픽스처는 지어낸 게 아니라 프로브로 관찰한 실제 메시지다.
 * 관찰한 순서: status:'compacting' → (39.1초) → status:null(+compact_result) → compact_boundary
 */
describe('압축 — 무엇을 하는 중인지 말한다', () => {
  it('압축이 시작되면 activity로 알린다 (응답 대기와 구분되어야 한다)', () => {
    expect(n({ type: 'system', subtype: 'status', status: 'compacting' })).toEqual([
      { type: 'activity', sessionId: SID, activity: 'compacting' },
    ])
  })

  it('평범한 요청 중은 activity가 없다', () => {
    expect(n({ type: 'system', subtype: 'status', status: 'requesting' })).toEqual([
      { type: 'activity', sessionId: SID, activity: null },
    ])
  })

  it('압축 실패를 삼키지 않는다 — 이유까지 남긴다', () => {
    const out = n({
      type: 'system',
      subtype: 'status',
      status: null,
      compact_result: 'failed',
      compact_error: 'Not enough messages to compact.',
    })
    expect(out).toEqual([
      { type: 'activity', sessionId: SID, activity: null },
      { type: 'compaction', sessionId: SID, failed: true, reason: 'Not enough messages to compact.' },
    ])
  })

  it('compact_boundary → 마커 (Claude에는 지금까지 이 마커가 없었다)', () => {
    const out = n({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'manual', pre_tokens: 25485, post_tokens: 3686, duration_ms: 39099 },
    })
    expect(out).toEqual([{ type: 'compaction', sessionId: SID, failed: false, before: 25485, after: 3686 }])
  })
})

describe('알 수 없는 메시지는 조용히 무시한다', () => {
  it.each([
    { type: 'system', subtype: 'init' },
    { type: 'system', subtype: 'thinking_tokens' },
    { type: 'future_message_type' },
  ])('%o', (msg) => {
    expect(n(msg)).toEqual([])
  })
})
