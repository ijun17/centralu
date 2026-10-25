import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { it, type TestContext } from 'vitest'

/**
 * Links for tests, on a machine that may not be allowed to make a symlink.
 *
 * Windows lets only an administrator, or a user with Developer Mode on, create a symlink; CI's
 * runners are administrators, an ordinary user's machine is not (#1550). A junction needs no right
 * and is what pnpm and npm workspaces make there, and every guard under test (containment, escape
 * refusal, dependency copies) treats a junction as a link. So a test that needs "a link to a
 * folder" makes it with `linkDir`: a symlink where the process may make one, a junction on a Windows
 * machine that may not.
 *
 * What a junction cannot be (a link to a file, a relative link, a link to a share, a link whose
 * point is that it is a Windows symlink) is made with `linkFile` / `symlinkSync` and run with
 * `itSymlink`, which skips with a stated reason when the right is missing. CI still runs them.
 */

function probe(): boolean {
  if (process.platform !== 'win32') return true
  const dir = mkdtempSync(join(tmpdir(), 'cc-symlink-probe-'))
  try {
    writeFileSync(join(dir, 'f'), '')
    symlinkSync(join(dir, 'f'), join(dir, 'l'), 'file')
    return true
  } catch {
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Whether this process may create a symlink (always, off Windows). Checked once. */
export const canSymlink = probe()

export const SYMLINK_SKIP_REASON = 'needs symlink rights on Windows (administrator or Developer Mode)'

// A junction is always absolute and, unlike a symlink, a relative target is read from the working
// folder, not from the link's folder: resolve it the way a symlink would be read.
function junctionTarget(target: string, path: string): string {
  return resolve(dirname(path), target)
}

/**
 * A link to a folder: a symlink wherever this process may make one (CI's administrator runners keep their old coverage), a
 * junction on a Windows machine without the right. A relative target is read from the link's folder.
 */
export function linkDir(target: string, path: string): void {
  if (!canSymlink) symlinkSync(junctionTarget(target, path), path, 'junction')
  else symlinkSync(target, path, 'dir')
}

export async function linkDirAsync(target: string, path: string): Promise<void> {
  if (!canSymlink) await symlink(junctionTarget(target, path), path, 'junction')
  else await symlink(target, path, 'dir')
}

/** A link to a file (a junction cannot be one): needs the right on Windows, so use it under `itSymlink`. */
export function linkFile(target: string, path: string): void {
  symlinkSync(target, path, 'file')
}

type TestFn = (ctx: TestContext) => void | Promise<void>

/** Like `it`, skipped with a stated reason where the machine cannot make a symlink. */
export function itSymlink(name: string, fn: TestFn, timeout?: number): void {
  it(name, (ctx) => {
    if (!canSymlink) return ctx.skip(SYMLINK_SKIP_REASON)
    return fn(ctx)
  }, timeout)
}

/** `itSymlink` for a test that only exists where `skip` is false (e.g. only on Windows). */
itSymlink.skipIf = (skip: boolean) => (name: string, fn: TestFn, timeout?: number): void => {
  if (skip) it.skip(name, fn, timeout)
  else itSymlink(name, fn, timeout)
}
