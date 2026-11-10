/**
 * The Assistant's marker under both names (#2133, docs/plans/assistant-rename.md): store step v68 adds
 * `sessions.is_assistant` and copies `is_orchestrator` into it, and the build of v68 writes both and reads
 * `is_orchestrator`. Step 4 (v69) copies the marker once more, keeps out the builds that write only `is_orchestrator`,
 * and reads `is_assistant`; it still writes both, for the build of v68 a person can go back to.
 */
import { describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { sessionLiveDefaults, type SessionInfo } from '@cc/protocol'
import { Store } from './store.js'
import type { MigrationStep } from './store/migrations/context.js'

/** The newest step this build knows */
const LATEST = new Store().latestKnownVersion
/** The newest step the next store knows: 67 is the build before v68, 68 the build before step 4 */
let newest = LATEST

/** A store that is the build of `newest` until `upgrade`, which runs the later steps on the same connection */
class Versioned extends Store {
  protected override migrationSteps(): MigrationStep[] {
    return super.migrationSteps().filter((s) => s.to <= newest)
  }

  get raw(): Database.Database {
    return this.db
  }

  upgrade(to = LATEST): void {
    newest = to
    this.migrate()
  }
}

function store(version: number): Versioned {
  newest = version
  try {
    return new Versioned()
  } finally {
    newest = LATEST
  }
}

const session = (id: string, kind: SessionInfo['kind']): SessionInfo => ({
  id, projectId: null, kind, tool: 'claude', externalId: null, name: id, autoNamed: false, state: 'idle', lastReadSeq: 0, lastSeq: 0,
  createdAt: 1, waitingSince: null, live: false, model: null, effort: null, verbosity: null, serviceTier: null, permissionPreset: 'normal',
  importedFrom: null, worktree: null, parentSessionId: null, scopeSessionIds: null, roleAppend: null, appId: null, ...sessionLiveDefaults(),
})

const markers = (s: Versioned) => s.raw.prepare(`SELECT id, is_orchestrator AS old, is_assistant AS new FROM sessions ORDER BY id`).all()

/** What the build before this one writes for a session: only the columns it knows */
const olderInsert = (s: Versioned, id: string, marker: 0 | 1) =>
  s.raw.prepare(`INSERT INTO sessions (id, project_id, tool, name, created_at, is_orchestrator) VALUES (?, NULL, 'claude', ?, 1, ?)`).run(id, id, marker)

describe("the Assistant's marker under both names (#2133)", () => {
  it('v68 copies the marker of a store the previous build wrote', () => {
    const s = store(67)
    try {
      expect(s.raw.prepare(`SELECT name FROM pragma_table_info('sessions') WHERE name = 'is_assistant'`).all()).toEqual([])
      olderInsert(s, 'a', 1)
      olderInsert(s, 'w', 0)
      s.upgrade(68)
      expect(s.schemaVersion).toBe(68)
      expect(markers(s)).toEqual([{ id: 'a', old: 1, new: 1 }, { id: 'w', old: 0, new: 0 }])
      expect(s.sessions.assistantId()).toBe('a')
    } finally {
      s.close()
    }
  })

  it('writes both columns', () => {
    const s = store(LATEST)
    try {
      s.sessions.upsertSession(session('a', 'orchestrator'))
      s.sessions.upsertSession(session('w', 'worker'))
      expect(markers(s)).toEqual([{ id: 'a', old: 1, new: 1 }, { id: 'w', old: 0, new: 0 }])
      // A session read back and written again keeps its marker in both
      s.sessions.upsertSession({ ...session('a', 'worker'), ...s.sessions.listSessions().find((x) => x.id === 'a') })
      expect(markers(s)).toEqual([{ id: 'a', old: 1, new: 1 }, { id: 'w', old: 0, new: 0 }])
    } finally {
      s.close()
    }
  })

  it('reads the new column after v69, which copied the old one again: the build of v67 moved the role in between', () => {
    const s = store(68)
    try {
      s.sessions.upsertSession(session('a', 'orchestrator'))
      // The person goes back to the build of v67. It opens this store (v68 raised no floor) and names only the columns it
      // knows: `a` loses the marker, and it makes a new Assistant `b`
      s.raw.exec(`UPDATE sessions SET is_orchestrator = 0 WHERE id = 'a'`)
      olderInsert(s, 'b', 1)
      expect(markers(s)).toEqual([{ id: 'a', old: 0, new: 1 }, { id: 'b', old: 1, new: 0 }])

      // Forward to this build: v69 makes the old column the truth once more, then the new column is read
      s.upgrade()
      expect(markers(s)).toEqual([{ id: 'a', old: 0, new: 0 }, { id: 'b', old: 1, new: 1 }])
      expect(s.sessions.assistantId()).toBe('b')
      expect(s.sessions.listSessions().map((x) => [x.id, x.kind])).toEqual([['a', 'worker'], ['b', 'orchestrator']])
    } finally {
      s.close()
    }
  })

  it('reads the new column: the build of v68, gone back to after v69, writes both', () => {
    const s = store(LATEST)
    try {
      s.sessions.upsertSession(session('a', 'orchestrator'))
      s.sessions.upsertSession(session('w', 'worker'))
      // The build of v68 moves the role: its upsert names both columns, as this build's does
      s.raw.exec(`UPDATE sessions SET is_orchestrator = 0, is_assistant = 0 WHERE id = 'a'`)
      s.raw.exec(`UPDATE sessions SET is_orchestrator = 1, is_assistant = 1 WHERE id = 'w'`)
      expect(s.sessions.assistantId()).toBe('w')
      // Only the new column is read: a row whose old column alone says Assistant (no build that opens this store writes that) is not one
      s.raw.exec(`UPDATE sessions SET is_orchestrator = 1 WHERE id = 'a'`)
      expect(s.sessions.listSessions().map((x) => [x.id, x.kind])).toEqual([['a', 'worker'], ['w', 'orchestrator']])
    } finally {
      s.close()
    }
  })
})
