import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { removeTree } from '../packages/agent-host/src/temp-dir.test-helpers.js'
import { SLOW } from './test-timing.js'

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
    expect(basename(dir)).toBe('data')
    expect(basename(dirname(dir))).toMatch(/^ct-[A-Za-z0-9]{6}$/)
    expect(existsSync(dir)).toBe(true)
    // Nothing else has written into it: this file has not started a host or a manager
    expect(readdirSync(dir)).toEqual([])
  })
})

/*
 * A test that needs a data folder of its own stubs it (#845): vitest undoes the stub before the next test
 * (`unstubEnvs` in vitest.config.ts). Assigning `process.env.CC_DATA_DIR` by hand is what went wrong: a test
 * file deleted it after each test, leaving what ran next on the real `~/.centralu`, and another restored a
 * saved `undefined`, which Node stores as the string "undefined", a folder in the current directory. That a test file
 * never writes it by hand is a lint rule, `test-env/data-dir` (tooling/eslint-test-data-dir.js, #1602).
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
})

/*
 * Every folder a test file makes in the temporary folder is gone when the file ends, whether or not its tests removed
 * them: 13,209 `cc-*` folders (81 GB) had piled up on a development machine from tests that did not (#1957).
 */
describe('the temporary folder of a test file', () => {
  it('is the test file own folder, in which its data folder is made', () => {
    expect(basename(tmpdir())).toMatch(/^ct-[A-Za-z0-9]{6}$/)
    expect(dirname(process.env.CC_DATA_DIR!)).toBe(tmpdir())
  })

  it.each([['makes folders and leaves them', '1'], ['has every test skipped', '0']])('takes with it the folders a test file left, so a run leaves nothing in the temporary folder (a file that %s)', async (_what, probing) => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const probe = mkdtempSync(join(tmpdir(), 'probe-'))
    try {
      let output = ''
      const code = await new Promise<number | null>((resolve) => {
        const child = execFile(
          process.execPath,
          [fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url)), 'run', '--project', 'unit', '--maxWorkers=1', 'tooling/fixtures/leak/leak-probe.test.ts'],
          { cwd: root, timeout: 90_000 * SLOW, env: { ...process.env, CC_LEAK_PROBE: probing, TMPDIR: probe, TMP: probe, TEMP: probe, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' } },
          (_e, stdout, stderr) => ((output = `${stdout}
${stderr}`), resolve(child.exitCode)),
        )
      })
      expect(code, output).toBe(0)
      // node's own compile cache goes to the temporary folder the process started with; it is not a test's
      expect(readdirSync(probe).filter((n) => n !== 'node-compile-cache')).toEqual([])
    } finally {
      await removeTree(probe)
    }
  }, 120_000 * SLOW)
})
