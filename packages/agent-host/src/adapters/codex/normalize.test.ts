import { describe, expect, it } from 'vitest'
import { approvalDetailFrom, normalizeNotification, toCodexDecision } from './normalize.js'

/**
 * A-2 계약 테스트. 픽스처는 M0 스파이크에서 **실제로 녹화한** 프로토콜 출력을 줄인 것이다
 * (docs/spikes/m0-findings.md). 실 프로세스 없이 돌아야 CI에서 쓸 수 있다.
 */

const S = 'sess-1'
const n = (method: string, params?: unknown) => normalizeNotification(S, { method, params })

describe('스트리밍·도구 호출', () => {
  it('agentMessage delta → message_delta', () => {
    expect(n('item/agentMessage/delta', { delta: '안녕' })).toEqual([
      { type: 'message_delta', sessionId: S, role: 'assistant', text: '안녕' },
    ])
  })

  it('commandExecution 시작 → tool_call (명령 전문이 제목)', () => {
    const out = n('item/started', {
      item: { type: 'commandExecution', id: 'exec-1', command: "/bin/zsh -lc 'npm test'", cwd: '/tmp' },
    })
    expect(out).toEqual([
      { type: 'tool_call', sessionId: S, callId: 'exec-1', summary: { tool: 'Bash', title: "/bin/zsh -lc 'npm test'", readOnly: false, paths: [] } },
    ])
  })

  it('조회성 명령은 접힘 힌트를 준다', () => {
    const out = n('item/started', { item: { type: 'commandExecution', id: 'e', command: "/bin/zsh -lc 'ls -la'" } })
    expect(out[0]).toMatchObject({ summary: { readOnly: true } })
  })

  it('fileChange 완료 → tool_result + files_touched (충돌 감지용)', () => {
    const out = n('item/completed', {
      item: { type: 'fileChange', id: 'fc-1', status: 'completed', changes: [{ path: 'src/a.ts', diff: '+1' }] },
    })
    expect(out.map((e) => e.type)).toEqual(['tool_result', 'files_touched'])
    expect(out[1]).toMatchObject({ paths: ['src/a.ts'] })
  })

  it('실패한 도구는 ok=false', () => {
    const out = n('item/completed', { item: { type: 'commandExecution', id: 'e', status: 'failed', output: '오류' } })
    expect(out[0]).toMatchObject({ type: 'tool_result', ok: false })
  })

  it('사용자 메시지·추론 항목은 버린다 (대화창 소음)', () => {
    expect(n('item/started', { item: { type: 'userMessage', id: 'u' } })).toEqual([])
    expect(n('item/completed', { item: { type: 'reasoning', id: 'r' } })).toEqual([])
  })
})

describe('상태·계기판', () => {
  it('turn/completed → turn_complete', () => {
    expect(n('turn/completed', {})).toEqual([{ type: 'turn_complete', sessionId: S }])
  })

  it('tokenUsage → usage_update (+ 윈도우가 있으면 context_update)', () => {
    const out = n('thread/tokenUsage/updated', {
      tokenUsage: { total: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80, totalTokens: 120 } },
      contextWindow: 1_000_000,
    })
    expect(out[0]).toMatchObject({ type: 'usage_update', tokens: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80 } })
    expect(out[1]).toMatchObject({ type: 'context_update', used: 120, window: 1_000_000, exactness: 'exact' })
  })

  /*
   * 사용량 갱신 ≠ 한도 도달.
   *
   * 이 구분이 없어서 코덱스 세션은 첫 도구 호출 직후 곧바로 'limited'가 됐다 —
   * 실측에서 27%인데도 그랬다. 아이콘 회전이 멈추고 흐려지고 없는 딱지가 붙었다.
   * 도구가 `rateLimitReachedType`으로 직접 알려주는데 우리가 안 봤다.
   */
  it('아직 안 걸렸으면 아무 일도 없다 — 사용량이 올라가는 것은 정상이다', () => {
    expect(
      n('account/rateLimits/updated', {
        rateLimits: {
          primary: { usedPercent: 27, windowDurationMins: 10080, resetsAt: 1787198872 },
          rateLimitReachedType: null,
        },
      }),
    ).toEqual([])
  })

  it('걸렸을 때만 limit_reached (주간 윈도우·해제 시각 포함)', () => {
    const out = n('account/rateLimits/updated', {
      rateLimits: {
        primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1787198872 },
        rateLimitReachedType: 'rate_limit_reached',
      },
    })
    expect(out[0]).toMatchObject({ type: 'limit_reached', usedPercent: 100, windowMins: 10080 })
    expect((out[0] as { resumeAt?: string }).resumeAt).toMatch(/^\d{4}-/)
  })

  it('지출 한도도 한도다', () => {
    const out = n('account/rateLimits/updated', {
      rateLimits: { primary: { usedPercent: 40 }, spendControlReached: true },
    })
    expect(out[0]).toMatchObject({ type: 'limit_reached' })
  })

  it('thread/name/updated → session_title (FR-18 자동 이름)', () => {
    expect(n('thread/name/updated', { name: 'auth 리팩터링' })).toEqual([
      { type: 'session_title', sessionId: S, title: 'auth 리팩터링' },
    ])
  })

  /*
   * Codex는 압축을 ThreadItem으로 흘린다 (generated/v2/ThreadItem.ts: `contextCompaction`).
   * 걸러내지 않으면 itemSummary를 타고 **가짜 도구 호출 줄**이 대화에 생긴다.
   * 주의: 이 배선은 생성된 타입에서 추론한 것이고 실행으로 확인하지는 못했다 (Claude 쪽은 확인함).
   */
  it('압축 item은 도구 호출이 아니라 activity다', () => {
    expect(n('item/started', { item: { type: 'contextCompaction', id: 'i1' } })).toEqual([
      { type: 'activity', sessionId: S, activity: 'compacting' },
    ])
  })

  it('압축이 끝나면 activity를 지운다 (마커는 thread/compacted가 낸다 — 두 줄이 되면 안 된다)', () => {
    expect(n('item/completed', { item: { type: 'contextCompaction', id: 'i1' } })).toEqual([
      { type: 'activity', sessionId: S, activity: null },
    ])
  })

  it('thread/compacted → compaction 마커 (FR-14)', () => {
    expect(n('thread/compacted', {})).toEqual([{ type: 'compaction', sessionId: S, failed: false }])
  })

  it('모르는 알림은 조용히 버린다 (프로토콜이 늘어나도 안 깨진다)', () => {
    expect(n('thread/realtime/audioDelta', { blob: 'x' })).toEqual([])
    expect(n('완전히/새로운/메서드', {})).toEqual([])
  })
})

describe('승인 요청 변환 (배너 제자리 승인 판단의 근거)', () => {
  it('명령 승인 → kind=command (배너에서 바로 승인 가능한 형태)', () => {
    const d = approvalDetailFrom('item/commandExecution/requestApproval', {
      item: { command: 'npm run build', cwd: '/tmp/p' },
    })
    expect(d).toEqual({ kind: 'command', command: 'npm run build', cwd: '/tmp/p' })
  })

  it('파일 수정 승인 → kind=file_edit (diff를 봐야 하므로 "확인 필요"로 분기된다)', () => {
    const d = approvalDetailFrom('item/fileChange/requestApproval', {
      item: { changes: [{ path: 'a.ts', diff: '+x' }, { path: 'b.ts', diff: '-y' }] },
    })
    expect(d).toMatchObject({ kind: 'file_edit', path: 'a.ts', multi: true })
  })

  it('모르는 승인 종류는 other로 (판단을 사람에게 넘긴다)', () => {
    expect(approvalDetailFrom('item/unknown/requestApproval', { x: 1 })).toMatchObject({ kind: 'other' })
  })
})

describe('승인 결정 매핑 (M0에서 확인한 6종 중 우리가 쓰는 것)', () => {
  it('허용/거부/항상 허용', () => {
    expect(toCodexDecision('allow')).toBe('accept')
    expect(toCodexDecision('deny')).toBe('decline')
    // '항상 허용·세션'과 정확히 대응하는 값이 프로토콜에 있다
    expect(toCodexDecision('always')).toBe('acceptForSession')
  })
})
