/**
 * Every migration step, run from the oldest schema there was to the newest (#428).
 *
 * The step list is moved around as the store is split into modules, and a moved step that is dropped, doubled or put
 * out of order still compiles and still passes a test that looks at one column. So this one looks at all of it: it
 * builds the v1 schema by hand (the DDL the first commit of `schema.sql` had) with rows in it, opens it with the
 * current `Store`, and compares what comes out with a file written by the code before the split: the whole of
 * `sqlite_master` (the SQL text of every table, index and virtual table, whitespace included), the rows of every
 * table, `user_version`, the host's `app_settings`, and the list of steps with their flags.
 *
 * The file is `store-migrations.golden.json`. Changing it is not a cleanup: a new step adds its lines, and an
 * existing step's lines changing means a store somebody already has is migrated differently from now on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

/** The v1 schema as `schema.sql` had it in its first commit, plus rows for the steps that rewrite data */
function v1Store(): string {
  const file = join(dir(), 'store.db')
  const db = new Database(file)
  db.exec(`
    CREATE TABLE projects (
      id            TEXT PRIMARY KEY,
      path          TEXT NOT NULL UNIQUE,
      name          TEXT NOT NULL,
      default_tool  TEXT NOT NULL DEFAULT 'claude',
      default_model TEXT,
      sidebar_order INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL
    );
    CREATE TABLE sessions (
      id            TEXT PRIMARY KEY,
      project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      tool          TEXT NOT NULL,
      external_id   TEXT,
      name          TEXT NOT NULL,
      auto_named    INTEGER NOT NULL DEFAULT 1,
      state         TEXT NOT NULL DEFAULT 'idle',
      archived      INTEGER NOT NULL DEFAULT 0,
      is_orchestrator INTEGER NOT NULL DEFAULT 0,
      last_read_seq INTEGER NOT NULL DEFAULT 0,
      waiting_since INTEGER,
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX idx_sessions_project ON sessions(project_id, archived);
    CREATE TABLE messages (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      seq        INTEGER NOT NULL,
      role       TEXT NOT NULL,
      kind       TEXT NOT NULL,
      payload    TEXT NOT NULL,
      ts         INTEGER NOT NULL,
      PRIMARY KEY (session_id, seq)
    );
    CREATE TABLE approval_rules (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      scope      TEXT NOT NULL,
      project_id TEXT,
      session_id TEXT,
      matcher    TEXT NOT NULL,
      decision   TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE usage_facts (
      date       TEXT NOT NULL,
      tool       TEXT NOT NULL,
      model      TEXT NOT NULL,
      project_id TEXT,
      input_tokens  INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_tokens  INTEGER NOT NULL DEFAULT 0,
      cost_est   REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (date, tool, model, project_id)
    );
    CREATE TABLE workspace (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      layout     TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    PRAGMA user_version = 1;
  `)
  db.exec(`
    INSERT INTO projects (id, path, name, default_model, sidebar_order, created_at) VALUES
      ('p1', '/work/p1', 'one', 'opus', 1, 100), ('p2', '/work/p2', 'two', NULL, 0, 200);
    INSERT INTO sessions (id, project_id, tool, external_id, name, auto_named, state, archived, is_orchestrator, last_read_seq, created_at) VALUES
      ('s1', 'p1', 'claude', 'ext-1', 'first', 1, 'idle', 0, 0, 2, 300),
      ('s2', 'p1', 'codex', NULL, 'archived one', 0, 'idle', 1, 0, 0, 400),
      ('orc', 'p2', 'claude', NULL, 'orchestrator', 0, 'idle', 0, 1, 0, 500);
    INSERT INTO messages (session_id, seq, role, kind, payload, ts) VALUES
      ('s1', 1, 'user', 'text', '{"text":"hello there"}', 1),
      ('s1', 2, 'assistant', 'text', '{"text":"one "}', 2),
      ('s1', 3, 'assistant', 'text', '{"text":"token "}', 3),
      ('s1', 4, 'assistant', 'text', '{"text":"per row"}', 4),
      ('s1', 5, 'assistant', 'reasoning', '{"text":"thinking "}', 5),
      ('s1', 6, 'assistant', 'reasoning', '{"text":"hard"}', 6),
      ('s1', 7, 'assistant', 'tool_call', '{"id":"t1","name":"Bash","input":{"command":"ls"}}', 7),
      ('s1', 8, 'user', 'text', '{"text":"승인을 기다립니다"}', 8),
      ('s2', 1, 'user', 'text', '{"text":"archived words"}', 9);
    INSERT INTO approval_rules (scope, project_id, session_id, matcher, decision, created_at) VALUES
      ('project', 'p1', NULL, 'Bash(ls)', 'allow', 10), ('session', NULL, 's1', 'Bash(rm *)', 'deny', 11);
    INSERT INTO usage_facts (date, tool, model, project_id, input_tokens, output_tokens) VALUES ('2026-01-01', 'claude', 'opus', 'p1', 5, 6);
    INSERT INTO workspace (id, layout, updated_at) VALUES (1, '{"panes":[]}', 12);
  `)
  db.close()
  return file
}

type Row = Record<string, unknown>

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

type Step = { to: number; breaksOlderReaders: boolean; heavy?: true; ownTransaction?: true }
const stepList = (): Step[] =>
  (new Store() as unknown as { migrationSteps(): Step[] })
    .migrationSteps()
    .map(({ to, breaksOlderReaders, heavy, ownTransaction }) => ({ to, breaksOlderReaders, heavy, ownTransaction }))

describe('the whole migration list, from v1 to the newest', () => {
  it('turns a v1 store into exactly the store the list produced before it was split into modules', async () => {
    const file = v1Store()
    const store = new Store(file)
    const ran = store.migrationsRun
    const version = store.schemaVersion
    store.close()
    // Every step of the list ran. Not `version - 1`: a number can be held for a step that lands later (v58, #1134)
    expect(ran).toBe(stepList().length)

    await expect(JSON.stringify({ steps: stepList(), version, ran, store: dump(file) }, null, 1) + '\n').toMatchFileSnapshot(
      './store-migrations.golden.json',
    )
  })

  it('a swap leaves the same steps for later as before, and the store they end in is the same', async () => {
    const file = v1Store()
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
})
