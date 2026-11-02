import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SLOW } from './test-timing.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

describe('pnpm lint <paths>', () => {
  it('holds a package to its type-assertion ceiling, as the whole run does (pre-pr lints only the changed files)', () => {
    const file = join(ROOT, 'packages', 'protocol', 'src', `zz-ceiling-probe-${process.pid}.ts`)
    writeFileSync(file, 'export const probe = 1 as number\n')
    try {
      const r = spawnSync(process.execPath, ['--import', 'tsx', 'tooling/lint.ts', relative(ROOT, file).split(sep).join('/')], { cwd: ROOT, encoding: 'utf8' })
      expect(`${r.stdout}${r.stderr}`).toContain('packages/protocol: 1, ceiling 0 type assertions')
      expect(r.status).toBe(1)
    } finally {
      rmSync(file, { force: true })
    }
  }, 120_000 * SLOW)
})
