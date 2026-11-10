/**
 * The Assistant rename's step 4 in the store (#2133, docs/plans/assistant-rename.md §3.2): v69 copies the old forms into
 * the new ones once, deleting a new settings key whose old key is gone, and raises the store's floor to 68, not to its own
 * version: the build of v68 (beta.54 on), which writes both forms, still opens the store, and a build of v67 or before,
 * which writes only the old form, does not.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { removeTree, tempRoot } from '../temp-dir.test-helpers.js'
import { Store, StoreTooNewError } from './store.js'
import type { MigrationStep } from './store/migrations/context.js'
import { RENAMED_SETTINGS } from './store/settings.js'

const LATEST = new Store().latestKnownVersion
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
    const s = open(LATEST, file)
    try {
      expect(s.settings.appSetting('orchestrator_skills')).toBeNull()
      expect(s.settings.appSetting('orchestrator_tool')).toBeNull()
      // The rows are gone, not only unread
      expect([row(s.raw, 'assistant_skills'), row(s.raw, 'assistant_tool')]).toEqual([null, null])
      // What was not removed is kept under both keys
      expect(s.settings.appSetting('orchestrator_skill_proposals')).toBe('[{"name":"p","content":"y"}]')
      expect(row(s.raw, 'assistant_mcp_proposals')).toBe('[{"name":"m"}]')
    } finally {
      s.close()
    }
  })

  it('takes the old key over a stale new one: a build that changed only the old key served the store', () => {
    const file = v68Store()
    raw(file, (db) => put(db, 'orchestrator_tool', 'claude'))
    const s = open(LATEST, file)
    try {
      expect(s.settings.appSetting('orchestrator_tool')).toBe('claude')
      expect(row(s.raw, 'assistant_tool')).toBe('claude')
    } finally {
      s.close()
    }
  })

  it('runs once: after it, the new key is read first, and a write or delete still reaches both keys', () => {
    const file = v68Store()
    const s = open(LATEST, file)
    try {
      expect(s.schemaVersion).toBe(LATEST)
      put(s.raw, 'assistant_tool', 'opencode')
      expect(s.settings.appSetting('orchestrator_tool')).toBe('opencode')
      for (const [old, renamed] of RENAMED_SETTINGS) {
        s.settings.setAppSetting(old, '"v"')
        expect([row(s.raw, old), row(s.raw, renamed)]).toEqual(['"v"', '"v"'])
        s.settings.deleteAppSetting(old)
        expect([row(s.raw, old), row(s.raw, renamed)]).toEqual([null, null])
      }
    } finally {
      s.close()
    }
    // A second open runs nothing: a new key whose old key is absent is no longer deleted
    raw(file, (db) => put(db, 'assistant_tool', 'codex'))
    const again = new Store(file)
    try {
      expect(again.migrationsRun).toBe(0)
      expect(again.settings.appSetting('orchestrator_tool')).toBe('codex')
    } finally {
      again.close()
    }
  })

  it('raises the floor to 68: the build of v68 opens the store, the build of v67 is refused', () => {
    const file = v68Store()
    new Store(file).close()
    const stored = raw(file, (db) => row(db, 'min_reader_version'))
    expect(stored).toBe('68')

    const v68 = open(68, file)
    expect(v68.migrationsRun).toBe(0)
    expect(v68.settings.appSetting('orchestrator_tool')).toBe('codex')
    v68.close()

    expect(() => open(67, file)).toThrow(StoreTooNewError)
    expect(() => open(67, file)).toThrow(/can be read from store version 68 on; this Centralu knows store versions up to 67/)
    // The refusal changed nothing
    raw(file, (db) => expect([db.pragma('user_version', { simple: true }), row(db, 'min_reader_version')]).toEqual([LATEST, '68']))
  })
})
