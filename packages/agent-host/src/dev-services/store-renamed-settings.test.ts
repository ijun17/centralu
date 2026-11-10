/**
 * The Assistant's settings under both keys (#2133, docs/plans/assistant-rename.md §3.2, `RENAMED_SETTINGS`): a write or
 * delete reaches both keys, and since step 4 a read takes the new key first. Store step v69 copied the old keys once and
 * keeps out the builds that write only the old key (`store-assistant-step4.test.ts`); the build of v68, which a person
 * can go back to, writes and deletes both.
 */
import { describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { Store } from './store.js'
import { RENAMED_SETTINGS } from './store/settings.js'

class RawStore extends Store {
  get raw(): Database.Database {
    return this.db
  }
}

const row = (s: RawStore, key: string) => s.raw.prepare<[string], { value: string }>(`SELECT value FROM app_settings WHERE key = ?`).get(key)?.value ?? null
const put = (s: RawStore, key: string, value: string) => s.raw.prepare(`INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)`).run(key, value)

describe('the Assistant’s settings under both keys (#2133)', () => {
  it.each([...RENAMED_SETTINGS])('%s is written and deleted under %s too', (old, renamed) => {
    const s = new RawStore()
    s.settings.setAppSetting(old, '"codex"')
    expect([row(s, old), row(s, renamed)]).toEqual(['"codex"', '"codex"'])
    s.settings.updateAppSetting(old, () => '"claude"')
    expect([row(s, old), row(s, renamed)]).toEqual(['"claude"', '"claude"'])
    s.settings.deleteAppSetting(old)
    expect([row(s, old), row(s, renamed)]).toEqual([null, null])
    s.close()
  })

  it('reads the new key first, and the old key only when the new one is missing', () => {
    const s = new RawStore()
    s.settings.setAppSetting('orchestrator_tool', 'codex')
    put(s, 'orchestrator_tool', 'claude')
    put(s, 'assistant_tool', 'opencode')
    expect(s.settings.appSetting('orchestrator_tool')).toBe('opencode')
    put(s, 'orchestrator_skills', '[]')
    expect(s.settings.appSetting('orchestrator_skills')).toBe('[]')
    s.close()
  })

  it('leaves other keys alone', () => {
    const s = new RawStore()
    s.settings.setAppSetting('orchestrator_mcp_servers', '[]')
    expect(row(s, 'assistant_mcp_servers')).toBeNull()
    put(s, 'assistant_mcp_servers', '[1]')
    s.settings.deleteAppSetting('orchestrator_mcp_servers')
    expect(s.settings.appSetting('orchestrator_mcp_servers')).toBeNull()
    s.close()
  })
})
