/**
 * Writes a store through the `Store` API of the checkout given as the argument, and prints it as SQL (#845).
 *
 * How `v39.sql` and `v47.sql` were made, from the last commit whose newest step was that version
 * (759b802a, 58cc91d4):
 *
 *   git worktree add --detach /tmp/old <commit>
 *   (cd /tmp/old && pnpm install --frozen-lockfile)
 *   cp packages/agent-host/scripts/write-store-fixture.mts /tmp/old/packages/agent-host/
 *   (cd /tmp/old/packages/agent-host && pnpm exec tsx write-store-fixture.mts /tmp/old) > packages/agent-host/src/dev-services/store-fixtures/v<N>.sql
 *   git worktree remove --force /tmp/old
 *
 * Give the old checkout its own install. node_modules linked in from this checkout is not ignored as a link
 * (`node_modules/` matches folders only), so it gets committed, and checking that commit out replaces this
 * checkout's real node_modules with a link to itself.
 *
 * The tables and their rows come first and the indexes and triggers after, so loading the file does not index a
 * row twice. A virtual table's own shadow tables are left to its CREATE.
 */
import Database from 'better-sqlite3'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.argv[2]!
process.env.CC_DATA_DIR = mkdtempSync(join(tmpdir(), 'cc-845-gen-data-'))
const { Store } = await import(join(root, 'packages/agent-host/src/dev-services/store.ts'))
const file = join(mkdtempSync(join(tmpdir(), 'cc-845-gen-')), 'store.db')
const s = new Store(file)
const version: number = s.schemaVersion
s.addProject({ id: 'p1', path: '/tmp/p1', name: 'alpha' })
const session = (id: string, name: string, lastReadSeq: number) => ({
  id, projectId: 'p1', kind: 'worker', tool: 'claude', externalId: `ext-${id}`, name, autoNamed: false, state: 'idle',
  archived: false, isOrchestrator: false, lastReadSeq, lastSeq: 0, createdAt: 1_700_000_000_000, waitingSince: null,
  live: false, model: 'opus', effort: null, verbosity: null, serviceTier: null, permissionPreset: 'normal',
  importedFrom: null, worktree: null, parentSessionId: null, scopeSessionIds: null, roleAppend: null, appId: null,
  goal: null, forkedFrom: null, askedBy: null, pendingQuestions: [], activity: null,
})
s.upsertSession(session('s1', `seeded at v${version}`, 2))
s.upsertSession(session('s2', 'second', 0))
const ts = 1_700_000_000_000
s.appendMessages([
  { sessionId: 's1', seq: 1, role: 'user', kind: 'text', payload: { type: 'user_message', sessionId: 's1', text: 'find the galaxy colour policy' }, ts },
  { sessionId: 's1', seq: 2, role: 'assistant', kind: 'text', payload: { type: 'message_delta', sessionId: 's1', role: 'assistant', text: 'the galaxy colour policy lives in docs' }, ts: ts + 1 },
  { sessionId: 's1', seq: 3, role: 'system', kind: 'tool_call', payload: { type: 'tool_call', sessionId: 's1', callId: 'c1', summary: { tool: 'Read', title: 'Read: docs/colour.md', paths: ['docs/colour.md'] } }, ts: ts + 2 },
  { sessionId: 's1', seq: 4, role: 'system', kind: 'tool_result', payload: { type: 'tool_result', sessionId: 's1', callId: 'c1', ok: true, summary: 'nebula purple is the default' }, ts: ts + 3 },
  { sessionId: 's1', seq: 5, role: 'assistant', kind: 'text', payload: { type: 'message_delta', sessionId: 's1', role: 'assistant', text: 'done reading' }, ts: ts + 4 },
  { sessionId: 's2', seq: 1, role: 'user', kind: 'text', payload: { type: 'user_message', sessionId: 's2', text: 'hello second' }, ts },
])
s.addApprovalRule({ scope: 'project', projectId: 'p1', matcher: 'npm test', decision: 'allow' })
s.close()

const db = new Database(file, { readonly: true })
const master = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid`).all() as { type: string; name: string; tbl_name: string; sql: string }[]
const virtual = master.filter((m) => m.type === 'table' && /^CREATE VIRTUAL TABLE/i.test(m.sql)).map((m) => m.name)
const shadow = (name: string) => virtual.some((v) => name.startsWith(`${v}_`))
const tables = master.filter((m) => m.type === 'table' && !m.name.startsWith('sqlite_') && !shadow(m.name))
const lit = (v: unknown): string =>
  v === null ? 'NULL' : typeof v === 'number' || typeof v === 'bigint' ? String(v) : Buffer.isBuffer(v) ? `X'${v.toString('hex')}'` : `'${String(v).replaceAll("'", "''")}'`
const out: string[] = [`-- A v${version} store, written through the Store API of the build that had v${version} as its newest step.`, '-- Generated once (#845); never edited by hand.']
for (const t of tables) out.push(`${t.sql};`)
for (const t of tables) {
  const isVirtual = virtual.includes(t.name)
  const rows = db.prepare(`SELECT ${isVirtual ? 'rowid AS rowid, ' : ''}* FROM "${t.name}"`).all() as Record<string, unknown>[]
  for (const r of rows) {
    const cols = Object.keys(r)
    out.push(`INSERT INTO "${t.name}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map((c) => lit(r[c])).join(', ')});`)
  }
}
for (const m of master) if (m.type === 'index' || m.type === 'trigger' || m.type === 'view') out.push(`${m.sql};`)
out.push(`PRAGMA user_version = ${db.pragma('user_version', { simple: true })};`)
db.close()
process.stdout.write(out.join('\n') + '\n')
