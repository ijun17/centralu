import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { SLOW } from './test-timing.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

describe('pnpm lint <paths>', () => {
  // Async: the run reads the whole repository (tens of seconds on a loaded runner), and a sync spawn holds the worker's loop that long
  it('holds a package to its type-assertion ceiling, as the whole run does (pre-pr lints only the changed files)', async () => {
    const file = join(ROOT, 'packages', 'protocol', 'src', `zz-ceiling-probe-${process.pid}.ts`)
    writeFileSync(file, 'export const probe = 1 as number\n')
    try {
      // A timeout under the test's own, so the child is gone and the probe removed before vitest gives up on the test
      const args = ['--import', 'tsx', 'tooling/lint.ts', relative(ROOT, file).split(sep).join('/')]
      const r = await promisify(execFile)(process.execPath, args, { cwd: ROOT, timeout: 100_000 * SLOW }).then(
        (o) => ({ code: 0, out: `${o.stdout}${o.stderr}` }),
        (e: { code?: number | string | null; stdout?: string; stderr?: string }) => ({ code: e.code, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }),
      )
      expect(r.out).toContain('packages/protocol: 1, ceiling 0 type assertions')
      expect(r.code).toBe(1)
    } finally {
      rmSync(file, { force: true })
    }
  }, 120_000 * SLOW)
})
