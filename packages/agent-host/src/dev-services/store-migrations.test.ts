/**
 * Every migration step, run from the oldest store this host opens (v27, #1143) to the newest (#428).
 *
 * The step list is moved around as the store is split into modules, and a moved step that is dropped, doubled or put
 * out of order still compiles and still passes a test that looks at one column. So this one looks at all of it: it
 * loads a v27 store with rows in it (`store-fixtures/v27.sql`), opens it with the current `Store`, and compares what
 * comes out with a file written by the code before the split, which ran every step from v1: the whole of
 * `sqlite_master` (the SQL text of every table, index and virtual table, whitespace included), the rows of every
 * table, `user_version`, the host's `app_settings`, and the list of steps with their flags.
 *
 * The file is `store-migrations.golden.json`. Changing it is not a cleanup: a new step adds its lines, and an
 * existing step's lines changing means a store somebody already has is migrated differently from now on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from './store.js'

const dirs: string[] = []
function dir(): string {
  const d = mkdtempSync(join(tmpdir(), 'cc-store-migrations-'))
  dirs.push(d)
  return d
}
beforeEach(() => {
  // Steps stamp rows with `Date.now()` (v21 used to, and others still can): the golden file must not depend on the day
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-01-02T03:04:05Z'))
})
afterEach(() => {
  vi.useRealTimers()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/**
 * The oldest store this host opens (#1143): the v1 store this test used to build by hand (the DDL of the first commit of
 * `schema.sql`, with rows for the steps that rewrite data), migrated to v27 by the build that still had the steps
 * before it, and kept as SQL with every rowid
 */
function v27Store(): string {
  const file = join(dir(), 'store.db')
  const db = new Database(file)
  db.exec(readFileSync(fileURLToPath(new URL('./store-fixtures/v27.sql', import.meta.url)), 'utf8'))
  db.close()
  return file
}

type Row = Record<string, unknown>
type Dump = {
  userVersion: unknown
  master: { type: string; name: string }[]
  indexes: unknown[]
  tables: Record<string, { columns: string[] }>
}

/** Everything about the file that a step can change, in an order that does not depend on how it was reached */
function dump(file: string): unknown {
  const db = new Database(file, { readonly: true })
  try {
    const master = db
      .prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name`)
      .all() as { type: string; name: string; tbl_name: string; sql: string | null }[]
    const tables: Record<string, { columns: string[]; rows: Row[] }> = {}
    for (const t of master.filter((m) => m.type === 'table' && !m.name.startsWith('sqlite_') && !/^messages_fts_/.test(m.name))) {
      const info = db.pragma(`table_info("${t.name}")`) as { name: string; type: string; notnull: number; dflt_value: unknown; pk: number }[]
      const columns = info.map((c) => `${c.name} ${c.type} notnull=${c.notnull} default=${String(c.dflt_value)} pk=${c.pk}`)
      const virtual = /^CREATE VIRTUAL TABLE/i.test(t.sql ?? '')
      const order = virtual ? 'rowid' : info.map((c) => `"${c.name}"`).join(', ')
      const rows = db.prepare(`SELECT ${virtual ? 'rowid AS _rowid, ' : ''}* FROM "${t.name}" ORDER BY ${order}`).all() as Row[]
      tables[t.name] = { columns, rows: rows.map((r) => JSON.parse(JSON.stringify(r)) as Row) }
    }
    return {
      userVersion: db.pragma('user_version', { simple: true }),
      master,
      indexes: master
        .filter((m) => m.type === 'index' && m.sql)
        .map((m) => ({ name: m.name, list: db.pragma(`index_info("${m.name}")`) })),
      foreignKeys: Object.fromEntries(
        master.filter((m) => m.type === 'table' && !m.name.startsWith('sqlite_')).map((m) => [m.name, db.pragma(`foreign_key_list("${m.name}")`)]),
      ),
      tables,
    }
  } finally {
    db.close()
  }
}

type Step = { to: number; breaksOlderReaders: boolean; heavy?: true }
const stepList = (): Step[] =>
  (new Store() as unknown as { migrationSteps(): Step[] })
    .migrationSteps()
    .map(({ to, breaksOlderReaders, heavy }) => ({ to, breaksOlderReaders, heavy }))

describe('the whole migration list, from the oldest store this host opens to the newest', () => {
  it('turns a v27 store into exactly the store the list produced before it was split into modules', async () => {
    const file = v27Store()
    const store = new Store(file)
    const ran = store.migrationsRun
    const version = store.schemaVersion
    store.close()
    expect(ran).toBe(version - 27)

    await expect(JSON.stringify({ steps: stepList(), version, ran, store: dump(file) }, null, 1) + '\n').toMatchFileSnapshot(
      './store-migrations.golden.json',
    )
  })

  it('a swap leaves the same steps for later as before, and the store they end in is the same', async () => {
    const file = v27Store()
    const swapped = new Store(file, { swap: true })
    const deferred = swapped.deferredSteps
    const mid = { version: swapped.schemaVersion, deferred, minReader: swapped.minReaderVersion }
    expect(deferred.length).toBeGreaterThan(3)
    expect(swapped.runDeferred()).toBe(deferred.length)
    swapped.close()

    // Not equal to a plain open's store: a step that runs after later steps adds its column after theirs (v33's `trusted`)
    const { master, userVersion } = dump(file) as { master: unknown; userVersion: number }
    await expect(JSON.stringify({ mid, userVersion, master }, null, 1) + '\n').toMatchFileSnapshot(
      './store-migrations-swap.golden.json',
    )
  })

  it('builds a new store exactly as the build before the v27 baseline did (#1143)', async () => {
    const file = join(dir(), 'store.db')
    new Store(file).close()
    const made = dump(file) as Dump
    await expect(JSON.stringify(made, null, 1) + '\n').toMatchFileSnapshot('./store-new.golden.json')

    // The same tables, columns and indexes as a store migrated from v1; only the order of columns an ALTER added differs
    const migrated = (JSON.parse(readFileSync(new URL('./store-migrations.golden.json', import.meta.url), 'utf8')) as { store: Dump }).store
    const shape = (d: Dump) => ({
      userVersion: d.userVersion,
      objects: d.master.map((m) => `${m.type} ${m.name}`),
      columns: Object.fromEntries(Object.entries(d.tables).map(([t, v]) => [t, [...v.columns].sort()])),
      indexes: d.indexes,
    })
    expect(shape(made)).toEqual(shape(migrated))
  })
})
