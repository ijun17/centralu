import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WinProcRow } from '../dev-services/kill-tree.js'

/**
 * The Windows sweep of an agent CLI's leftovers matches a child to its root by creation time (`orphansOf`): a child of
 * the root was created after the root was started. That start must be taken **before** the spawn (`EndedRoot`); taken
 * after it, as it was here, a child the CLI started at once was older than its root's start and no longer its own
 * (#428). `spawn` is wrapped to read the clock at the moment of the spawn, and the clock moves 1 s at each reading.
 */
const clock = vi.hoisted(() => ({ spawnAt: 0 }))
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  return {
    ...real,
    spawn: (...args: Parameters<typeof real.spawn>) => {
      clock.spawnAt = Date.now()
      return real.spawn(...args)
    },
  }
})

const { spawnLocalAgent } = await import('./local-process.js')

afterEach(() => vi.restoreAllMocks())

describe('an agent CLI started without a keeper (Windows)', () => {
  it('collects a child created the moment the CLI was spawned', async () => {
    const killed: number[] = []
    let orphan = 0
    const os = {
      platform: 'win32' as const,
      taskkill: (pid: number) => {
        killed.push(pid)
        // Ends what it names, as taskkill does: a taskkill that succeeded is not followed by a kill of our own (#857)
        if (pid === p.pid) process.kill(pid)
      },
      listProcesses: async (): Promise<WinProcRow[]> => [{ pid: orphan, ppid: p.pid!, created: clock.spawnAt }],
    }
    let t = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => (t += 1000))
    const p = spawnLocalAgent({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], env: process.env }, os)
    vi.restoreAllMocks()
    orphan = p.pid! + 100_000
    const exited = new Promise((r) => p.once('exit', r))
    p.kill('SIGTERM')
    await exited
    await vi.waitFor(() => expect(killed).toEqual([p.pid, orphan]))
  })
})
