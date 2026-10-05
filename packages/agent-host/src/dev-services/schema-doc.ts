import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Store } from './store.js'

/**
 * The schema layer of the domain model (docs/generated/schema.md), read off a real store.
 *
 * The concept layer (docs/domain-model.md) is written by hand; the columns are not, because a hand-kept column list is
 * stale by the next migration. A fresh `Store` runs schema.sql and every migration step, exactly as a new install
 * does, and the document is whatever SQLite then says the tables are. A test renders it again and compares it with the
 * committed file, so a migration that changes the schema fails until the document is regenerated
 * (`pnpm docs:schema`).
 */

export type SchemaColumn = {
  name: string
  type: string
  notNull: boolean
  defaultValue: string | null
  /** Position in the primary key, 1-based; 0 when the column is not part of it */
  pk: number
  /** Where a new store first gets the column: 'schema.sql' or the migration step, `v<N>` */
  addedIn: string
}

export type SchemaForeignKey = { from: string; table: string; to: string; onDelete: string }

export type SchemaIndex = { name: string; unique: boolean; columns: string[] }

export type SchemaTable = {
  name: string
  /** True for an FTS5 or other virtual table */
  virtual: boolean
  addedIn: string
  columns: SchemaColumn[]
  foreignKeys: SchemaForeignKey[]
  indexes: SchemaIndex[]
}

export type Schema = { version: number; tables: SchemaTable[] }

type Db = Database.Database

/** What a store's private parts look like from here. The same reach `Store.inspect` takes into a probe */
type StoreInternals = {
  db: Db
  dbPath: string
  opts: object
  migrationsRun: number
  migrationSteps(): { to: number; run: () => void }[]
  writeMinReader(version: number): void
}

const SCHEMA_SQL = fileURLToPath(new URL('../../../protocol/src/schema/schema.sql', import.meta.url))

/** The tables SQLite keeps for itself or for a virtual table's storage, which nobody reads by name */
function isInternal(name: string, virtualNames: string[]): boolean {
  return name.startsWith('sqlite_') || virtualNames.some((v) => name.startsWith(`${v}_`))
}

function tableNames(db: Db): { name: string; virtual: boolean }[] {
  const rows = db
    .prepare(`SELECT name, sql FROM sqlite_schema WHERE type = 'table' ORDER BY name`)
    .all() as { name: string; sql: string | null }[]
  const virtualNames = rows.filter((r) => /^CREATE VIRTUAL TABLE/i.test(r.sql ?? '')).map((r) => r.name)
  return rows
    .filter((r) => !isInternal(r.name, virtualNames))
    .map((r) => ({ name: r.name, virtual: virtualNames.includes(r.name) }))
}

function columnsOf(db: Db, table: string): Omit<SchemaColumn, 'addedIn'>[] {
  const rows = db.prepare(`SELECT * FROM pragma_table_info(?) ORDER BY cid`).all(table) as {
    name: string
    type: string
    notnull: number
    dflt_value: string | null
    pk: number
  }[]
  return rows.map((r) => ({ name: r.name, type: r.type, notNull: r.notnull === 1, defaultValue: r.dflt_value, pk: r.pk }))
}

function foreignKeysOf(db: Db, table: string): SchemaForeignKey[] {
  const rows = db.prepare(`SELECT * FROM pragma_foreign_key_list(?) ORDER BY id, seq`).all(table) as {
    table: string
    from: string
    to: string | null
    on_delete: string
  }[]
  return rows.map((r) => ({ from: r.from, table: r.table, to: r.to ?? '(primary key)', onDelete: r.on_delete }))
}

function indexesOf(db: Db, table: string): SchemaIndex[] {
  // Only the indexes someone wrote: SQLite's own (`sqlite_autoindex_*`) are the primary key and UNIQUE columns again
  const rows = db
    .prepare(`SELECT name, "unique" AS uq FROM pragma_index_list(?) WHERE origin = 'c' ORDER BY name`)
    .all(table) as { name: string; uq: number }[]
  return rows.map((r) => ({
    name: r.name,
    unique: r.uq === 1,
    columns: (db.prepare(`SELECT name FROM pragma_index_info(?) ORDER BY seqno`).all(r.name) as { name: string | null }[]).map(
      (c) => c.name ?? '(expression)',
    ),
  }))
}

/** Table name → its column names, the part of a schema a step can add to */
function shape(db: Db): Map<string, string[]> {
  return new Map(tableNames(db).map((t) => [t.name, columnsOf(db, t.name).map((c) => c.name)]))
}

/**
 * Which step first gives a new store each table and column. The steps are replayed one at a time on an empty database,
 * the way a new install runs them, with a look at the tables after each. Of the runner's bookkeeping only its first
 * write runs: on a new store it records `min_reader_version` before any step, which is what creates `app_settings`
 * there (v16 names the table, and finds it in place).
 */
function provenance(): { tables: Map<string, string>; columns: Map<string, string>; final: Map<string, string[]> } {
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    const probe = Object.create(Store.prototype) as StoreInternals
    probe.db = db
    probe.dbPath = ':memory:'
    probe.opts = {}
    probe.migrationsRun = 0
    const tables = new Map<string, string>()
    const columns = new Map<string, string>()
    const note = (label: string) => {
      for (const [table, cols] of shape(db)) {
        if (!tables.has(table)) tables.set(table, label)
        for (const c of cols) if (!columns.has(`${table}.${c}`)) columns.set(`${table}.${c}`, label)
      }
    }
    db.exec(readFileSync(SCHEMA_SQL, 'utf8'))
    note('schema.sql')
    probe.writeMinReader(0)
    note('the migration runner')
    for (const step of probe.migrationSteps()) {
      step.run()
      note(`v${step.to}`)
    }
    return { tables, columns, final: shape(db) }
  } finally {
    db.close()
  }
}

/** The schema a new store ends up with, through the real `Store` constructor, so every migration has run */
export function readSchema(): Schema {
  const store = new Store(':memory:')
  try {
    const db = (store as unknown as StoreInternals).db
    const history = provenance()
    const tables = tableNames(db).map(({ name, virtual }): SchemaTable => ({
      name,
      virtual,
      addedIn: history.tables.get(name) ?? '?',
      columns: columnsOf(db, name).map((c) => ({ ...c, addedIn: history.columns.get(`${name}.${c.name}`) ?? '?' })),
      foreignKeys: foreignKeysOf(db, name),
      indexes: indexesOf(db, name),
    }))
    /*
     * The replay runs the step bodies without the constructor around them. If the two ever end up with different
     * tables, the "added in" column would be guessing, so this stops rather than print it.
     */
    const real = JSON.stringify(tables.map((t) => [t.name, t.columns.map((c) => c.name)]))
    const replayed = JSON.stringify([...history.final].sort(([a], [b]) => (a < b ? -1 : 1)))
    if (real !== replayed) {
      throw new Error(`schema-doc: replaying the steps gave a different schema than the Store\n real: ${real}\n replay: ${replayed}`)
    }
    return { version: db.pragma('user_version', { simple: true }) as number, tables }
  } finally {
    store.close()
  }
}

const cell = (s: string) => s.replace(/\|/g, '\\|')

/** Mermaid takes one word for a type; a virtual table's columns have none */
const erType = (t: string) => (t === '' ? 'ANY' : t.replace(/[^A-Za-z0-9_]/g, '_'))

function erDiagram(schema: Schema): string[] {
  const out = ['```mermaid', 'erDiagram']
  for (const t of schema.tables) {
    for (const fk of t.foreignKeys) {
      const col = t.columns.find((c) => c.name === fk.from)
      // A nullable reference may point at nothing; a NOT NULL or key column always points at one row
      const parent = col && (col.notNull || col.pk > 0) ? '||' : '|o'
      out.push(`  ${fk.table} ${parent}--o{ ${t.name} : "${fk.from}"`)
    }
  }
  for (const t of schema.tables) {
    out.push(`  ${t.name} {`)
    for (const c of t.columns) {
      const keys = [c.pk > 0 ? 'PK' : '', t.foreignKeys.some((f) => f.from === c.name) ? 'FK' : ''].filter(Boolean).join(', ')
      out.push(`    ${erType(c.type)} ${c.name}${keys ? ` ${keys}` : ''}`)
    }
    out.push('  }')
  }
  out.push('```')
  return out
}

function tableSection(t: SchemaTable): string[] {
  const out = [`### \`${t.name}\``, '']
  out.push(`${t.virtual ? 'Virtual table. ' : ''}Added in ${t.addedIn}.`, '')
  out.push('| Column | Type | Null | Default | Key | Added in |', '|---|---|---|---|---|---|')
  for (const c of t.columns) {
    const fk = t.foreignKeys.find((f) => f.from === c.name)
    const key = [
      c.pk > 0 ? (t.columns.filter((x) => x.pk > 0).length > 1 ? `PK ${c.pk}` : 'PK') : '',
      fk ? `FK → \`${fk.table}.${fk.to}\` (${fk.onDelete.toLowerCase()})` : '',
    ]
      .filter(Boolean)
      .join(', ')
    out.push(
      `| \`${c.name}\` | ${c.type || '—'} | ${c.notNull ? 'no' : 'yes'} | ${c.defaultValue === null ? '' : `\`${cell(c.defaultValue)}\``} | ${key} | ${c.addedIn} |`,
    )
  }
  if (t.indexes.length > 0) {
    out.push('', 'Indexes:', '')
    for (const i of t.indexes) out.push(`- \`${i.name}\`${i.unique ? ' (unique)' : ''}: ${i.columns.map((c) => `\`${c}\``).join(', ')}`)
  }
  out.push('')
  return out
}

export function renderSchemaDoc(schema: Schema = readSchema()): string {
  const lines = [
    '<!-- Generated by `pnpm docs:schema` (packages/agent-host/scripts/schema-doc.mts). Do not edit by hand. -->',
    '',
    '# Store schema',
    '',
    `The tables of the host's store (\`store.db\`) at schema version ${schema.version}, as a new store has them once`,
    'schema.sql and every migration step have run. Generated from a real `Store`',
    '(`packages/agent-host/src/dev-services/schema-doc.ts`); a test fails when this file and the migrations disagree.',
    '',
    'What the tables mean, and which concept each one stores, is in [the domain model](../domain-model.md).',
    'How a migration may change them is in [agent-host.md](../agent-host.md) and above `migrationSteps` in',
    '`packages/agent-host/src/dev-services/store.ts`.',
    '',
    '"Added in" is the first step that gives a new store the table or column: `schema.sql`, the migration runner',
    '(its own bookkeeping, before any step), or the migration step `v<N>`. A column that a step added to older stores',
    'and schema.sql now creates for new ones reads `schema.sql`.',
    'Only foreign keys the schema declares are drawn; references kept by convention (such as',
    '`approval_rules.session_id`) are described in the domain model.',
    '',
    '## Diagram',
    '',
    ...erDiagram(schema),
    '',
    '## Tables',
    '',
    ...schema.tables.flatMap(tableSection),
  ]
  return `${lines.join('\n').trimEnd()}\n`
}
