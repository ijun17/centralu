import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SLOW } from './test-timing.js'

const refusals = vi.hoisted(() => ({ left: 0 }))
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>()
  return {
    ...real,
    rm: (...args: Parameters<typeof real.rm>) => {
      if (refusals.left-- > 0) return Promise.reject(Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }))
      return real.rm(...args)
    },
  }
})

// The setup file has loaded the module already, with the real `rm`
vi.resetModules()
const { removeWithin } = await import('./remove-tree.js')

/*
 * How a test folder is removed (#1957): tried again until a deadline, then it fails naming what is left. `rm`'s own `maxRetries`
 * retries at every level of the tree, so the wait multiplied with depth and a held folder ended in a hook timeout that named nothing.
 */
describe('removing a test folder', () => {
  const folder = () => {
    const dir = mkdtempSync(join(tmpdir(), 'rt-'))
    mkdirSync(join(dir, 'a', 'b'), { recursive: true })
    writeFileSync(join(dir, 'a', 'b', 'file'), 'x')
    return dir
  }

  it('tries again while it is refused, and removes it once it is let go', async () => {
    const dir = folder()
    refusals.left = 3
    await removeWithin(dir, 5_000)
    expect(existsSync(dir)).toBe(false)
  })

  it('stops at the deadline, however deep the tree, and names the code and what is left', async () => {
    const dir = folder()
    refusals.left = Infinity
    const started = Date.now()
    const failure = await removeWithin(dir, 300).then(() => null, (e: unknown) => e)
    refusals.left = 0
    expect(Date.now() - started).toBeLessThan(2_000 * SLOW)
    expect(failure).toMatchObject({ code: 'EBUSY', message: expect.stringContaining(`left in it: a`) })
    expect(existsSync(dir)).toBe(true)
  })

  // The real refusal: Windows will not remove a folder a process works in
  it.runIf(process.platform === 'win32')('waits for a process that works in the folder to end', async () => {
    const dir = folder()
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1200)'], { cwd: join(dir, 'a'), stdio: 'ignore' })
    await new Promise((r) => holder.once('spawn', r))
    await removeWithin(dir, 15_000)
    expect(existsSync(dir)).toBe(false)
  }, 30_000 * SLOW)

  it.runIf(process.platform === 'win32')('gives up at the deadline on a folder a process keeps, however deep it is held', async () => {
    const dir = folder()
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { cwd: join(dir, 'a', 'b'), stdio: 'ignore' })
    try {
      await new Promise((r) => holder.once('spawn', r))
      const started = Date.now()
      await expect(removeWithin(dir, 1_000)).rejects.toThrow(/could not be removed within 1000 ms.*left in it: a/)
      expect(Date.now() - started).toBeLessThan(4_000 * SLOW)
    } finally {
      const ended = new Promise((r) => holder.once('exit', r))
      holder.kill()
      await ended
    }
    await removeWithin(dir, 15_000)
    expect(existsSync(dir)).toBe(false)
  }, 30_000 * SLOW)
})
