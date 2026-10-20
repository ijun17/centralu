import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeFakeDir } from './fake-exe.test-helpers.js'
import { alive } from './process.test-helpers.js'
import { SLOW } from '../../../tooling/test-timing.js'

/**
 * A test's cleanup of its folder (#1346): on Windows a folder a process still holds cannot be removed, and the board
 * queue tests' cleanup failed with `EBUSY ... rmdir` while something worked in it. `removeFakeDir` retries briefly
 * without blocking the event loop, then leaves such a folder to the system's temporary-folder cleanup instead of failing
 * the test, only inside the temporary folder and only on Windows.
 */

const started: number[] = []
afterEach(() => {
  for (const pid of started.splice(0)) if (alive(pid)) process.kill(pid)
})

/**
 * A folder in the temporary folder, held by a child process working inside it (on Windows that blocks its removal).
 * Answers once the child has said it runs there (its `ready` line), not after a guess at how long starting takes.
 */
async function heldFolder(): Promise<{ dir: string; pid: number; exited: Promise<unknown> }> {
  const dir = mkdtempSync(join(tmpdir(), 'cc-fake-exe-cleanup-'))
  const inner = join(dir, 'work')
  mkdirSync(inner)
  writeFileSync(join(inner, 'x.txt'), 'x\n')
  const child = spawn(process.execPath, ['-e', "process.stdout.write('ready'); setTimeout(() => {}, 60_000)"], { cwd: inner, stdio: ['ignore', 'pipe', 'ignore'] })
  started.push(child.pid!)
  await new Promise<void>((resolve, reject) => {
    child.stdout!.once('data', () => resolve())
    child.once('exit', () => reject(new Error('the holding process ended before it was ready')))
  })
  return { dir, pid: child.pid!, exited: new Promise((resolve) => (child.exitCode !== null ? resolve(null) : child.once('exit', resolve))) }
}

describe('removing a test folder (#1346)', () => {
  it.runIf(process.platform === 'win32')('leaves a temporary folder a process still holds on Windows, without failing and within seconds', async () => {
    const { dir, pid, exited } = await heldFolder()
    const t0 = Date.now()
    await expect(removeFakeDir(dir)).resolves.toBeUndefined()
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
})
