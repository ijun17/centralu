import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { insideOf, removeFakeDir } from './fake-exe.test-helpers.js'
import { alive } from './process.test-helpers.js'
import { SLOW } from '../../../tooling/test-timing.js'

/**
 * A test's cleanup of its folder (#1346): on Windows a folder a process still holds cannot be removed, and the board
 * queue tests' cleanup failed with `EBUSY ... rmdir` while something worked in it. `removeFakeDir` retries briefly
 * without blocking the event loop, then leaves such a folder to the system's temporary-folder cleanup instead of failing
 * the test, only inside the temporary folder and only on Windows.
 */

const started: { pid: number; exited: Promise<unknown> }[] = []
const made: string[] = []
afterEach(async () => {
  for (const c of started.splice(0)) {
    if (alive(c.pid)) process.kill(c.pid)
    await c.exited
  }
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
})

/**
 * A folder in the temporary folder, as its real path (as the board's queue tests make theirs), held by a child process
 * working inside it (on Windows that blocks its removal). Answers once the child has said it runs there (its `ready`
 * line), not after a guess at how long starting takes.
 */
async function heldFolder(): Promise<{ dir: string; pid: number; exited: Promise<unknown> }> {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-fake-exe-cleanup-')))
  made.push(dir)
  const inner = join(dir, 'work')
  mkdirSync(inner)
  writeFileSync(join(inner, 'x.txt'), 'x\n')
  const child = spawn(process.execPath, ['-e', "process.stdout.write('ready'); setTimeout(() => {}, 60_000)"], { cwd: inner, stdio: ['ignore', 'pipe', 'ignore'] })
  const exited = new Promise((resolve) => child.once('exit', resolve))
  started.push({ pid: child.pid!, exited })
  await new Promise<void>((resolve, reject) => {
    child.stdout!.once('data', () => resolve())
    child.once('exit', () => reject(new Error('the holding process ended before it was ready')))
  })
  return { dir, pid: child.pid!, exited }
}

/** The temporary folder through another name, as GitHub's runners give it (a short name; here a junction to it) */
function aliasOfTmp(): string {
  const parent = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-fake-exe-alias-')))
  made.push(parent)
  const alias = join(parent, 'tmp-alias')
  symlinkSync(realpathSync.native(tmpdir()), alias, process.platform === 'win32' ? 'junction' : 'dir')
  return alias
}

describe('removing a test folder (#1346)', () => {
  it.runIf(process.platform === 'win32')('leaves a temporary folder a process still holds on Windows, without failing and within seconds', async () => {
    const { dir, pid, exited } = await heldFolder()
    const t0 = Date.now()
    // The temporary folder named otherwise than the folder's real path, as on GitHub's Windows runners
    await expect(removeFakeDir(dir, { platform: 'win32', tmp: aliasOfTmp() })).resolves.toBeUndefined()
    expect(Date.now() - t0).toBeLessThan(20_000 * SLOW)
    expect(existsSync(dir)).toBe(true)
    // Once nothing holds it, it is removed
    process.kill(pid)
    await exited
    await removeFakeDir(dir)
    expect(existsSync(dir)).toBe(false)
  })

  it.runIf(process.platform === 'win32')('still fails for a held folder outside the temporary folder', async () => {
    const { dir } = await heldFolder()
    await expect(removeFakeDir(dir, { platform: 'win32', tmp: join(dir, 'elsewhere') })).rejects.toMatchObject({ code: expect.stringMatching(/EBUSY|EPERM|ENOTEMPTY/) })
  })

  it('removes a folder nothing holds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-fake-exe-cleanup-'))
    writeFileSync(join(dir, 'x.txt'), 'x\n')
    await removeFakeDir(dir)
    expect(existsSync(dir)).toBe(false)
  })

  it('knows a folder inside the temporary folder through either name, and not one elsewhere, on another drive, or the folder itself', () => {
    const real = realpathSync.native(tmpdir())
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-fake-exe-inside-')))
    made.push(dir)
    expect(insideOf(real, dir)).toBe(true)
    expect(insideOf(aliasOfTmp(), dir)).toBe(true)
    expect(insideOf(dir, real)).toBe(false)
    expect(insideOf(real, real)).toBe(false)
    if (process.platform === 'win32') expect(insideOf('C:\\Temp', 'D:\\x')).toBe(false)
  })
})
