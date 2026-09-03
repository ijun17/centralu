import { describe, expect, it } from 'vitest'
import type { StoredMessage } from '@cc/protocol'
import { buildHandoffRecord, RECORD_BUDGET } from './handoff-record.js'

/**
 * 죽은-에이전트 인수인계 기록 (#78) — 요약자 없는 결정론적 빌더.
 * 여기서 지키는 계약: 툴은 한 줄 흔적, 예산은 불변량, 탈락은 유실이 아니라 문장이 된다.
 */

const row = (
  seq: number,
  role: StoredMessage['role'],
  kind: StoredMessage['kind'],
  payload: unknown,
): StoredMessage => ({ sessionId: 's', seq, role, kind, payload, ts: seq })

const base = { name: '메아', tool: 'codex', summary: null, pivotSeq: null }

describe('인수인계 기록 빌더 (#78)', () => {
  it('대화는 원문, 툴은 한 줄 흔적, 추론은 뺀다', () => {
    const text = buildHandoffRecord({
      ...base,
      rows: [
        row(1, 'user', 'text', { text: '포트는 4317로 하자' }),
        row(2, 'assistant', 'reasoning', { text: '내부 추론' }),
        row(3, 'assistant', 'text', { text: '4317로 잡았습니다' }),
        row(4, 'system', 'tool_call', { callId: 'c1', summary: { tool: 'Bash', title: 'pnpm test' } }),
        row(5, 'system', 'tool_result', { callId: 'c1', ok: true, summary: 'exit 0' }),
        row(6, 'system', 'tool_call', { callId: 'c2', summary: { tool: 'Bash', title: 'pnpm build' } }),
        row(7, 'system', 'tool_result', { callId: 'c2', ok: false, summary: 'exit 1' }),
      ],
    })

    expect(text).toContain('[user] 포트는 4317로 하자')
    expect(text).toContain('[assistant] 4317로 잡았습니다')
    // 툴 입출력은 부피·재현성·주입 때문에 한 줄만 — 본문은 싣지 않는다
    expect(text).toContain('[tool] Bash: pnpm test → ok')
    expect(text).toContain('[tool] Bash: pnpm build → failed')
    expect(text).not.toContain('exit 0')
    expect(text).not.toContain('내부 추론')
    // 언어 지시 — 인수인계 글이 대화의 언어를 따르게 하는 그 줄
    expect(text).toContain('Match the language')
  })

  it('요약이 있으면 피벗 이전은 요약이 대신하고, 몇 개가 빠졌는지 말한다', () => {
    const text = buildHandoffRecord({
      ...base,
      summary: '# 프로젝트와 목표\n' + 'MGH 스킬 이펙트 작업이다. '.repeat(20),
      pivotSeq: 3,
      rows: [
        row(1, 'user', 'text', { text: '옛날 이야기' }),
        row(2, 'assistant', 'text', { text: '옛날 답변' }),
        row(3, 'system', 'marker', { type: 'compaction', failed: false }),
        row(4, 'user', 'text', { text: '컴팩트 뒤의 질문' }),
      ],
    })

    expect(text).toContain("## The tool's last compaction summary")
    expect(text).toContain('MGH 스킬 이펙트')
    expect(text).toContain('## Conversation since then')
    expect(text).toContain('[user] 컴팩트 뒤의 질문')
    // 같은 내용을 원문으로 또 실으면 예산만 태운다 — 요약이 그 자리를 대신한다
    expect(text).not.toContain('옛날 이야기')
    expect(text).toContain("2 earlier messages not included here — they remain in the app's records")
  })

  it('요약이 없으면 피벗 이전도 싣되 assistant는 머리만 남긴다 — claude의 길', () => {
    const long = '가'.repeat(2_000)
    const text = buildHandoffRecord({
      ...base,
      pivotSeq: 2,
      rows: [
        row(1, 'assistant', 'text', { text: long }),
        row(2, 'system', 'marker', { type: 'compaction', failed: false }),
        row(3, 'assistant', 'text', { text: long }),
      ],
    })

    // 피벗 앞: 전임자의 컨텍스트에서도 접혀 있던 부분 — 500자 머리 + 말줄임
    expect(text).toContain('가'.repeat(488) + '…')
    // 피벗 뒤: 원문 그대로
    expect(text).toContain('[assistant] ' + long)
  })

  it('예산이 불변량이다 — 90%짜리 이상치도 기록은 예산 안이고, 탈락은 문장이 된다', () => {
    const rows: StoredMessage[] = []
    for (let i = 1; i <= 200; i++) {
      rows.push(row(i, i % 2 ? 'user' : 'assistant', 'text', { text: `메시지 ${i} ` + '내용'.repeat(1_000) }))
    }
    const text = buildHandoffRecord({ ...base, rows })

    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(RECORD_BUDGET)
    // 최근 것은 살아남고 오래된 것부터 탈락한다
    expect(text).toContain('메시지 200')
    expect(text).not.toContain('메시지 1 ')
    expect(text).toMatch(/\d+ earlier messages not included here/)
  })

  it('요약은 불가침이다 — 본문이 넘쳐도 요약이 아니라 대화가 잘린다', () => {
    const summary = '요약 본문 '.repeat(3_000) // ~30KB
    const rows: StoredMessage[] = []
    for (let i = 10; i < 210; i++) {
      rows.push(row(i, 'assistant', 'text', { text: `본문 ${i} ` + '긴내용'.repeat(800) }))
    }
    const text = buildHandoffRecord({ ...base, summary, pivotSeq: 5, rows })

    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(RECORD_BUDGET)
    expect(text).not.toContain('[summary truncated to fit]')
    expect(text).toContain('요약 본문')
    expect(text).toContain('본문 209') // 최근은 남는다
  })
})
