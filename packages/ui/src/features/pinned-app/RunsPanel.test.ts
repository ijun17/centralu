import { describe, expect, it } from 'vitest'
import type { AppRun } from '@cc/protocol'
import { chainRuns } from './RunsPanel.jsx'

/**
 * 기록 판의 사슬 (M4 D-6) — host가 준 한 목록(최근 것부터)을 부모 아래로 편다.
 */

const run = (id: string, createdAt: number, parentRunId: string | null = null): AppRun => ({
  id, projectId: 'p1', appId: 'notes', kind: 'tool', tool: 't', callerKind: parentRunId ? 'app' : 'view', callerSessionId: null, parentRunId,
  status: 'ok', durationMs: 1, argsDigest: 'd', argsSummary: '{}', error: null, createdAt, sessionId: null, tokens: null, failure: null,
})

describe('사슬로 편다', () => {
  it('부모가 목록에 있는 줄은 그 아래에 들여 쓰이고, 맨 위는 최근 것부터, 한 부모 아래는 일어난 순서대로다', () => {
    // host의 순서 그대로 — 최근 것부터(같은 시각이면 나중에 적힌 것이 먼저)
    const listed = [run('a2', 9), run('b1-ask', 4, 'b1'), run('a1-late', 3, 'a1'), run('a1-same', 3, 'a1'), run('b1', 2, 'a1'), run('a1', 1), run('lost', 0, 'gone')]
    expect(chainRuns(listed).map(({ run: r, depth }) => `${'  '.repeat(depth)}${r.id}`)).toEqual([
      'a2',
      'a1',
      '  b1',
      '    b1-ask',
      '  a1-same',
      '  a1-late',
      // 부모가 목록 밖이면(보관 기간이 지났다) 맨 위에 선다
      'lost',
    ])
  })

  it('서로를 부모로 가리키는 줄도 버리지 않는다', () => {
    expect(chainRuns([run('x', 2, 'y'), run('y', 1, 'x')]).map(({ run: r }) => r.id).sort()).toEqual(['x', 'y'])
  })
})
