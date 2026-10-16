import type Database from 'better-sqlite3'
import { parseJson } from './json.js'

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

  loadWorkspace<T = unknown>(): T | null {
    const row = this.db.prepare(`SELECT layout FROM workspace WHERE id = 1`).get() as
      { layout: string } | undefined
    return (parseJson(row?.layout) ?? null) as T | null
  }

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
