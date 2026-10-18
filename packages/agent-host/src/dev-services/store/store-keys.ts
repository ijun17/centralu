import type Database from 'better-sqlite3'

/** The host's own settings (v16). Also created by the first write of `min_reader_version`, which can come before v16 */
export const APP_SETTINGS_DDL = `
  CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`

/**
 * A key the store's own bookkeeping keeps in `app_settings`: the reader floor (reader-gate.ts), the steps a swap left
 * for later (migrate-runner.ts) and an owed vacuum (vacuum.ts). Read before schema.sql and the migrations have run, so
 * a store from before v16 has no table yet, which reads as null, as a missing row does.
 */
export function readStoreKey(db: Database.Database, key: string): string | null {
  const table = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'`).get()
  if (!table) return null
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key) as { value: string } | undefined
  return row?.value ?? null
}

/**
 * Writes one of them, or deletes it for `null`. The table is made first: v13 raises the reader floor before v16 has
 * made it, and the DDL is the same, so v16 then finds it in place.
 */
export function writeStoreKey(db: Database.Database, key: string, value: string | null): void {
  db.exec(APP_SETTINGS_DDL)
  if (value === null) db.prepare(`DELETE FROM app_settings WHERE key = ?`).run(key)
  else db.prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value)
}
