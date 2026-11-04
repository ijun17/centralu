import { mkdtempSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTree, removeWithin } from './remove-tree.js'

/*
 * **The run's temporary folder** (#1957): the folder every test file's own temporary folder is made in
 * (`vitest-data-dir.ts`), removed when the run ends. A file removes its own when it ends; this takes what a file could not
 * (a file with every test skipped runs no hooks, and a worker can be ended between files), and fails the run, naming what
 * is left, when even that cannot be removed. It also holds what files share (the fake programs' launcher,
 * `fake-exe.test-helpers.ts`).
 *
 * Vitest runs a global setup once per project, in one process, so each project makes a folder and the last one's name is
 * what the workers inherit (`CC_TEST_RUN_TMP`): the others stay empty, and each is removed. A global teardown has no hook
 * time limit; `removeTree` gives its own.
 *
 * A run that was killed outright leaves its folder (no teardown ran); the next run removes the ones older than a day.
 *
 * Short names (`cr-`, `ct-`, `data`): macOS limits a socket path to 103 characters, and the keeper tests make theirs in here.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const old = Date.now() - 24 * 3600_000
  const names = await readdir(tmpdir()).catch(() => [])
  await Promise.all(
    names
      .filter((n) => /^cr-[A-Za-z0-9]{6}$/.test(n))
      .map(async (n) => {
        const path = join(tmpdir(), n)
        const made = (await stat(path).catch(() => null))?.mtimeMs
        if (made !== undefined && made < old) await removeWithin(path, 3000).catch(() => {})
      }),
  )
  const root = mkdtempSync(join(tmpdir(), 'cr-'))
  process.env.CC_TEST_RUN_TMP = root
  return () => removeTree(root)
}
