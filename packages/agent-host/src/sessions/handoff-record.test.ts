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

const base = { name: 'Mea', tool: 'codex', summary: null, pivotSeq: null }

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
        row(1, 'user', 'text', { text: 'use port 4317' }),
        ...call(2, 'Edit', 'packages/ui/src/api.ts', 'applied'),
        row(4, 'assistant', 'text', { text: 'set it to 4317' }),
      ],
    })

    const head = text.split('\n')
    expect(head[0]).toBe('# Handoff · Mea · codex → claude')
    // The file declares for itself how far it reaches — the reader must be able to tell whether it was cut
    expect(head[1]).toContain('covers seq 1–4 of 4')
    expect(head[1]).toContain('2.0 MB cap')
    // Touched files are lifted into the header — they have the highest value per byte, and computing them is free
    expect(head[2]).toBe('touched: packages/ui/src/api.ts')
    expect(text).toContain('[user] use port 4317')
    expect(text).toContain('[assistant] set it to 4317')
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
      rows.push(row(i, i % 2 ? 'user' : 'assistant', 'text', { text: `message ${i} ` + 'content'.repeat(300) }))
    }
    const text = buildHandoffRecord({ ...base, rows, cap: 60_000 })

    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(60_000)
    // The most recent material survives **whole** — the old demotion to a first-few-characters stub is gone
    expect(text).toContain(`[assistant] message 200 ` + 'content'.repeat(300))
    // Old material is dropped entirely, and that fact is stated in the header
    expect(text).not.toContain('message 1 ')
    expect(text).toMatch(/covers seq \d+–200 of 200/)
    expect(text).toContain("earlier material stays in the app's records")
  })

  it('filling the cap measures each entry once, not once per dropped entry', () => {
    // A long text-only transcript runs the cap loop once per row it drops. Re-measuring every
    // kept row on each pass is quadratic: 200k rows held the host's main thread for minutes.
    // Counting the measurements keeps this off the wall clock.
    const rows: StoredMessage[] = []
    for (let i = 1; i <= 5_000; i++) rows.push(row(i, 'assistant', 'text', { text: `line ${i} ` + 'x'.repeat(100) }))
    const original = Buffer.byteLength
    let measured = 0
    Buffer.byteLength = ((...args: Parameters<typeof Buffer.byteLength>) => {
      if (++measured > 10 * rows.length) throw new Error(`measured ${measured} times for ${rows.length} rows`)
      return original(...args)
    }) as typeof Buffer.byteLength
    let text: string
    try {
      text = buildHandoffRecord({ ...base, rows, cap: 20_000 })
    } finally {
      Buffer.byteLength = original
    }

    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(20_000)
    expect(text).toContain('[assistant] line 5000 ')
    expect(text).not.toContain('[assistant] line 1 ')
    expect(text).toMatch(/covers seq [\d,]+–5,000 of 5,000/)
  })

  it('the default cap is 2MB, and an ordinary session never touches the cap', () => {
    const rows: StoredMessage[] = []
    for (let i = 1; i <= 500; i++) rows.push(row(i, 'assistant', 'text', { text: `line ${i}` }))
    const text = buildHandoffRecord({ ...base, rows })

    expect(RECORD_CAP).toBe(2_000_000)
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(RECORD_CAP)
    expect(text).toContain('[assistant] line 1')
    expect(text).toContain('covers seq 1–500 of 500')
  })

  it('if there is a pivot, starts from there and places the tool\'s summary above it', () => {
    const text = buildHandoffRecord({
      ...base,
      summary: '# Project and goal\n' + 'This is the MGH skill effect work. '.repeat(20),
      pivotSeq: 3,
      rows: [
        row(1, 'user', 'text', { text: 'an old story' }),
        row(2, 'assistant', 'text', { text: 'an old answer' }),
        row(3, 'system', 'marker', { type: 'compaction', failed: false }),
        row(4, 'user', 'text', { text: 'the question after compaction' }),
      ],
    })

    expect(text).toContain("## The tool's last compaction summary")
    expect(text).toContain('MGH skill effect')
    expect(text.indexOf('MGH skill effect')).toBeLessThan(text.indexOf('── verbatim from here ──'))
    expect(text).toContain('[user] the question after compaction')
    // The summary stands in for that span — carrying the same content again verbatim would only bulk up the file
    expect(text).not.toContain('an old story')
    expect(text).toContain("earlier material stays in the app's records")
  })

  /*
   * Measured: codex sessions have **zero** compaction markers in our store (compaction happens
   * inside its own rollout file). A rule that assumes a pivot only holds for claude, so a record
   * must still be built without one — whether or not there is a summary.
   */
  it('a record is still built with no pivot — with only a summary, or with nothing at all', () => {
    const rows = [row(1, 'user', 'text', { text: 'First question' }), row(2, 'assistant', 'text', { text: 'First answer' })]

    const withSummary = buildHandoffRecord({ ...base, summary: 'rollout summary', pivotSeq: null, rows })
    expect(withSummary).toContain('rollout summary')
    // Nothing is dropped, since where it would have been folded is unknown
    expect(withSummary).toContain('[user] First question')
    expect(withSummary).toContain('covers seq 1–2 of 2')

    // Having no summary is not a failure — only the section is missing
    const bare = buildHandoffRecord({ ...base, rows })
    expect(bare).not.toContain("The tool's last compaction summary")
    expect(bare).toContain('[assistant] First answer')
  })

  it('reasoning, approvals and markers are dropped, since they are not for a successor to read', () => {
    const text = buildHandoffRecord({
      ...base,
      rows: [
        row(1, 'assistant', 'reasoning', { text: 'internal reasoning' }),
        row(2, 'system', 'approval', { requestId: 'r1', decision: 'allow' }),
        row(3, 'assistant', 'text', { text: 'an answer' }),
      ],
    })

    expect(text).not.toContain('internal reasoning')
    expect(text).toContain('[assistant] an answer')
  })
})
