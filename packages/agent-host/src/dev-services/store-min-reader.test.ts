/**
 * Which builds can still read the store (#292).
 *
 * Measured for #280 (2026-10-04): an older host opened a newer store without complaint and failed only when it touched
 * something a later step had dropped — `sessions.archived` (v28) and `projects.default_model` / `default_effort` (v32)
 * broke it outright, and dropping `control_center` (v13) silently lost the grid placements. The store now records the
 * lowest version that can read it, and a host below that refuses to start.
 */
import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store, StoreTooNewError, storeTooNewMessage } from './store.js'

const dirs: string[] = []
function storeFile(): string {
  const d = mkdtempSync(join(tmpdir(), 'cc-min-reader-'))
  dirs.push(d)
  return join(d, 'store.db')
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** The newest step this host knows */
const KNOWN = new Store().latestKnownVersion
/** The last breaking step today (v32): every store this host has migrated is readable from here on */
const FLOOR = 32

/** A store at the current version, with one project in it */
function currentStore(): string {
  const file = storeFile()
  const s = new Store(file)
  s.addProject({ id: 'p1', path: '/tmp/p1', name: 'p1' })
  s.close()
  return file
}

/** Opens the file without the Store — the way another build, older or newer, would find it */
function raw<T>(file: string, f: (db: Database.Database) => T): T {
  const db = new Database(file)
  try {
    return f(db)
  } finally {
    db.close()
  }
}
const setFloor = (db: Database.Database, v: number) =>
  db
    .prepare(
      `INSERT INTO app_settings (key, value) VALUES ('min_reader_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(String(v))
const floorOf = (db: Database.Database) =>
  (db.prepare(`SELECT value FROM app_settings WHERE key = 'min_reader_version'`).get() as { value: string } | undefined)
    ?.value
const hasTable = (db: Database.Database, name: string) =>
  db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined

describe('which builds can still read the store (#292)', () => {
  it('a store at the current version opens, runs nothing, and is readable from the last breaking step on', () => {
    const file = currentStore()
    const s = new Store(file)
    expect(s.migrationsRun).toBe(0)
    expect(s.schemaVersion).toBe(KNOWN)
    expect(s.minReaderVersion).toBe(FLOOR)
    expect(s.listProjects().map((p) => p.id)).toEqual(['p1'])
    s.close()
  })

  it('a store a newer Centralu made unreadable to this host is refused, naming both versions, and left untouched', () => {
    const file = currentStore()
    raw(file, (db) => {
      db.pragma(`user_version = ${KNOWN + 3}`)
      setFloor(db, KNOWN + 2)
      // What a newer contract step might have dropped. schema.sql would recreate it empty if it ran
      db.exec(`DROP TABLE usage_facts`)
    })

    let err: unknown
    try {
      new Store(file).close()
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(StoreTooNewError)
    const message = (err as Error).message
    expect(message).toBe(storeTooNewMessage(KNOWN + 2, KNOWN, file))
    expect(message).toContain('This data was written by a newer Centralu.')
    expect(message).toContain(`It can be read from store version ${KNOWN + 2} on; this Centralu knows store versions up to ${KNOWN}.`)

    // Refused before schema.sql or any step touched it
    raw(file, (db) => {
      expect(db.pragma('user_version', { simple: true })).toBe(KNOWN + 3)
      expect(floorOf(db)).toBe(String(KNOWN + 2))
      expect(hasTable(db, 'usage_facts')).toBe(false)
    })
  })

  it.each([
    ['well below this host', FLOOR],
    ['exactly this host', KNOWN],
  ])('a store newer than this host but readable from %s opens, and is not migrated', (_label, floor) => {
    const file = currentStore()
    raw(file, (db) => {
      db.pragma(`user_version = ${KNOWN + 2}`)
      setFloor(db, floor)
      // An expand step this host has never heard of
      db.exec(`ALTER TABLE sessions ADD COLUMN from_a_newer_build TEXT`)
    })

    const s = new Store(file)
    expect(s.migrationsRun).toBe(0)
    expect(s.schemaVersion).toBe(KNOWN + 2)
    expect(s.minReaderVersion).toBe(floor)
    expect(s.listProjects().map((p) => p.id)).toEqual(['p1'])
    s.close()
  })

  it('applying a breaking step raises the record to that step', () => {
    const file = currentStore()
    // Back to v31, readable from v28 on: the two columns v32 drops are still there
    raw(file, (db) => {
      db.exec(`ALTER TABLE projects ADD COLUMN default_model TEXT; ALTER TABLE projects ADD COLUMN default_effort TEXT`)
      db.pragma('user_version = 31')
      setFloor(db, 28)
    })

    const s = new Store(file)
    expect(s.migrationsRun).toBe(KNOWN - 31)
    expect(s.minReaderVersion).toBe(32)
    s.close()
    raw(file, (db) => expect(floorOf(db)).toBe('32'))
  })

  it('the record is raised before the breaking step runs, so a step that fails leaves older hosts out', () => {
    const file = currentStore()
    raw(file, (db) => {
      db.exec(`ALTER TABLE projects ADD COLUMN default_model TEXT; ALTER TABLE projects ADD COLUMN default_effort TEXT`)
      // SQLite will not drop an indexed column, so v32 throws partway
      db.exec(`CREATE INDEX idx_blocks_v32 ON projects(default_model)`)
      db.pragma('user_version = 31')
      setFloor(db, 28)
    })

    expect(() => new Store(file)).toThrow()
    raw(file, (db) => {
      expect(db.pragma('user_version', { simple: true })).toBe(31)
      expect(floorOf(db)).toBe('32')
    })
  })

  it('a store from before the record gets it computed once from the steps it has already run', () => {
    const file = currentStore()
    raw(file, (db) => db.exec(`DELETE FROM app_settings WHERE key = 'min_reader_version'`))

    const s = new Store(file)
    expect(s.migrationsRun).toBe(0)
    expect(s.minReaderVersion).toBe(FLOOR)
    s.close()
    // Written down, not only worked out for this open
    raw(file, (db) => expect(floorOf(db)).toBe(String(FLOOR)))
  })

  /*
   * The classification is part of the record: changing a step's flag after it shipped changes what older hosts are
   * told. A new breaking or heavy step adds itself here, where a reviewer sees it.
   */
  it('every step declares whether it breaks older readers; v13, v28 and v32 do, and v3, v11, v21 and v40 are heavy', () => {
    type Step = { to: number; breaksOlderReaders: boolean; heavy?: true }
    const steps = (new Store() as unknown as { migrationSteps(): Step[] }).migrationSteps()
    expect(steps.map((s) => s.to)).toEqual(Array.from({ length: KNOWN - 1 }, (_, i) => i + 2))
    expect(steps.every((s) => typeof s.breaksOlderReaders === 'boolean')).toBe(true)
    expect(steps.filter((s) => s.breaksOlderReaders).map((s) => s.to)).toEqual([13, 28, 32])
    expect(steps.filter((s) => s.heavy).map((s) => s.to)).toEqual([3, 11, 21, 40])
  })

  /*
   * The same exit as a lock conflict (#184): the desktop supervisor reads only the host's stdout, and stops retrying
   * on this sentence. This launches a real host.
   */
  it('a host given a store it cannot read says so on stdout and exits with 1', () => {
    const file = currentStore()
    raw(file, (db) => {
      db.pragma(`user_version = ${KNOWN + 1}`)
      setFloor(db, KNOWN + 1)
    })
    const root = fileURLToPath(new URL('../../../../', import.meta.url))
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'packages/agent-host/src/main.ts', '--db', file, '--port', '0'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, CI: '1', CC_DATA_DIR: join(file, '..') },
    })
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('This data was written by a newer Centralu.')
    expect(r.stdout).toContain(`store version ${KNOWN + 1} on; this Centralu knows store versions up to ${KNOWN}`)
    expect(r.stdout).not.toContain('"ready":true')
  }, 60_000)
})
