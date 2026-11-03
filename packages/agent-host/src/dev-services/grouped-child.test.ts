import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sweepLeftovers, tracked } from './grouped-child.js'

/**
 * The sweep after a grouped child exits (#1650 review): what it left is what was created between its spawn and its
 * exit as the host saw it, never up to the time of the sweep. By then Windows may have given its pid to another
 * program, whose children would otherwise be ended with it.
 */
/** A child as far as the sweep reads one: its pid and its exit */
const fakeChild = (pid: number | undefined) => Object.assign(new EventEmitter(), { pid }) as unknown as ChildProcess

describe('the sweep after a child exits', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("windows: ends what the child started before it exited, not what its pid's next owner started after", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1000)
    const child = fakeChild(77)
    const started = tracked(child, 1000)
    vi.setSystemTime(2000)
    child.emit('exit', 0, null)
    // The sweep runs later (a stop, a run's late stop): pid 77 now belongs to another program
    vi.setSystemTime(5000)
    const killed: number[] = []
    const ended = await sweepLeftovers(started, 'win32', {
      listProcesses: async () => [
        { pid: 101, ppid: 77, created: 1500 },
        { pid: 102, ppid: 77, created: 3000 },
      ],
      taskkill: (pid) => void killed.push(pid),
    })
    expect(ended).toEqual([101])
    expect(killed).toEqual([101])
    expect(started.exitedAt()).toBe(2000)
  })

  // #1773: the host's clock can be a clock tick behind the one that stamps a process's creation, so a grandchild started
  // as its parent exited can be stamped after the exit as recorded
  it("windows: ends a grandchild stamped 2 ms after the exit the host recorded (main's CI run)", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1793687827086)
    const child = fakeChild(8092)
    const started = tracked(child, 1793687827086)
    vi.setSystemTime(1793687827165)
    child.emit('exit', 0, null)
    const killed: number[] = []
    const ended = await sweepLeftovers(started, 'win32', {
      listProcesses: async () => [{ pid: 6416, ppid: 8092, created: 1793687827167 }],
      taskkill: (pid) => void killed.push(pid),
    })
    expect(ended).toEqual([6416])
    expect(killed).toEqual([6416])
  })

  it('sweeps nothing for a child that never started', async () => {
    const child = fakeChild(undefined)
    const listProcesses = vi.fn(async () => [])
    expect(await sweepLeftovers(tracked(child, 0), 'win32', { listProcesses, taskkill: () => {} })).toEqual([])
    expect(listProcesses).not.toHaveBeenCalled()
  })
})
