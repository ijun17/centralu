/**
 * How the store survives being stopped at a bad moment and keeps its files small (#396).
 *
 * Real files in a temporary folder throughout: an in-memory database has no WAL and no second connection.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Store } from './store.js'
import { SLOW } from '../../../../tooling/test-timing.js'

const dirs: string[] = []
function storeFile(): string {
  const d = mkdtempSync(join(tmpdir(), 'cc-store-durable-'))
  dirs.push(d)
  const file = join(d, 'store.db')
  const s = new Store(file)
  s.addProject({ id: 'p1', path: '/tmp/p1', name: 'p1' })
  s.close()
  return file
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

function raw<T>(file: string, f: (db: Database.Database) => T): T {
  const db = new Database(file)
  try {
    return f(db)
  } finally {
    db.close()
  }
}
const columns = (file: string) =>
  raw(file, (db) => (db.pragma('table_info(projects)') as { name: string }[]).map((c) => c.name))

type Step = { to: number; breaksOlderReaders: boolean; run: () => void }

describe('a migration step is one unit with the record that it ran', () => {
  it('a step that fails half way leaves neither its first change nor the new version', () => {
    const file = storeFile()
    const version = raw(file, (db) => db.pragma('user_version', { simple: true }) as number)
    const proto = Store.prototype as unknown as { migrationSteps: () => Step[] }
    const real = proto.migrationSteps
    vi.spyOn(proto, 'migrationSteps').mockImplementation(function (this: { db: Database.Database }) {
      const steps = real.call(this)
      return [
        ...steps,
        {
          to: version + 1,
          breaksOlderReaders: false,
          run: () => {
            // Two changes, and the host is stopped between them
            this.db.exec('ALTER TABLE projects ADD COLUMN half_a TEXT')
            throw new Error('stopped here')
          },
        },
      ]
    })

    expect(() => new Store(file)).toThrow('stopped here')

    expect(columns(file)).not.toContain('half_a')
    expect(raw(file, (db) => db.pragma('user_version', { simple: true }))).toBe(version)
  })
})

/*
 * A step's VACUUM runs after the step has committed, so a host killed during it finds no step left to run. The kill is a
 * real one: a separate process opens the store and SIGKILLs itself the moment v40 starts its vacuum.
 */
describe('a vacuum cut off by a kill is still owed', () => {
  const storeModule = pathToFileURL(fileURLToPath(new URL('./store.ts', import.meta.url))).href
  const root = fileURLToPath(new URL('../../../../', import.meta.url))

  /** A current store with v40 pending and 24 MB free in the file, past the 16 MB at which v40 vacuums */
  function storeWithFreePages(): string {
    const file = storeFile()
    raw(file, (db) => {
      db.exec(`CREATE TABLE junk (b BLOB)`)
      db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 24)
               INSERT INTO junk SELECT zeroblob(1048576) FROM n`)
      db.exec(`DROP TABLE junk`)
      db.pragma('user_version = 39')
      db.pragma('wal_checkpoint(TRUNCATE)')
    })
    return file
  }
  const freePages = (file: string) => raw(file, (db) => db.pragma('freelist_count', { simple: true }) as number)
  const owed = (file: string) =>
    raw(file, (db) => db.prepare(`SELECT 1 FROM app_settings WHERE key = 'vacuum_owed'`).get() !== undefined)

  async function openAndDieAtVacuum(file: string, swap: boolean): Promise<void> {
    const script = join(dirname(file), 'die-at-vacuum.mts')
    writeFileSync(
      script,
      `import { createRequire } from 'node:module'
import { writeSync } from 'node:fs'
const { Store } = await import(${JSON.stringify(storeModule)})
const Database = createRequire(${JSON.stringify(storeModule)})('better-sqlite3')
const exec = Database.prototype.exec
Database.prototype.exec = function (sql) {
  if (sql === 'VACUUM') {
    writeSync(1, 'killed at the vacuum\\n')
    process.kill(process.pid, 'SIGKILL')
  }
  return exec.call(this, sql)
}
const s = new Store(${JSON.stringify(file)}, { swap: ${swap} })
if (${swap}) s.runDeferred()
writeSync(1, 'survived\\n')
`,
    )
    /*
     * Not spawnSync (#368): starting tsx and a store took most of the test's 15 s on a loaded windows-2022 runner, and
     * a synchronous wait holds the worker, which answers nothing meanwhile (vitest gives up on its own messages at 60 s).
     */
    const stdout = await new Promise<string>((resolve) => {
      execFile(process.execPath, ['--import', 'tsx', script], { cwd: root, timeout: 60_000 * SLOW }, (_err, out) => resolve(String(out)))
    })
    // Not the signal: on Windows a SIGKILL ends the process with an exit code and no signal
    expect(stdout).toBe('killed at the vacuum\n')
  }

  // A Node with tsx started, and a store opened and migrated in it: seconds on a loaded Windows runner
  it('the next open vacuums', { timeout: 60_000 * SLOW }, async () => {
    const file = storeWithFreePages()
    await openAndDieAtVacuum(file, false)
    // v40 committed; its vacuum did not happen
    expect(raw(file, (db) => db.pragma('user_version', { simple: true }))).toBe(40)
    expect(freePages(file)).toBeGreaterThan(0)
    expect(owed(file)).toBe(true)

    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    const s = new Store(file)
    expect(s.migrationsRun).toBe(s.latestKnownVersion - 40) // the steps after v40; v40 itself is not run again
    s.close()
    expect(freePages(file)).toBe(0)
    expect(owed(file)).toBe(false)
    expect(said.mock.calls.some(([line]) => String(line).includes('left it owed'))).toBe(true)
  })

  it('in a swap, the steps left for later are run with it, not the open', { timeout: 60_000 * SLOW }, async () => {
    const file = storeWithFreePages()
    await openAndDieAtVacuum(file, true)
    expect(owed(file)).toBe(true)

    vi.spyOn(console, 'error').mockImplementation(() => {})
    const s = new Store(file, { swap: true })
    expect(s.deferredSteps).toEqual([])
    expect(s.vacuumOwed).toBe(true)
    expect(freePages(file)).toBeGreaterThan(0)

    s.runDeferred()
    expect(s.vacuumOwed).toBe(false)
    s.close()
    expect(freePages(file)).toBe(0)
  })
})

describe('the WAL', () => {
  it('is folded once the steps a swap left for later have run', () => {
    const file = storeFile()
    raw(file, (db) => db.pragma('user_version = 38'))
    const s = new Store(file, { swap: true })
    expect(s.deferredSteps).toEqual([40])

    s.runDeferred()

    expect(statSync(`${file}-wal`).size).toBe(0)
    s.close()
  })

  /*
   * "Without waiting" means not waiting out the busy timeout. With the store's own 5 s the bound had to sit between a
   * slow runner and 5 s (1,078 ms seen on Windows against 1,000 first, then 2,500): load alone could cross it. The
   * busy timeout is set to 20 s here, so a checkpoint that waits takes 20 s and one that does not is far under the
   * 10 s bound however loaded the machine is (#845). The test's own limit lets a waiting one end and be reported.
   */
  const BUSY_MS = 20_000
  it('a checkpoint with another connection reading reports it did not fold, without waiting', () => {
    const file = storeFile()
    const s = new Store(file)
    const reader = new Database(file, { readonly: true })
    try {
      s.addProject({ id: 'p2', path: '/tmp/p2', name: 'p2' })
      const db = (s as unknown as { db: Database.Database }).db
      db.pragma(`busy_timeout = ${BUSY_MS}`)
      reader.exec('BEGIN')
      reader.prepare('SELECT COUNT(*) FROM projects').get()
      const t0 = Date.now()
      expect(s.checkpoint()).toBe(false)
      expect(Date.now() - t0).toBeLessThan(BUSY_MS / 2)
      /*
       * The checkpoint drops the wait to 0 for itself and puts back whatever the connection had, here 20 s rather than
       * the store's 5 s: a checkpoint that left 0, or reset it to the store's default, would fail this. With the restore
       * taken out of Store.checkpoint it does (expected +0 to be 20000).
       */
      expect(db.pragma('busy_timeout', { simple: true })).toBe(BUSY_MS)
      reader.exec('COMMIT')
      reader.close()
      expect(s.checkpoint()).toBe(true)
      expect(statSync(`${file}-wal`).size).toBe(0)
    } finally {
      // Both closed whatever failed: Windows cannot remove the folder while either holds the file
      if (reader.open) reader.close()
      s.close()
    }
  }, (BUSY_MS + 10_000) * SLOW)

  it('a checkpoint or a second close on a closed store does nothing rather than throw', () => {
    const s = new Store(storeFile())
    s.close()
    expect(s.checkpoint()).toBe(false)
    expect(() => s.close()).not.toThrow()
  })

  it('the settings a file store depends on are set by the store itself', () => {
    const file = storeFile()
    const s = new Store(file)
    const db = (s as unknown as { db: Database.Database }).db
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    // FULL (2): NORMAL can lose the last commits on power loss, and those are conversations
    expect(db.pragma('synchronous', { simple: true })).toBe(2)
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000)
    expect(db.pragma('journal_size_limit', { simple: true })).toBe(64 * 1024 * 1024)
    s.close()
  })
})
