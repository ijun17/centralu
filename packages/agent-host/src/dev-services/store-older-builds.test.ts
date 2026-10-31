/**
 * Stores written by older builds open in this one with everything in them (#845).
 *
 * `store-migrations.test.ts` runs the whole list from a v27 store made from a v1 one, which holds only what v1 had: every
 * column, table and kind of row added later reaches the later steps empty, so a step that rewrites one of them
 * (v40 takes tool calls out of the search index) never meets a row there. The stores here were written by the
 * builds that had v39 and v47 as their newest step, through their own `Store` API, and kept as SQL in
 * `store-fixtures/` (`scripts/write-store-fixture.mts` says how; a fixture is never edited by hand). Each is opened with this
 * build and read back through today's API.
 */
import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from './store.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A store file holding what the build at `version` wrote */
function olderStore(version: number): string {
  const d = mkdtempSync(join(tmpdir(), 'cc-store-older-'))
  dirs.push(d)
  const file = join(d, 'store.db')
  const db = new Database(file)
  db.exec(readFileSync(fileURLToPath(new URL(`./store-fixtures/v${version}.sql`, import.meta.url)), 'utf8'))
  db.close()
  return file
}

const LATEST = new Store().latestKnownVersion

describe.each([39, 47])('a store the v%i build wrote', (version) => {
  it('migrates to the newest schema and keeps its projects, sessions, conversation and rules', () => {
    const file = olderStore(version)
    const store = new Store(file)
    try {
      expect(store.schemaVersion).toBe(LATEST)
      expect(store.migrationsRun).toBe(LATEST - version)

      expect(store.projects.listProjects()).toEqual([expect.objectContaining({ id: 'p1', path: '/tmp/p1', name: 'alpha' })])
      const sessions = store.sessions.listSessions()
      expect(sessions.map((s) => s.id).sort()).toEqual(['s1', 's2'])
      expect(sessions.find((s) => s.id === 's1')).toMatchObject({
        projectId: 'p1',
        tool: 'claude',
        externalId: 'ext-s1',
        name: `seeded at v${version}`,
        autoNamed: false,
        lastReadSeq: 2,
        model: 'opus',
        permissionPreset: 'normal',
      })

      expect(store.messages.loadMessages('s1').map((m) => [m.seq, m.role, m.kind, m.payload])).toEqual([
        [1, 'user', 'text', { type: 'user_message', sessionId: 's1', text: 'find the galaxy colour policy' }],
        [2, 'assistant', 'text', { type: 'message_delta', sessionId: 's1', role: 'assistant', text: 'the galaxy colour policy lives in docs' }],
        [3, 'system', 'tool_call', { type: 'tool_call', sessionId: 's1', callId: 'c1', summary: { tool: 'Read', title: 'Read: docs/colour.md', paths: ['docs/colour.md'] } }],
        [4, 'system', 'tool_result', { type: 'tool_result', sessionId: 's1', callId: 'c1', ok: true, summary: 'nebula purple is the default' }],
        [5, 'assistant', 'text', { type: 'message_delta', sessionId: 's1', role: 'assistant', text: 'done reading' }],
      ])
      expect(store.messages.loadMessages('s2').map((m) => m.payload)).toEqual([{ type: 'user_message', sessionId: 's2', text: 'hello second' }])

      // The search index holds what was said, and since v40 no tool call, whichever build indexed the row
      expect(store.messages.searchMessages('galaxy colour').map((h) => [h.sessionId, h.seq])).toEqual(
        expect.arrayContaining([['s1', 1], ['s1', 2]]),
      )
      expect(store.messages.searchMessages('galaxy colour')).toHaveLength(2)
      expect(store.messages.searchMessages('docs/colour.md')).toEqual([])

      expect(store.permissions.listApprovalRules()).toEqual([expect.objectContaining({ scope: 'project', projectId: 'p1', matcher: 'npm test', decision: 'allow' })])
    } finally {
      store.close()
    }

    // And it is done: the next open runs nothing
    const again = new Store(file)
    expect(again.migrationsRun).toBe(0)
    again.close()
  })

  it('has no usage_facts table afterwards: the fixture has it, v56 drops it (#423)', () => {
    const file = olderStore(version)
    const tables = (path: string) => {
      const db = new Database(path)
      try {
        return (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((t) => t.name)
      } finally {
        db.close()
      }
    }
    expect(tables(file)).toContain('usage_facts')
    new Store(file).close()
    expect(tables(file)).not.toContain('usage_facts')
  })
})
