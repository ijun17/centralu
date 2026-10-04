/**
 * Migrations during a blue-green host swap (#280 step 3).
 *
 * The host taking over runs only what the previous build can still read, so the keeper can start that build again if
 * the new host fails before it is ready. Heavy steps (seconds on a real store) and breaking steps wait until the swap
 * is over. These tests rewind a current store's `user_version` so that real steps are pending: v39 and every step
 * after v40 expand, v40 is heavy (fts rebuild + VACUUM), v32 breaks older readers.
 */
import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './store.js'

const dirs: string[] = []
function currentStore(): string {
  const d = mkdtempSync(join(tmpdir(), 'cc-store-swap-'))
  dirs.push(d)
  const file = join(d, 'store.db')
  const s = new Store(file)
  s.addProject({ id: 'p1', path: '/tmp/p1', name: 'p1' })
  s.close()
  return file
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function raw<T>(file: string, f: (db: Database.Database) => T): T {
  const db = new Database(file)
  try {
    return f(db)
  } finally {
    db.close()
  }
}
const setting = (file: string, key: string) =>
  raw(file, (db) => (db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key) as { value: string } | undefined)?.value)

const KNOWN = new Store().latestKnownVersion

describe('migrations during a host swap (#280 step 3)', () => {
  it('runs the expand steps now and leaves a heavy step for after the swap', () => {
    const file = currentStore()
    raw(file, (db) => db.pragma('user_version = 38'))

    const s = new Store(file, { swap: true })
    expect(s.migrationsRun).toBe(KNOWN - 38 - 1)
    expect(s.schemaVersion).toBe(KNOWN)
    expect(s.deferredSteps).toEqual([40])
    // The host works on the expanded store before the heavy step has run
    expect(s.listProjects().map((p) => p.id)).toEqual(['p1'])

    expect(s.runDeferred()).toBe(1)
    expect(s.deferredSteps).toEqual([])
    s.close()
    expect(setting(file, 'deferred_migrations')).toBeUndefined()
  })

  it('a breaking step waits too, and min_reader_version only rises once it runs', () => {
    const file = currentStore()
    raw(file, (db) => {
      db.pragma('user_version = 31')
      db.prepare(`UPDATE app_settings SET value = '28' WHERE key = 'min_reader_version'`).run()
    })

    const s = new Store(file, { swap: true })
    expect(s.deferredSteps).toContain(32)
    // The previous build (which knows up to v31) can still be started on this store
    expect(s.minReaderVersion).toBe(28)

    s.runDeferred()
    expect(s.minReaderVersion).toBe(32)
    s.close()
  })

  it('a host that died before running the deferred steps leaves them to the next open, which runs them', () => {
    const file = currentStore()
    raw(file, (db) => db.pragma('user_version = 38'))
    new Store(file, { swap: true }).close()
    expect(setting(file, 'deferred_migrations')).toBe('[40]')

    const next = new Store(file)
    expect(next.migrationsRun).toBe(1)
    expect(next.deferredSteps).toEqual([])
    next.close()
  })

  it('an ordinary open runs every pending step at once, heavy ones included', () => {
    const file = currentStore()
    raw(file, (db) => db.pragma('user_version = 38'))
    const s = new Store(file)
    expect(s.migrationsRun).toBe(KNOWN - 38)
    expect(s.deferredSteps).toEqual([])
    s.close()
  })

  it('inspect reports what would run without writing to the store', () => {
    const file = currentStore()
    raw(file, (db) => db.pragma('user_version = 38'))
    const before = raw(file, (db) => db.pragma('data_version', { simple: true }))

    const seen = Store.inspect(file)
    expect(seen.exists).toBe(true)
    expect(seen.userVersion).toBe(38)
    expect(seen.tooNew).toBeNull()
    expect(seen.pending.map((p) => p.to)).toEqual(Array.from({ length: KNOWN - 38 }, (_, i) => 39 + i))
    expect(seen.pending.find((p) => p.to === 40)).toMatchObject({ heavy: true, breaksOlderReaders: false })
    // Still at 38: nothing ran
    expect(raw(file, (db) => db.pragma('user_version', { simple: true }))).toBe(38)
    expect(raw(file, (db) => db.pragma('data_version', { simple: true }))).toBe(before)
  })

  it('inspect names a store this host cannot read, so the swap is refused before anything stops', () => {
    const file = currentStore()
    raw(file, (db) => db.prepare(`UPDATE app_settings SET value = ? WHERE key = 'min_reader_version'`).run(String(KNOWN + 1)))
    const seen = Store.inspect(file)
    expect(seen.tooNew).toContain('written by a newer Centralu')
  })

  it('inspect of a store that does not exist yet says so', () => {
    expect(Store.inspect(join(tmpdir(), 'cc-no-such-store', 'store.db')).exists).toBe(false)
  })
})
