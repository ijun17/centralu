import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findRolloutPath, lastCompactSummary } from './rollout.js'

/**
 * Extracting a dead codex process's compact summary (#78) — pinning the rollout format as
 * measured (2026-09-04). compacted.payload.message is empty, and replacement_history's first user
 * message is the summary text. The file is found by its file name (thread id) — zero dependency on the binary.
 */

const SUMMARY = '# 1. Project and Goals\n\n' + 'MGH skill effect work status and rules. '.repeat(20)

const compactedLine = (message: string, historyText: string | null) =>
  JSON.stringify({
    timestamp: '2026-09-03T06:09:56.803Z',
    type: 'compacted',
    payload: {
      message,
      replacement_history: historyText
        ? [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: historyText }] }]
        : [],
      window_number: 1,
    },
  })

describe("codex rollout's compact summary (#78)", () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-rollout-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const put = (threadId: string, lines: string[], sub = '2026/09/03') => {
    const d = join(dir, sub)
    mkdirSync(d, { recursive: true })
    const p = join(d, `rollout-2026-09-03T14-44-48-${threadId}.jsonl`)
    writeFileSync(p, lines.join('\n') + '\n')
    return p
  }

  it('finds the file by the thread id in its file name — with no codex binary involved', async () => {
    const p = put('aaaa-bbbb', [JSON.stringify({ type: 'session_meta' })])
    put('cccc-dddd', [JSON.stringify({ type: 'session_meta' })])

    expect(await findRolloutPath('aaaa-bbbb', dir)).toBe(p)
    expect(await findRolloutPath('missing-thread', dir)).toBeNull()
  })

  it("gives the last compacted item's summary — if message is empty, replacement_history's first user message is the text", async () => {
    put('t1', [
      JSON.stringify({ type: 'session_meta' }),
      compactedLine('', 'first summary. ' + SUMMARY),
      JSON.stringify({ type: 'response_item' }),
      compactedLine('', 'last summary. ' + SUMMARY),
    ])

    const s = await lastCompactSummary('t1', dir)
    expect(s).toContain('last summary')
    expect(s).not.toContain('first summary')
  })

  it('a short fragment, a broken line, or no compaction at all — all give null, a failure lying down quietly while the builder falls back', async () => {
    // Under 200 characters is not a summary, but a preserved ordinary message
    put('t-short', [compactedLine('', 'short')])
    expect(await lastCompactSummary('t-short', dir)).toBeNull()

    // The last line the tool left half-written — broken JSON is skipped and the intact one before it is used
    put('t-broken', [compactedLine('', 'intact summary. ' + SUMMARY), '{"type":"compacted","payl'])
    expect(await lastCompactSummary('t-broken', dir)).toContain('intact summary')

    put('t-none', [JSON.stringify({ type: 'session_meta' })])
    expect(await lastCompactSummary('t-none', dir)).toBeNull()

    expect(await lastCompactSummary('t-missing', dir)).toBeNull()
  })
})
