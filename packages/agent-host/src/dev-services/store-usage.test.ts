/**
 * The tables behind usage over time (v62, docs/agent-host.md §6.2): an expand step, and the upserts the recorder uses.
 */
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sessionLiveDefaults } from '@cc/protocol'
import { Store } from './store.js'
import type { UsageBucket } from './store/usage-history.js'

const bucket = (over: Partial<UsageBucket> = {}): UsageBucket => ({
  hour: 3_600_000, sessionId: 's1', projectId: 'p1', tool: 'claude', model: 'opus', machine: '',
  requests: 1, input: 10, cacheRead: 100, cacheWrite: 1000, cacheWrite5m: 0, cacheWrite1h: 1000, output: 5, rebuilds: 1, causes: { expired: 1 }, ...over,
})

describe('v62 usage tables', () => {
  it('adds both tables to a store from before them without touching what it holds, and a build that does not know them still opens it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-usage-v62-'))
    try {
      const file = join(dir, 'store.db')
      const first = new Store(file)
      first.projects.addProject({ id: 'p1', path: '/tmp/p1', name: 'p1' })
      first.close()
      // The state a v54 build left: the new tables do not exist yet, the version is the one before this step (v61)
      const raw = new Database(file)
      raw.exec('DROP TABLE usage_readings; DROP TABLE usage_buckets; PRAGMA user_version = 61')
      raw.close()

      const s = new Store(file)
      expect(s.schemaVersion).toBe(62)
      expect(s.projects.listProjects().map((p) => p.id)).toEqual(['p1'])
      s.usage.addBuckets([bucket()])
      expect(s.usage.buckets(0, 10 * 3_600_000)).toHaveLength(1)
      s.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('UsageRecords', () => {
  it('adds a second write to the same hour to its row, adding the rebuild causes', () => {
    const s = new Store()
    s.usage.addBuckets([bucket()])
    s.usage.addBuckets([bucket({ requests: 2, input: 3, cacheWrite: 7, cacheWrite1h: 0, cacheWrite5m: 7, rebuilds: 2, causes: { expired: 1, model_change: 1 } })])
    s.usage.addBuckets([bucket({ requests: 1, rebuilds: 0, causes: {} })])
    expect(s.usage.buckets(0, 2 * 3_600_000)).toEqual([
      bucket({ requests: 4, input: 23, cacheRead: 300, cacheWrite: 2007, cacheWrite5m: 7, cacheWrite1h: 1000 + 1000, output: 15, rebuilds: 3, causes: { expired: 2, model_change: 1 } }),
    ])
  })

  it('sweeps the buckets of sessions that no longer exist, and keeps a trashed one', async () => {
    const s = new Store()
    s.projects.addProject({ id: 'p1', path: '/tmp/p1', name: 'p1' })
    for (const id of ['live', 'trashed']) {
      s.sessions.upsertSession({
        id, projectId: 'p1', kind: 'worker', tool: 'claude', externalId: null, name: id, autoNamed: false, state: 'idle',
        lastReadSeq: 0, lastSeq: 0, createdAt: 1, waitingSince: null, live: false, model: null, effort: null,
        verbosity: null, serviceTier: null, permissionPreset: 'normal', importedFrom: null, worktree: null,
        parentSessionId: null, scopeSessionIds: null, roleAppend: null, appId: null, ...sessionLiveDefaults(),
      })
    }
    s.usage.addBuckets([bucket({ sessionId: 'live' }), bucket({ sessionId: 'trashed' }), bucket({ sessionId: 'gone' })])
    await s.trash.trashSession('trashed', { projectId: 'p1', projectName: 'p1', projectPath: '/tmp/p1', removeExternal: false, removeWorktree: false })
    s.usage.sweepOrphans()
    expect(s.usage.buckets(0, 10 * 3_600_000).map((b) => b.sessionId).sort()).toEqual(['live', 'trashed'])
  })

  it('keeps rows of other keys apart, and reads only the hours asked for', () => {
    const s = new Store()
    s.usage.addBuckets([bucket(), bucket({ model: 'sonnet' }), bucket({ sessionId: 's2' }), bucket({ hour: 5 * 3_600_000 })])
    expect(s.usage.buckets(0, 2 * 3_600_000)).toHaveLength(3)
    expect(s.usage.buckets(5 * 3_600_000, 6 * 3_600_000)).toHaveLength(1)
    expect(s.usage.firstHour()).toBe(3_600_000)
  })
})
