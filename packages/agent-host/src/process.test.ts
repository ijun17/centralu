import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { alive, ownProcesses } from './process.test-helpers.js'
import { eventually } from '../../../tooling/test-timing.js'

describe('alive(pid) in tests (#845)', () => {
  it('a process this test started is alive until it has exited', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
    const exited = new Promise((r) => child.once('exit', r))
    await new Promise((r) => child.once('spawn', r))
    expect(alive(child.pid!)).toBe(true)
    child.kill()
    await exited
    await eventually(() => !alive(child.pid!))
  })

  // A process that exists but may not be signalled answers EPERM: Windows' System process (pid 4) to a user, init
  // (pid 1) to anyone but root, who may signal it and gets the same answer
  it('a process that exists but may not be signalled is alive', () => {
    expect(alive(process.platform === 'win32' ? 4 : 1)).toBe(true)
  })
})

describe('ownProcesses: a cleanup ends only what the test has not seen end (#1308)', () => {
  const idle = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
  const children: ReturnType<typeof idle>[] = []
  const live = async () => {
    const child = idle()
    children.push(child)
    await new Promise((r) => child.once('spawn', r))
    return child
  }
  afterEach(() => {
    // By handle: Node sends nothing to a child that has exited
    for (const c of children.splice(0)) c.kill()
  })

  it('leaves alone a live process that now has the number of one the test saw end', async () => {
    // The number the test saw end, now held by another program: a live process answers to it
    const stranger = await live()
    let reusedBy: number | undefined
    const own = ownProcesses((pid) => pid !== reusedBy && alive(pid))
    reusedBy = stranger.pid
    expect(own.alive(stranger.pid!)).toBe(false)
    reusedBy = undefined
    expect(alive(stranger.pid!)).toBe(true)

    own.end([stranger.pid!])
    own.end([stranger.pid!], { group: true })

    expect(alive(stranger.pid!)).toBe(true)
    expect(stranger.exitCode).toBeNull()
    expect(stranger.signalCode).toBeNull()
  })

  it('leaves alone a number the test reported ended by another way', async () => {
    const stranger = await live()
    const own = ownProcesses()
    own.sawEnd(stranger.pid!)
    own.end([stranger.pid!])
    expect(alive(stranger.pid!)).toBe(true)
  })

  it('ends a process the test has not seen end', async () => {
    const mine = await live()
    const exited = new Promise((r) => mine.once('exit', r))
    ownProcesses().end([mine.pid!])
    await exited
    expect(alive(mine.pid!)).toBe(false)
  })

  it('ends it again once forgotten: the next process to get such a number is new', async () => {
    const next = await live()
    const exited = new Promise((r) => next.once('exit', r))
    const own = ownProcesses()
    own.sawEnd(next.pid!)
    own.forget([next.pid!])
    own.end([next.pid!])
    await exited
    expect(alive(next.pid!)).toBe(false)
  })

  it('endAfter: a process that went while the code under test stopped it is not signalled, one that stayed is ended', async () => {
    const gone = await live()
    const stayed = await live()
    const goneExit = new Promise((r) => gone.once('exit', r))
    const stayedExit = new Promise((r) => stayed.once('exit', r))
    gone.kill()
    await goneExit
    // The number of the gone one is now someone else's: a live process answers to it
    const stranger = await live()
    const kill = vi.spyOn(process, 'kill')
    try {
      const own = ownProcesses((pid) => pid !== gone.pid && alive(pid))
      await own.endAfter([gone.pid!, stayed.pid!], 200)
      // Signals only: the existence checks (signal 0) are not
      expect(kill.mock.calls.filter((c) => c[1] !== 0).map((c) => c[0])).toEqual([stayed.pid])
      await stayedExit
    } finally {
      kill.mockRestore()
    }
    expect(alive(stranger.pid!)).toBe(true)
  })

  it('ignores a pid of 0 or less, which would signal the whole group', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      ownProcesses().end([0, -1, NaN])
      expect(kill).not.toHaveBeenCalled()
    } finally {
      kill.mockRestore()
    }
  })
})
