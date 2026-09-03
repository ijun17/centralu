import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findRolloutPath, lastCompactSummary } from './rollout.js'

/**
 * 죽은 codex의 컴팩트 요약 추출 (#78) — 롤아웃 포맷 실측(2026-09-04)의 고정.
 * compacted.payload.message는 비어 있고, replacement_history의 첫 user 메시지가
 * 요약 원문이다. 파일은 파일명(thread id)으로 찾는다 — 바이너리 의존 0.
 */

const SUMMARY = '# 1. 프로젝트와 목표\n\n' + 'MGH 스킬 이펙트 작업 상태와 규칙들. '.repeat(20)

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

describe('codex 롤아웃의 컴팩트 요약 (#78)', () => {
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

  it('파일은 파일명의 thread id로 찾는다 — codex 바이너리 없이', async () => {
    const p = put('aaaa-bbbb', [JSON.stringify({ type: 'session_meta' })])
    put('cccc-dddd', [JSON.stringify({ type: 'session_meta' })])

    expect(await findRolloutPath('aaaa-bbbb', dir)).toBe(p)
    expect(await findRolloutPath('없는-스레드', dir)).toBeNull()
  })

  it('마지막 compacted의 요약을 준다 — message가 비면 replacement_history의 첫 user 메시지가 원문이다', async () => {
    put('t1', [
      JSON.stringify({ type: 'session_meta' }),
      compactedLine('', '첫 번째 요약. ' + SUMMARY),
      JSON.stringify({ type: 'response_item' }),
      compactedLine('', '마지막 요약이다. ' + SUMMARY),
    ])

    const s = await lastCompactSummary('t1', dir)
    expect(s).toContain('마지막 요약이다')
    expect(s).not.toContain('첫 번째 요약')
  })

  it('짧은 조각·깨진 줄·컴팩트 없음은 전부 null — 실패는 조용히 눕고 빌더가 물러난다', async () => {
    // 200자 미만은 요약이 아니라 보존된 일반 메시지다
    put('t-short', [compactedLine('', '짧다')])
    expect(await lastCompactSummary('t-short', dir)).toBeNull()

    // 도구가 쓰다 만 마지막 줄 — 깨진 JSON은 건너뛰고 앞의 온전한 것을 쓴다
    put('t-broken', [compactedLine('', '온전한 요약. ' + SUMMARY), '{"type":"compacted","payl'])
    expect(await lastCompactSummary('t-broken', dir)).toContain('온전한 요약')

    put('t-none', [JSON.stringify({ type: 'session_meta' })])
    expect(await lastCompactSummary('t-none', dir)).toBeNull()

    expect(await lastCompactSummary('t-missing', dir)).toBeNull()
  })
})
