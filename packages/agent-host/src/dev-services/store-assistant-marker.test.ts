/**
 * The Assistant's marker under both names (#2133 step 3, docs/plans/assistant-rename.md): store step v68 adds
 * `sessions.is_assistant` and copies `is_orchestrator` into it, this build writes both, and it reads `is_orchestrator`
 * only. The build before this one writes only `is_orchestrator`, so after a person goes back to it, changes which
 * session is the Assistant and comes forward again, `is_assistant` is stale and `is_orchestrator` is not.
 */
import { describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { sessionLiveDefaults, type SessionInfo } from '@cc/protocol'
import { Store } from './store.js'
import type { MigrationStep } from './store/migrations/context.js'

/** The newest step the next store knows: 67 is the build before this step */
let newest = 68

/** A store that is the v67 build until `upgrade`, which runs v68 on the same connection */
class Versioned extends Store {
  protected override migrationSteps(): MigrationStep[] {
    return super.migrationSteps().filter((s) => s.to <= newest)
  }

  get raw(): Database.Database {
    return this.db
  }

  upgrade(): void {
    newest = 68
    this.migrate()
  }
}

function store(version: number): Versioned {
  newest = version
  try {
    return new Versioned()
  } finally {
    newest = 68
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
      s.upgrade()
      expect(s.schemaVersion).toBe(68)
      expect(markers(s)).toEqual([{ id: 'a', old: 1, new: 1 }, { id: 'w', old: 0, new: 0 }])
      expect(s.sessions.assistantId()).toBe('a')
    } finally {
      s.close()
    }
  })

  it('writes both columns', () => {
    const s = store(68)
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

  it('reads the old column, which stays right when the previous build moved the role in between', () => {
    const s = store(68)
    try {
      s.sessions.upsertSession(session('a', 'orchestrator'))
      // The person goes back to the previous build. It opens this store (v68 raised no floor) and names only the columns it
      // knows: `a` loses the marker, and it makes a new Assistant `b`
      s.raw.exec(`UPDATE sessions SET is_orchestrator = 0 WHERE id = 'a'`)
      olderInsert(s, 'b', 1)
      expect(markers(s)).toEqual([{ id: 'a', old: 0, new: 1 }, { id: 'b', old: 1, new: 0 }])

      // Forward again: this build reads the role from is_orchestrator
      expect(s.sessions.assistantId()).toBe('b')
      expect(s.sessions.listSessions().map((x) => [x.id, x.kind])).toEqual([['a', 'worker'], ['b', 'orchestrator']])
    } finally {
      s.close()
    }
  })
})
