/**
 * The Assistant's settings under both keys (#2133 step 3, docs/plans/assistant-rename.md, `RENAMED_SETTINGS`): the old
 * key is read first and the new one only when the old one was never written, and a write or delete reaches both. The
 * build before this one writes only the old key, so after a person goes back to it and changes a setting, the new key
 * is stale and the old one is not.
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

  it('reads the old key first: the build before this one changed it after this one wrote both', () => {
    const s = new RawStore()
    s.settings.setAppSetting('orchestrator_tool', 'codex')
    // The previous release, gone back to, writes only the old key
    put(s, 'orchestrator_tool', 'claude')
    expect(s.settings.appSetting('orchestrator_tool')).toBe('claude')
    s.close()
  })

  it('reads the new key when the old one was never written, as a later build may leave it', () => {
    const s = new RawStore()
    put(s, 'assistant_tool', 'codex')
    expect(s.settings.appSetting('orchestrator_tool')).toBe('codex')
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
