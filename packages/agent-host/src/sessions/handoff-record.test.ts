import { describe, expect, it } from 'vitest'
import type { StoredMessage } from '@cc/protocol'
import { buildHandoffRecord, RECORD_CAP } from './handoff-record.js'

/**
 * The handoff record builder (#78 → #102) — a deterministic builder with no summarizer.
 *
 * The contract kept here is **the file's contract**: volume is reduced by collapsing tool rows,
 * most recent first, and the cap is made from a declared boundary rather than uniform
 * degradation. Nothing inside an included entry is cut — a half-cut entry would pretend to be
 * intact, but a span dropped entirely is announced by the first line.
 */

const row = (
  seq: number,
  role: StoredMessage['role'],
  kind: StoredMessage['kind'],
  payload: unknown,
): StoredMessage => ({ sessionId: 's', seq, role, kind, payload, ts: seq })

const base = { name: '메아', tool: 'codex', summary: null, pivotSeq: null }

/** One tool-call pair (call + result) */
const call = (seq: number, tool: string, path: string, body: string): StoredMessage[] => [
  row(seq, 'system', 'tool_call', { callId: `c${seq}`, summary: { tool, title: path, paths: [path] } }),
  row(seq + 1, 'system', 'tool_result', { callId: `c${seq}`, ok: true, summary: body }),
]

describe('the handoff record builder (#102)', () => {
  it('the header speaks about the file itself — from whom to whom, how far, which files', () => {
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
    // The file declares for itself how far it reaches — the reader must be able to tell whether it was cut
    expect(head[1]).toContain('covers seq 1–4 of 4')
    expect(head[1]).toContain('2.0 MB cap')
    // Touched files are lifted into the header — they have the highest value per byte, and computing them is free
    expect(head[2]).toBe('touched: packages/ui/src/api.ts')
    expect(text).toContain('[user] 포트는 4317로 하자')
    expect(text).toContain('[assistant] 4317로 잡았습니다')
    // The instruction to match the conversation's language — if a handoff switched languages, that would be the user switching languages
    expect(text).toContain('Match the language')
  })

  it('tool traffic is collapsed into three tiers, most recent first — verbatim / one line / counted into one block', () => {
    const rows: StoredMessage[] = []
    for (let i = 1; i <= 1_100; i++) {
      rows.push(...call(i * 2 - 1, i % 2 ? 'Read' : 'Edit', `file-${i}.ts`, `body-${i}`))
    }
    const text = buildHandoffRecord({ ...base, rows })

    // Tier 1 — the most recent 40 carry their result body verbatim (a range trustworthy enough not to need re-running)
    expect(text).toContain('body-1100')
    // Tier 2 — before that, only a one-line trace: what was done to which file, and whether it succeeded
    expect(text).toContain('Edit file-1050.ts (ok)')
    expect(text).not.toContain('body-1050')
    // Tier 3 — the oldest group is collapsed into a count and its paths
    expect(text).toMatch(/60 earlier tool calls \(Edit ×30, Read ×30\)/)
    expect(text).not.toContain('file-10.ts (ok)')
    expect(text).not.toContain('body-10\n')
  })

  it('the cap fills from the most recent, and nothing inside an included entry is cut', () => {
    const rows: StoredMessage[] = []
    for (let i = 1; i <= 200; i++) {
      rows.push(row(i, i % 2 ? 'user' : 'assistant', 'text', { text: `메시지 ${i} ` + '내용'.repeat(300) }))
    }
    const text = buildHandoffRecord({ ...base, rows, cap: 60_000 })

    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(60_000)
    // The most recent material survives **whole** — the old demotion to a first-few-characters stub is gone
    expect(text).toContain(`[assistant] 메시지 200 ` + '내용'.repeat(300))
    // Old material is dropped entirely, and that fact is stated in the header
    expect(text).not.toContain('메시지 1 ')
    expect(text).toMatch(/covers seq \d+–200 of 200/)
    expect(text).toContain("earlier material stays in the app's records")
  })

  it('the default cap is 2MB, and an ordinary session never touches the cap', () => {
    const rows: StoredMessage[] = []
    for (let i = 1; i <= 500; i++) rows.push(row(i, 'assistant', 'text', { text: `줄 ${i}` }))
    const text = buildHandoffRecord({ ...base, rows })

    expect(RECORD_CAP).toBe(2_000_000)
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(RECORD_CAP)
    expect(text).toContain('[assistant] 줄 1')
    expect(text).toContain('covers seq 1–500 of 500')
  })

  it('if there is a pivot, starts from there and places the tool\'s summary above it', () => {
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
    // The summary stands in for that span — carrying the same content again verbatim would only bulk up the file
    expect(text).not.toContain('옛날 이야기')
    expect(text).toContain("earlier material stays in the app's records")
  })

  /*
   * Measured: codex sessions have **zero** compaction markers in our store (compaction happens
   * inside its own rollout file). A rule that assumes a pivot only holds for claude, so a record
   * must still be built without one — whether or not there is a summary.
   */
  it('a record is still built with no pivot — with only a summary, or with nothing at all', () => {
    const rows = [row(1, 'user', 'text', { text: '첫 질문' }), row(2, 'assistant', 'text', { text: '첫 답' })]

    const withSummary = buildHandoffRecord({ ...base, summary: '롤아웃 요약', pivotSeq: null, rows })
    expect(withSummary).toContain('롤아웃 요약')
    // Nothing is dropped, since where it would have been folded is unknown
    expect(withSummary).toContain('[user] 첫 질문')
    expect(withSummary).toContain('covers seq 1–2 of 2')

    // Having no summary is not a failure — only the section is missing
    const bare = buildHandoffRecord({ ...base, rows })
    expect(bare).not.toContain("The tool's last compaction summary")
    expect(bare).toContain('[assistant] 첫 답')
  })

  it('reasoning, approvals and markers are dropped, since they are not for a successor to read', () => {
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
