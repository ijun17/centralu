import { describe, expect, it } from 'vitest'
import type { StoredMessage } from '@cc/protocol'
import { buildHandoffRecord, RECORD_CAP } from './handoff-record.js'

/**
 * 인수인계 기록 빌더 (#78 → #102) — 요약자 없는 결정론적 빌더.
 *
 * 여기서 지키는 계약은 **파일의 계약**이다: 부피는 툴 행을 최근순으로 접어서 줄이고,
 * 상한은 균일한 열화가 아니라 선언된 경계로 만든다. 담긴 항목 안은 자르지 않는다 —
 * 반쯤 잘린 항목은 온전한 척하지만, 통째로 빠진 구간은 첫 줄이 말해 준다.
 */

const row = (
  seq: number,
  role: StoredMessage['role'],
  kind: StoredMessage['kind'],
  payload: unknown,
): StoredMessage => ({ sessionId: 's', seq, role, kind, payload, ts: seq })

const base = { name: '메아', tool: 'codex', summary: null, pivotSeq: null }

/** 툴 호출 한 쌍 (호출 + 결과) */
const call = (seq: number, tool: string, path: string, body: string): StoredMessage[] => [
  row(seq, 'system', 'tool_call', { callId: `c${seq}`, summary: { tool, title: path, paths: [path] } }),
  row(seq + 1, 'system', 'tool_result', { callId: `c${seq}`, ok: true, summary: body }),
]

describe('인수인계 기록 빌더 (#102)', () => {
  it('헤더가 파일 자신에 대해 말한다 — 누구에게서 누구에게로, 어디까지, 어느 파일들', () => {
    const text = buildHandoffRecord({
      ...base,
      toTool: 'claude',
      rows: [
        row(1, 'user', 'text', { text: '포트는 4317로 하자' }),
        ...call(2, 'Edit', 'packages/ui/src/api.ts', 'applied'),
        row(4, 'assistant', 'text', { text: '4317로 잡았습니다' }),
      ],
    })

    const head = text.split('\n')
    expect(head[0]).toBe('# Handoff · 메아 · codex → claude')
    // 어디까지 담았는지를 파일이 스스로 선언한다 — 잘렸는지 아닌지를 읽는 쪽이 알 수 있어야 한다
    expect(head[1]).toContain('covers seq 1–4 of 4')
    expect(head[1]).toContain('2.0 MB cap')
    // 손댄 파일은 헤더로 올린다 — 바이트당 값이 가장 높고, 뽑는 값은 공짜다
    expect(head[2]).toBe('touched: packages/ui/src/api.ts')
    expect(text).toContain('[user] 포트는 4317로 하자')
    expect(text).toContain('[assistant] 4317로 잡았습니다')
    // 대화의 언어를 따르라는 지시 — 인수인계가 언어를 갈아타면 사용자가 갈아탄 셈이 된다
    expect(text).toContain('Match the language')
  })

  it('툴 traffic은 최근순 3단으로 접힌다 — 원문 / 한 줄 / 세어서 한 덩어리', () => {
    const rows: StoredMessage[] = []
    for (let i = 1; i <= 1_100; i++) {
      rows.push(...call(i * 2 - 1, i % 2 ? 'Read' : 'Edit', `file-${i}.ts`, `body-${i}`))
    }
    const text = buildHandoffRecord({ ...base, rows })

    // 1단 — 최근 40개는 결과 본문까지 그대로 (다시 돌려보지 않고 믿을 만한 범위)
    expect(text).toContain('body-1100')
    // 2단 — 그 앞은 한 줄 흔적만: 무엇을 어느 파일에 했고 됐는가
    expect(text).toContain('Edit file-1050.ts (ok)')
    expect(text).not.toContain('body-1050')
    // 3단 — 가장 오래된 무리는 개수와 경로로 접힌다
    expect(text).toMatch(/60 earlier tool calls \(Edit ×30, Read ×30\)/)
    expect(text).not.toContain('file-10.ts (ok)')
    expect(text).not.toContain('body-10\n')
  })

  it('상한은 최근부터 채우고, 담긴 항목 안은 자르지 않는다', () => {
    const rows: StoredMessage[] = []
    for (let i = 1; i <= 200; i++) {
      rows.push(row(i, i % 2 ? 'user' : 'assistant', 'text', { text: `메시지 ${i} ` + '내용'.repeat(300) }))
    }
    const text = buildHandoffRecord({ ...base, rows, cap: 60_000 })

    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(60_000)
    // 최근 것은 **통째로** 남는다 — 머리만 남기는 강등은 없어졌다
    expect(text).toContain(`[assistant] 메시지 200 ` + '내용'.repeat(300))
    // 오래된 것은 통째로 빠지고, 그 사실이 헤더에 적힌다
    expect(text).not.toContain('메시지 1 ')
    expect(text).toMatch(/covers seq \d+–200 of 200/)
    expect(text).toContain("earlier material stays in the app's records")
  })

  it('기본 상한은 2MB이고, 평범한 세션은 상한을 건드리지 않는다', () => {
    const rows: StoredMessage[] = []
    for (let i = 1; i <= 500; i++) rows.push(row(i, 'assistant', 'text', { text: `줄 ${i}` }))
    const text = buildHandoffRecord({ ...base, rows })

    expect(RECORD_CAP).toBe(2_000_000)
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(RECORD_CAP)
    expect(text).toContain('[assistant] 줄 1')
    expect(text).toContain('covers seq 1–500 of 500')
  })

  it('피벗이 있으면 거기서 시작하고 도구의 요약을 그 위에 올린다', () => {
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
    expect(text.indexOf('MGH 스킬 이펙트')).toBeLessThan(text.indexOf('── verbatim from here ──'))
    expect(text).toContain('[user] 컴팩트 뒤의 질문')
    // 요약이 그 자리를 대신한다 — 같은 내용을 원문으로 또 실으면 파일만 두꺼워진다
    expect(text).not.toContain('옛날 이야기')
    expect(text).toContain("earlier material stays in the app's records")
  })

  /*
   * 실측: codex 세션에는 우리 저장소에 컴팩션 마커가 **하나도 없다** (컴팩션이 자기
   * 롤아웃 파일에서 일어난다). 피벗을 전제하는 규칙은 claude에서만 성립하므로,
   * 없어도 기록은 만들어져야 한다 — 요약이 있든 없든.
   */
  it('피벗이 없어도 기록은 만들어진다 — 요약만 있어도, 아무것도 없어도', () => {
    const rows = [row(1, 'user', 'text', { text: '첫 질문' }), row(2, 'assistant', 'text', { text: '첫 답' })]

    const withSummary = buildHandoffRecord({ ...base, summary: '롤아웃 요약', pivotSeq: null, rows })
    expect(withSummary).toContain('롤아웃 요약')
    // 어디서 접혔는지 모르므로 아무것도 버리지 않는다
    expect(withSummary).toContain('[user] 첫 질문')
    expect(withSummary).toContain('covers seq 1–2 of 2')

    // 요약이 없는 것은 실패가 아니다 — 섹션만 없다
    const bare = buildHandoffRecord({ ...base, rows })
    expect(bare).not.toContain("The tool's last compaction summary")
    expect(bare).toContain('[assistant] 첫 답')
  })

  it('추론·승인·마커는 후임자가 읽을 것이 아니라 빠진다', () => {
    const text = buildHandoffRecord({
      ...base,
      rows: [
        row(1, 'assistant', 'reasoning', { text: '내부 추론' }),
        row(2, 'system', 'approval', { requestId: 'r1', decision: 'allow' }),
        row(3, 'assistant', 'text', { text: '답변' }),
      ],
    })

    expect(text).not.toContain('내부 추론')
    expect(text).toContain('[assistant] 답변')
  })
})
