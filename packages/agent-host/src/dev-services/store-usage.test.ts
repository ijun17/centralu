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
  requests: 1, input: 10, cacheRead: 100, cacheWrite: 1000, cacheWrite5m: 0, cacheWrite1h: 1000, output: 5, rebuilds: 1, rebuildTokens: 1000, causes: { expired: 1 }, ...over,
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
      expect(s.schemaVersion).toBe(64)
      expect(s.projects.listProjects().map((p) => p.id)).toEqual(['p1'])
      s.usage.addBuckets([bucket()])
      expect(s.usage.buckets(0, 10 * 3_600_000)).toHaveLength(1)
      s.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('v63 rebuild tokens (#1492)', () => {
  it('adds the column to a v62 store, reads its rows as none counted, and an older build’s insert still works over it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-usage-v63-'))
    const open: { close(): void }[] = []
    try {
      const file = join(dir, 'store.db')
      new Store(file).close()
      // The state a v62 build left: the table without the column, with an hour a rebuild was counted in
      const raw = new Database(file)
      open.push(raw)
      raw.exec(`DROP TABLE usage_buckets; PRAGMA user_version = 62`)
      raw.exec(`CREATE TABLE usage_buckets (hour INTEGER NOT NULL, session_id TEXT NOT NULL, project_id TEXT NOT NULL DEFAULT '', tool TEXT NOT NULL,
          model TEXT NOT NULL DEFAULT '', machine TEXT NOT NULL DEFAULT '', requests INTEGER NOT NULL DEFAULT 0, input INTEGER NOT NULL DEFAULT 0,
          cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0, cache_write_5m INTEGER NOT NULL DEFAULT 0,
          cache_write_1h INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0, rebuilds INTEGER NOT NULL DEFAULT 0,
          causes TEXT NOT NULL DEFAULT '{}', PRIMARY KEY (hour, session_id, project_id, tool, model, machine))`)
      raw.exec(`INSERT INTO usage_buckets (hour, session_id, tool, requests, rebuilds) VALUES (3600000, 's1', 'claude', 3, 1)`)
      raw.close()

      const s = new Store(file)
      open.push(s)
      expect(s.schemaVersion).toBe(64)
      expect(s.usage.buckets(0, 2 * 3_600_000)).toMatchObject([{ sessionId: 's1', requests: 3, rebuilds: 1, rebuildTokens: 0 }])
      s.close()
      // The previous build names its columns and has none of this one: its insert takes the default
      const older = new Database(file)
      open.push(older)
      older.exec(`INSERT INTO usage_buckets (hour, session_id, tool, requests, rebuilds) VALUES (7200000, 's2', 'claude', 1, 1)`)
      older.close()
      const again = new Store(file)
      open.push(again)
      expect(again.usage.buckets(0, 3 * 3_600_000).map((b) => b.rebuildTokens)).toEqual([0, 0])
      // This build adds to an hour of the older one's: the tokens add to what is there
      again.usage.addBuckets([bucket({ sessionId: 's2', projectId: '', model: '', hour: 7_200_000, rebuilds: 1, rebuildTokens: 400 })])
      expect(again.usage.buckets(7_200_000, 3 * 3_600_000)).toMatchObject([{ rebuilds: 2, rebuildTokens: 400 }])
    } finally {
      for (const d of open) {
        try {
          d.close()
        } catch {
          /* closed already */
        }
      }
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
      bucket({ requests: 4, input: 23, cacheRead: 300, cacheWrite: 2007, cacheWrite5m: 7, cacheWrite1h: 1000 + 1000, output: 15, rebuilds: 3, rebuildTokens: 3000, causes: { expired: 2, model_change: 1 } }),
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

describe('v64 the last totals of a tool that reports no limits (#1623)', () => {
  const totals = (asOf: number, sessions = 28) => ({
    scope: 'all time',
    asOf,
    rows: [{ id: 'sessions', label: 'Sessions', value: sessions, unit: 'count' as const }],
  })

  it('adds the table to a store from before it without touching what it holds, and a build that does not know it still opens it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-usage-v64-'))
    const open: { close(): void }[] = []
    try {
      const file = join(dir, 'store.db')
      const first = new Store(file)
      first.projects.addProject({ id: 'p1', path: '/tmp/p1', name: 'p1' })
      first.usage.addBuckets([bucket()])
      first.close()
      const raw = new Database(file)
      open.push(raw)
      raw.exec('DROP TABLE usage_local_totals; PRAGMA user_version = 63')
      raw.close()

      const s = new Store(file)
      open.push(s)
      expect(s.schemaVersion).toBe(64)
      expect(s.projects.listProjects().map((p) => p.id)).toEqual(['p1'])
      expect(s.usage.buckets(0, 10 * 3_600_000)).toHaveLength(1)
      expect(s.usage.localTotals('opencode')).toBeNull()
      s.usage.saveLocalTotals('opencode', totals(5))
      s.close()
      // The previous build neither names nor reads the table: it opens the store and carries on
      const older = new Database(file)
      open.push(older)
      expect(older.prepare('SELECT COUNT(*) AS n FROM usage_buckets').get()).toEqual({ n: 1 })
      older.close()
    } finally {
      for (const d of open) {
        try {
          d.close()
        } catch {
          /* closed already */
        }
      }
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps the totals across a restart, per tool, with the time they were read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-usage-totals-'))
    try {
      const file = join(dir, 'store.db')
      const a = new Store(file)
      a.usage.saveLocalTotals('opencode', totals(1_000))
      a.close()
      const b = new Store(file)
      expect(b.usage.localTotals('opencode')).toEqual(totals(1_000))
      expect(b.usage.localTotals('cursor')).toBeNull()
      b.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('replaces the totals with a newer read, and never with an older one', () => {
    const s = new Store()
    s.usage.saveLocalTotals('opencode', totals(2_000, 28))
    s.usage.saveLocalTotals('opencode', totals(3_000, 30))
    s.usage.saveLocalTotals('opencode', totals(1_000, 5))
    expect(s.usage.localTotals('opencode')).toEqual(totals(3_000, 30))
  })

  it('does not keep totals that do not say when they were read, and reads a row it cannot make sense of as none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-usage-totals-bad-'))
    const open: { close(): void }[] = []
    try {
      const file = join(dir, 'store.db')
      const s = new Store(file)
      open.push(s)
      s.usage.saveLocalTotals('opencode', { scope: 'all time', rows: [] })
      expect(s.usage.localTotals('opencode')).toBeNull()
      s.usage.saveLocalTotals('opencode', totals(7))
      const raw = new Database(file)
      open.push(raw)
      raw.prepare("UPDATE usage_local_totals SET totals = ? WHERE tool = 'opencode'").run('{"scope":1}')
      expect(s.usage.localTotals('opencode')).toBeNull()
      raw.prepare("UPDATE usage_local_totals SET totals = ? WHERE tool = 'opencode'").run('not json')
      expect(s.usage.localTotals('opencode')).toBeNull()
    } finally {
      for (const d of open) {
        try {
          d.close()
        } catch {
          /* closed already */
        }
      }
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
