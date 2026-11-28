/**
 * The Assistant's settings after #2532 (docs/plans/assistant-rename.md §3.4): only the new key is read and written, a
 * delete removes the old key too, and store step 79 deletes the old keys and rewrites the old `via` once. The builds the
 * floor admits (v75 to v78) read the new key first and the old one where the new one is missing.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { removeTree, tempRoot } from '../temp-dir.test-helpers.js'
import { Store } from './store.js'
import type { MigrationStep } from './store/migrations/context.js'

const KEYS = [
  ['assistant_tool', 'orchestrator_tool'],
  ['assistant_mcp_proposals', 'orchestrator_mcp_proposals'],
  ['assistant_skill_proposals', 'orchestrator_skill_proposals'],
  ['assistant_skills', 'orchestrator_skills'],
] as const

const LATEST = new Store().latestKnownVersion
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

function open(version: number, file?: string): Build {
  newest = version
  try {
    return new Build(file)
  } finally {
    newest = LATEST
  }
}

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeTree(d)
})

const row = (db: Database.Database, key: string) =>
  (db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key) as { value: string } | undefined)?.value ?? null
const put = (db: Database.Database, key: string, value: string) =>
  db.prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value)

describe('the Assistant’s settings under the new key only (#2532)', () => {
  it.each(KEYS)('%s is read and written alone, and its delete takes %s with it', (key, old) => {
    const s = open(LATEST)
    put(s.raw, old, '"stale"')
    expect(s.settings.appSetting(key)).toBeNull()
    s.settings.setAppSetting(key, '"codex"')
    expect([row(s.raw, key), row(s.raw, old)]).toEqual(['"codex"', '"stale"'])
    s.settings.deleteAppSetting(key)
    expect([row(s.raw, key), row(s.raw, old)]).toEqual([null, null])
    s.close()
  })

  it('step 79 deletes the old keys, keeps the new ones, and rewrites the old via; the build of v78 still opens the store', () => {
    const d = tempRoot('cc-assistant-step79-')
    dirs.push(d)
    const file = `${d}/store.db`
    const v78 = open(78, file)
    for (const [key, old] of KEYS) {
      put(v78.raw, key, `"${key}"`)
      put(v78.raw, old, `"${key}"`)
    }
    put(v78.raw, 'orchestrator_mcp_servers', '[]')
    v78.raw.exec(`INSERT INTO mail (id, sender, kind, root_id, body, created_at) VALUES ('m1', 'person', 'task', 'm1', 'x', 1)`)
    v78.raw.exec(`INSERT INTO mail_recipients (message_id, recipient, via, due_at) VALUES ('m1', 'a', 'orchestrator', 1), ('m1', 'b', NULL, 1)`)
    v78.close()

    const s = open(LATEST, file)
    expect(s.schemaVersion).toBe(LATEST)
    for (const [key, old] of KEYS) expect([row(s.raw, key), row(s.raw, old)]).toEqual([`"${key}"`, null])
    expect(row(s.raw, 'orchestrator_mcp_servers')).toBe('[]')
    expect(s.raw.prepare(`SELECT recipient, via FROM mail_recipients ORDER BY recipient`).all()).toEqual([
      { recipient: 'a', via: 'assistant' },
      { recipient: 'b', via: null },
    ])
    s.close()

    const back = open(78, file)
    expect(back.migrationsRun).toBe(0)
    back.close()
  })
})
