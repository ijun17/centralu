import { mkdtempSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/*
 * **The run's temporary folder** (#1957): the folder every test file's own temporary folder is made in
 * (`vitest-data-dir.ts`), removed when the run ends. A file removes its own when it ends; this takes what a file could not
 * (a file with every test skipped runs no hooks, and a worker can be ended between files), and fails the run, naming what
 * is left, when even that cannot be removed.
 */
export default function setup(): () => Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'cc-run-'))
  process.env.CC_TEST_RUN_TMP = root
  return async () => {
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    } catch (e) {
      const left = await readdir(root).catch(() => [])
      throw new Error(`the test run's temporary folder ${root} could not be removed (${(e as NodeJS.ErrnoException).code}); left in it: ${left.join(', ') || 'nothing seen'}`)
    }
  }
}
