import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { guardPassFor } from './lint-allowlist.js'
import { SLOW } from './test-timing.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

describe('the type-assertion ceilings', () => {
  // The function tooling/lint.ts calls (guardPassFor), on a copy of a package in a temp folder: nothing is written into the
  // repository, so a killed run leaves nothing for another run to count
  it('hold a package to its ceiling over every file of it, also when the run names one file (pre-pr lints only the changed files)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-ceiling-'))
    try {
      const src = join(dir, 'packages', 'protocol', 'src')
      mkdirSync(src, { recursive: true })
      writeFileSync(join(src, 'a.ts'), 'export const a = 1 as number\n')
      writeFileSync(join(src, 'b.ts'), 'export const b = 2 as number\n')
      const run = await guardPassFor(dir, ['packages/protocol/src/a.ts'], ROOT)
      expect(run.totals).toEqual({ 'packages/protocol': 2 })
      expect(run.over).toEqual(['packages/protocol: 2, ceiling 0'])
      // The counting messages are not findings: nothing is shown for the named file
      expect(run.shown.map((r) => relative(dir, r.filePath))).toEqual([])
      expect((await guardPassFor(dir, [], ROOT)).totals).toEqual({ 'packages/protocol': 2 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000 * SLOW)
})
