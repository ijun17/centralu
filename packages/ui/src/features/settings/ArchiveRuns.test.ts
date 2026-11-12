import { describe, expect, it } from 'vitest'
import type { TrashedRun } from '@cc/protocol/client'
import { groupRuns, runsHaveRow } from './ArchiveRuns.jsx'

const run = (runId: string, projectId: string | null, machine?: string): TrashedRun => ({
  runId,
  app: { id: 'notes', name: 'Notes', projectId, projectName: null },
  sessionName: 'Notes · agent 10:00',
  tool: 'claude',
  status: 'ended',
  startedAt: 1,
  keptAt: 2,
  durationMs: null,
  tokens: null,
  requestPreview: '',
  messages: 0,
  bytes: 0,
  ...(machine ? { machine } : {}),
})

describe('the error of a failed "Delete all" of one app’s kept runs (#2173)', () => {
  it('is shown for a linked machine’s user-folder app too: the group and the section read one key', () => {
    const runs = [run('r1', null, 'm1'), run('r2', null)]
    const groups = groupRuns(runs)
    // The machine's app and this computer's app of the same id are two groups
    expect(groups.map((g) => g.key)).toEqual(['m1:_user/notes', '_user/notes'])
    for (const g of groups) {
      // What a failed delete of the group's runs files its error under (`onPurge(g.runs, g.key)`) is found among the runs
      expect(runsHaveRow(runs, g.key), g.key).toBe(true)
    }
    expect(runsHaveRow(runs, 'r1')).toBe(true)
    expect(runsHaveRow(runs, 'm2:_user/notes')).toBe(false)
  })
})
