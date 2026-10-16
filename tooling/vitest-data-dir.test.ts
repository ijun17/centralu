import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

/*
 * The data folder tests run against (#368). A folder shared by every test file let one file's
 * session managers sweep away a handoff note another file had just written (ENOENT in CI,
 * run 37885918963). The guard is that each file is handed a fresh one: `mkdtemp` names it, so no
 * other file, and no other run on the machine, can be using it.
 */
describe('the data folder a test file runs against', () => {
  it('is a fresh temporary folder of its own, not one shared with other files', () => {
    const dir = process.env.CC_DATA_DIR!
    expect(dirname(dir)).toBe(tmpdir())
    expect(basename(dir)).toMatch(/^centralu-test-data-[A-Za-z0-9]{6}$/)
    expect(existsSync(dir)).toBe(true)
    // Nothing else has written into it: this file has not started a host or a manager
    expect(readdirSync(dir)).toEqual([])
  })
})

/*
 * A test that needs a data folder of its own stubs it (#845): vitest undoes the stub before the next test
 * (`unstubEnvs` in vitest.config.ts). Assigning `process.env.CC_DATA_DIR` by hand is what went wrong: a test
 * file deleted it after each test, leaving what ran next on the real `~/.centralu`, and another restored a
 * saved `undefined`, which Node stores as the string "undefined", a folder in the current directory.
 */
describe('a data folder a test sets for itself', () => {
  const own = process.env.CC_DATA_DIR
  it('is a stub (this one points it elsewhere)', () => {
    vi.stubEnv('CC_DATA_DIR', join(tmpdir(), 'somewhere-else'))
    expect(process.env.CC_DATA_DIR).toBe(join(tmpdir(), 'somewhere-else'))
  })
  it('and the next test is back on the file\'s own folder', () => {
    expect(process.env.CC_DATA_DIR).toBe(own)
  })

  it('is never assigned or deleted by hand in a test file', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const files = execFileSync('git', ['ls-files', 'packages/*.test.ts', 'packages/*.test.tsx', 'tooling/*.test.ts', 'packages/*.test-helpers.ts'], { cwd: root, encoding: 'utf8' })
      .trim()
      .split('\n')
    expect(files.length).toBeGreaterThan(100)
    const byHand = files.flatMap((f) =>
      readFileSync(join(root, f), 'utf8')
        .split('\n')
        .flatMap((line, i) => (/(\bdelete\s+process\.env\.CC_DATA_DIR\b|process\.env\.CC_DATA_DIR\s*=[^=])/.test(line) ? [`${f}:${i + 1}`] : [])),
    )
    expect(byHand).toEqual([])
  })
})
