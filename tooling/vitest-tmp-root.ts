import { mkdtempSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/*
 * **The run's temporary folder** (#1957): the folder every test file's own temporary folder is made in
 * (`vitest-data-dir.ts`), removed when the run ends. A file removes its own when it ends; this takes what a file could not
 * (a file with every test skipped runs no hooks, and a worker can be ended between files), and fails the run, naming what
 * is left, when even that cannot be removed. It also holds what files share (the fake programs' launcher,
 * `fake-exe.test-helpers.ts`). Vitest runs a global setup once per project, so a run makes up to three of these folders and
 * removes each.
 *
 * Short names (`cr-`, `ct-`, `data`): macOS limits a socket path to 103 characters, and the keeper tests make theirs in here.
 */
export default function setup(): () => Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'cr-'))
  process.env.CC_TEST_RUN_TMP = root
  return async () => {
    try {
      // A hook has 10 s off Windows and 30 s on it: the tries have to fit, or the hook times out instead of saying what is left
      await rm(root, { recursive: true, force: true, maxRetries: process.platform === 'win32' ? 20 : 5, retryDelay: 100 })
    } catch (e) {
      const left = await readdir(root).catch(() => [])
      throw new Error(`the test run's temporary folder ${root} could not be removed (${e instanceof Error ? e.message : String(e)}); left in it: ${left.join(', ') || 'nothing seen'}`)
    }
  }
}
