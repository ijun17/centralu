import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ASSERTIONS, assertionTotals, guardRun, overAndUnder } from './lint-allowlist.js'
import { SLOW } from './test-timing.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

describe('the type-assertion ceilings', () => {
  // The same functions tooling/lint.ts runs (guardRun, assertionTotals, overAndUnder), on a copy of a package in a temp folder:
  // nothing is written into the repository, so a killed run leaves nothing for another run to count
  it('hold a package to its ceiling over every file of it, as the whole run does', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-ceiling-'))
    try {
      mkdirSync(join(dir, 'packages', 'protocol', 'src'), { recursive: true })
      writeFileSync(join(dir, 'packages', 'protocol', 'src', 'probe.ts'), 'export const probe = 1 as number\n')
      const totals = assertionTotals(dir, await guardRun(dir, ROOT))
      expect(totals).toEqual({ 'packages/protocol': 1 })
      expect(overAndUnder(totals, ASSERTIONS).over).toEqual(['packages/protocol: 1, ceiling 0'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000 * SLOW)
})
