import { describe, expect, it } from 'vitest'
import type { AppRun } from '@cc/protocol'
import { chainRuns } from './RunsPanel.jsx'

/**
 * The runs panel's chain (M4 D-6) — lays a single list from the host (newest first) out under each
 * parent.
 */

const run = (id: string, createdAt: number, parentRunId: string | null = null): AppRun => ({
  id, projectId: 'p1', appId: 'notes', kind: 'tool', tool: 't', callerKind: parentRunId ? 'app' : 'view', callerSessionId: null, parentRunId,
  status: 'ok', durationMs: 1, argsDigest: 'd', argsSummary: '{}', error: null, createdAt, sessionId: null, tokens: null, failure: null,
})

describe('lays it out as a chain', () => {
  it('indents a row whose parent is in the list under it, keeps the top level newest first, and keeps rows under one parent in the order they happened', () => {
    // Exactly the host's own order — newest first (a tie in time goes to whichever was written later)
    const listed = [run('a2', 9), run('b1-ask', 4, 'b1'), run('a1-late', 3, 'a1'), run('a1-same', 3, 'a1'), run('b1', 2, 'a1'), run('a1', 1), run('lost', 0, 'gone')]
    expect(chainRuns(listed).map(({ run: r, depth }) => `${'  '.repeat(depth)}${r.id}`)).toEqual([
      'a2',
      'a1',
      '  b1',
      '    b1-ask',
      '  a1-same',
      '  a1-late',
      // A row whose parent is outside the list (past the retention period) stands at the top level
      'lost',
    ])
  })

  it('does not drop rows that point at each other as parent', () => {
    expect(chainRuns([run('x', 2, 'y'), run('y', 1, 'x')]).map(({ run: r }) => r.id).sort()).toEqual(['x', 'y'])
  })
})
