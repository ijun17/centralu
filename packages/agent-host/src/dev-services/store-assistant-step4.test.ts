/**
 * The Assistant rename's step 4 in the store (#2133, docs/plans/assistant-rename.md §3.2): v69 copies the old forms into
 * the new ones once, deleting a new settings key whose old key is gone, and raises the store's floor to 68, not to its own
 * version: the build of v68 (beta.54 on), which writes both forms, still opens the store, and a build of v67 or before,
 * which writes only the old form, does not. Step 74 (#2258) raises the floor to 70, so the store this checks is the one the build of v73 leaves.
 * Read through the rows: since #2532 the live settings read only the new key, and step 79 deletes the old ones.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { removeTree, tempRoot } from '../temp-dir.test-helpers.js'
import { Store, StoreTooNewError } from './store.js'
import type { MigrationStep } from './store/migrations/context.js'

const LATEST = new Store().latestKnownVersion
/** The last build whose store's floor step 69 sets */
const V73 = 73
/** The newest step the next store knows */
let newest = LATEST

/** The store as the build of `newest` opens it */
class Build extends Store {
  protected override migrationSteps(): MigrationStep[] {
    return super.migrationSteps().filter((s) => s.to <= newest)
  }

  get raw(): Database.Database {
    return this.db
  }
}

function open(version: number, file: string): Build {
  newest = version
  try {
    return new Build(file)
  } finally {
    newest = LATEST
  }
}

const dirs: string[] = []
function storeFile(): string {
  const d = tempRoot('cc-assistant-step4-')
  dirs.push(d)
  return `${d}/store.db`
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeTree(d)
})

/**
 * The file as the build of v68 serves it, the way another build writes it: v68 runs no step on a store of a later
 * version (the floor admits it), so this changes only what `f` does
 */
function raw<T>(file: string, f: (db: Database.Database) => T): T {
  const s = open(68, file)
  try {
    return f(s.raw)
  } finally {
    s.close()
  }
}
const row = (db: Database.Database, key: string) =>
  (db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key) as { value: string } | undefined)?.value ?? null
const put = (db: Database.Database, key: string, value: string) =>
  db.prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value)
const del = (db: Database.Database, key: string) => db.prepare(`DELETE FROM app_settings WHERE key = ?`).run(key)

/** A store the build of v68 left: it writes every renamed setting under both keys */
function v68Store(): string {
  const file = storeFile()
  const s = open(68, file)
  s.settings.setAppSetting('orchestrator_tool', 'codex')
  s.settings.setAppSetting('orchestrator_skills', '[{"name":"notes","content":"x"}]')
  s.settings.setAppSetting('orchestrator_skill_proposals', '[{"name":"p","content":"y"}]')
  s.settings.setAppSetting('orchestrator_mcp_proposals', '[{"name":"m"}]')
  expect(s.schemaVersion).toBe(68)
  s.close()
  return file
}

describe('#2133 step 4 in the store: v69', () => {
  it('keeps what the person removed: a key deleted under its old name only is deleted under its new name too', () => {
    const file = v68Store()
    // The writes of a build that deletes the old key alone (the last skill removed, the Assistant's tool reset) and leaves the new one
    raw(file, (db) => {
      del(db, 'orchestrator_skills')
      del(db, 'orchestrator_tool')
    })
    const s = open(V73, file)
    try {
      expect([row(s.raw, 'assistant_skills'), row(s.raw, 'assistant_tool')]).toEqual([null, null])
      // What was not removed is kept under both keys
      expect(row(s.raw, 'assistant_skill_proposals')).toBe('[{"name":"p","content":"y"}]')
      expect(row(s.raw, 'orchestrator_skill_proposals')).toBe('[{"name":"p","content":"y"}]')
      expect(row(s.raw, 'assistant_mcp_proposals')).toBe('[{"name":"m"}]')
    } finally {
      s.close()
    }
  })

  it('takes the old key over a stale new one: a build that changed only the old key served the store', () => {
    const file = v68Store()
    raw(file, (db) => put(db, 'orchestrator_tool', 'claude'))
    const s = open(V73, file)
    try {
      expect(row(s.raw, 'assistant_tool')).toBe('claude')
    } finally {
      s.close()
    }
  })

  it('runs once: a second open runs nothing, so a new key whose old key is absent is no longer deleted', () => {
    const file = v68Store()
    const s = open(V73, file)
    expect(s.schemaVersion).toBe(V73)
    s.close()
    raw(file, (db) => {
      del(db, 'orchestrator_tool')
      put(db, 'assistant_tool', 'codex')
    })
    const again = open(V73, file)
    try {
      expect(again.migrationsRun).toBe(0)
      expect(row(again.raw, 'assistant_tool')).toBe('codex')
    } finally {
      again.close()
    }
  })

  it('raises the floor to 68: the build of v68 opens the store, the build of v67 is refused', () => {
    const file = v68Store()
    open(V73, file).close()
    const stored = raw(file, (db) => row(db, 'min_reader_version'))
    expect(stored).toBe('68')

    const v68 = open(68, file)
    expect(v68.migrationsRun).toBe(0)
    expect(row(v68.raw, 'orchestrator_tool')).toBe('codex')
    v68.close()

    expect(() => open(67, file)).toThrow(StoreTooNewError)
    expect(() => open(67, file)).toThrow(/can be read from store version 68 on; this Centralu knows store versions up to 67/)
    // The refusal changed nothing
    raw(file, (db) => expect([db.pragma('user_version', { simple: true }), row(db, 'min_reader_version')]).toEqual([V73, '68']))
  })
})
