import type Database from 'better-sqlite3'
import { isObj, type Obj } from '../../json-value.js'
import { parseJson } from './json.js'

/**
 * The settings one session keeps, as a condition on `app_settings` with `@sessionId` bound: every key of the shape
 * `<name>:<sessionId>` (`agent_depth:`, `report_paused:`, `tool_prefix:`, …). A key built for one session takes that
 * shape, and the trash's purge deletes them all by it (`TrashRecords.purgeSession`), so a key added later goes with
 * its session without the purge having to learn its name.
 *
 * The id is the whole part after the name, and a name holds no `:` (#1142): a session whose id ends in `:<another id>`
 * would otherwise lose its keys with the other session's.
 */
export const SESSION_SETTING_OF =
  `length(key) > length(@sessionId) + 1 AND substr(key, -length(@sessionId) - 1) = ':' || @sessionId` +
  ` AND instr(substr(key, 1, length(key) - length(@sessionId) - 1), ':') = 0`

/** The part of the store one setting is read from and written to */
export type SettingAccess = { appSetting(key: string): string | null; setAppSetting(key: string, value: string): void }

/**
 * A setting that is on or off, stored as `'true'` or `'false'` (#850). Never written reads as `byDefault` (see
 * `appSetting`: a default can move later without overruling the one person who turned the thing off), and so does a
 * value this build cannot read.
 */
export function flagSetting(settings: SettingAccess, key: string, byDefault: boolean): { read(): boolean; write(on: boolean): void } {
  return {
    read: () => {
      const v = settings.appSetting(key)
      return v === 'true' ? true : v === 'false' ? false : byDefault
    },
    write: (on) => settings.setAppSetting(key, String(on)),
  }
}

/** What a list setting reaches of the store */
export type ListSettingAccess = SettingAccess & { deleteAppSetting(key: string): void }

/** The row a list setting's unreadable value is set aside in: `<key>.unreadable`, or `<name>.unreadable:<sessionId>` for a session's, so it goes with the session */
export function asideKeyOf(key: string): string {
  const i = key.lastIndexOf(':')
  return i < 0 ? `${key}.unreadable` : `${key.slice(0, i)}.unreadable${key.slice(i)}`
}

/** The rows already said to be unreadable, and what they held then, so each is said once until it changes */
const saidUnreadable = new Map<string, string>()

/**
 * A list of objects kept in one row and written back after a change (#384): what one build writes, another reads and
 * rewrites, during a host swap and after a person goes back a release. `has` says whether an element is one this
 * build can use. `read` gives those; an element this build cannot read (a newer build's, in another shape or with a
 * word this one does not know) is not used, and `write` keeps it, after the elements written. A row that is not a
 * list reads as empty, and is named on stderr; the first write sets it aside under `asideKeyOf(key)` before replacing
 * it, so what it held is not lost without a word. An empty result deletes the row.
 */
export function listSetting<T extends object>(
  settings: ListSettingAccess,
  key: string,
  has: (x: Obj) => boolean,
): { read(): T[]; write(items: readonly T[]): void } {
  const usable = (x: unknown): x is Obj => isObj(x) && has(x)
  const stored = (): { raw: string | null; list: unknown[] | null } => {
    const raw = settings.appSetting(key)
    const v = parseJson(raw)
    return { raw, list: Array.isArray(v) ? v : null }
  }
  return {
    read: () => {
      const { raw, list } = stored()
      if (raw !== null && list === null && saidUnreadable.get(key) !== raw) {
        saidUnreadable.set(key, raw)
        console.error(`[store] app_settings.${key} is not a JSON list: ${JSON.stringify(raw.slice(0, 200))}; it reads as empty, and is set aside as app_settings.${asideKeyOf(key)} when next written`)
      }
      return (list ?? []).filter(usable) as unknown as T[]
    },
    write: (items) => {
      const { raw, list } = stored()
      if (raw !== null && list === null) {
        settings.setAppSetting(asideKeyOf(key), raw)
        console.error(`[store] app_settings.${key} was not a JSON list; what it held is kept as app_settings.${asideKeyOf(key)}`)
      }
      const next = [...items, ...(list ?? []).filter((x) => !usable(x))]
      if (next.length === 0) settings.deleteAppSetting(key)
      else settings.setAppSetting(key, JSON.stringify(next))
    },
  }
}

/** What belongs to this install: its settings, the workspace snapshot and the cache of a tool's commands */
export class SettingsRecords {
  constructor(private readonly db: Database.Database) {}

  saveCommands(tool: string, cwd: string, commands: unknown): void {
    this.db
      .prepare(
        `INSERT INTO command_cache (tool, cwd, commands, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(tool, cwd) DO UPDATE SET commands = excluded.commands, updated_at = excluded.updated_at`,
      )
      .run(tool, cwd, JSON.stringify(commands), Date.now())
  }

  loadCommands<T>(tool: string, cwd: string): T | null {
    const row = this.db
      .prepare(`SELECT commands FROM command_cache WHERE tool = ? AND cwd = ?`)
      .get(tool, cwd) as { commands: string } | undefined
    return (parseJson(row?.commands) ?? null) as T | null
  }

  /**
   * A workspace snapshot (C-3). Saved on every change rather than at exit, so the last state
   * survives even a crash (docs/state-management.md §5).
   */
  saveWorkspace(layout: unknown): void {
    this.db
      .prepare(
        `INSERT INTO workspace (id, layout, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET layout = excluded.layout, updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify(layout), Date.now())
  }

  /**
   * The snapshot, or null for none. One that is not a JSON object (a write cut short, a hand edit) reads as none too,
   * and is named on stderr with what it held (#384): the window comes up as its defaults and its next change replaces
   * the row, so the line is what is left of it.
   */
  loadWorkspace<T = unknown>(): T | null {
    const row = this.db.prepare(`SELECT layout FROM workspace WHERE id = 1`).get() as
      { layout: string } | undefined
    if (!row) return null
    const v = parseJson(row.layout)
    if (isObj(v)) return v as T
    // Once per row text: the screen preferences read it too, on every read until an old text size has moved (#312)
    if (this.brokenWorkspaceSaid !== row.layout) {
      this.brokenWorkspaceSaid = row.layout
      console.error(`[store] the workspace snapshot (workspace row 1) is not a JSON object: ${JSON.stringify(row.layout.slice(0, 2000))}; the window opens as its defaults`)
    }
    return null
  }

  private brokenWorkspaceSaid: string | null = null

  /**
   * A setting that belongs to this install rather than to any project or session (#43).
   *
   * `null` means never written, which is deliberately distinguishable from a stored
   * `'false'`: it is what lets a default move later without silently overruling the one
   * person who had turned the thing off (the same trade `showIgnored` makes in the UI).
   */
  appSetting(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key) as
      { value: string } | undefined
    return row?.value ?? null
  }

  setAppSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value)
  }

  /**
   * Reads a setting, computes its next value from it and writes that, as one transaction that takes the write lock
   * first. Another process on the same file (the old and new host of a swap) cannot change the value between the
   * read and the write, which a separate appSetting and setAppSetting cannot promise.
   */
  updateAppSetting(key: string, next: (current: string | null) => string): void {
    this.db.transaction(() => this.setAppSetting(key, next(this.appSetting(key)))).immediate()
  }

  /** Deletes a setting — reading it back afterward is "never written" (null). Where an old key is cleaned up once everything is migrated off it (M4 A-7) */
  deleteAppSetting(key: string): void {
    this.db.prepare(`DELETE FROM app_settings WHERE key = ?`).run(key)
  }
}
