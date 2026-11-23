/**
 * Step 78 (#2481): `grid_panels` dropped, and the "always allow" rules ending in `*` (#838) deleted once, where every start deleted them
 * before. The build of v77 is this build's `Store` with step 78 left out.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { Store } from './store.js'
import type { MigrationStep } from './store/migrations/context.js'

let newest = 78

class Build extends Store {
  protected override migrationSteps(): MigrationStep[] {
    return super.migrationSteps().filter((s) => s.to <= newest)
  }

  get raw(): Database.Database {
    return this.db
  }

  upgrade(to: number): void {
    newest = to
    try {
      this.migrate()
    } finally {
      newest = 78
    }
  }
}

function open(version: number): Build {
  newest = version
  try {
    return new Build()
  } finally {
    newest = 78
  }
}

const stores: Build[] = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
})

const tables = (db: Database.Database) =>
  db.prepare<unknown[], { name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((r) => r.name)

describe('store step 78', () => {
  it('drops grid_panels and the rules ending in *, and keeps every other rule', () => {
    const before = open(77)
    stores.push(before)
    // The table a store of v47 and earlier carried, as step 47 left it
    before.raw.exec(`CREATE TABLE IF NOT EXISTS grid_panels (session_id TEXT PRIMARY KEY, position INTEGER NOT NULL)`)
    for (const matcher of ['cat logs/*', 'git status', 'npm run *'])
      before.permissions.addApprovalRule({ scope: 'global', matcher, decision: 'allow' })
    before.upgrade(78)
    expect(tables(before.raw)).not.toContain('grid_panels')
    expect(before.permissions.listApprovalRules().map((r) => r.matcher)).toEqual(['git status'])
  })
})
