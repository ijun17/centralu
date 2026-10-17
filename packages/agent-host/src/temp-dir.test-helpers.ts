import { execFileSync, type ExecFileSyncOptions } from 'node:child_process'
import { mkdtempSync, realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Temporary folders and git repositories for tests, made the same way everywhere (#845, #368).
 */

/**
 * A new empty folder under the system's temporary folder, by its long real path.
 *
 * `.native`: on Windows it expands 8.3 short names (`RUNNER~1`) as git and the host's own canonical paths do, so a
 * comparison between a path built from this and one git prints holds there too. Plain `realpathSync` keeps the short
 * name.
 */
export function tempRoot(prefix: string): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
}

/**
 * Removes a folder and everything in it, retried, and asynchronously.
 *
 * Windows will not delete a folder a process is still working in (EBUSY), and a process a test started (an app, a
 * detached `git maintenance`, a manager's merge detection) can still be ending when the test does: `lifecycle.test.ts`
 * met it in 7 of 105 Windows CI runs. The wait is asynchronous because `rmSync`'s own retries block the event loop
 * that in-process work needs in order to finish, and failed the same way every time (`manager.test.ts`, #14).
 */
export function removeTree(dir: string): Promise<void> {
  return rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}

/**
 * What every fixture git command runs with: a test identity, so a runner without one can commit, and no automatic
 * maintenance. Since git 2.29 each `git commit` may start a detached `git maintenance run --auto` that goes on
 * working in the repository after the commit returns, which kept the folder busy for the cleanup (#503).
 */
export const FIXTURE_GIT_CONFIG = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'maintenance.auto=false'] as const

/** `git <args>` in `cwd` for a fixture (`FIXTURE_GIT_CONFIG`), its output as text */
export function fixtureGit(cwd: string, args: readonly string[], opts: Omit<ExecFileSyncOptions, 'cwd' | 'encoding'> = {}): string {
  return execFileSync('git', [...FIXTURE_GIT_CONFIG, ...args], { stdio: 'pipe', ...opts, cwd, encoding: 'utf8' })
}
