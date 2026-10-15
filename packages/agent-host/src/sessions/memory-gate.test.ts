import { afterEach, describe, expect, it, vi } from 'vitest'
import { availableMemorySource } from '../os.js'
import { gigabytes, MemoryGate, parseMemInfo, parseVmStat, readAvailableMemory } from './memory-gate.js'

/**
 * The start gate for new agent sessions (#686): how free plus reclaimable memory is read on each OS, and how starts
 * queued below the floor are let go once it recovers: oldest first, one per check, never waiting past the bound.
 */

const GB = 1024 ** 3

describe('reading free plus reclaimable memory', () => {
  it('macOS: free, inactive and speculative pages times the stated page size', () => {
    // Read on the owner's 24 GB Mac (2026-10-15): os.freemem() said 0.08 GB while 8.9 GB sat inactive
    const text = [
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
      'Pages free:                                     5293.',
      'Pages active:                                 581702.',
      'Pages inactive:                               581232.',
      'Pages speculative:                             11988.',
      'Pages throttled:                                   0.',
      'Pages wired down:                             177330.',
      'Pages purgeable:                               46892.',
      '"Translation faults":                     9195707037.',
    ].join('\n')
    expect(parseVmStat(text)).toBe((5293 + 581232 + 11988) * 16384)
    expect(gigabytes(parseVmStat(text)!)).toBe('9.1 GB')
    expect(parseVmStat('no header here')).toBeNull()
    expect(parseVmStat('Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 10.')).toBeNull()
  })

  it('Linux: MemAvailable, not MemFree', () => {
    const text = 'MemTotal:       16303428 kB\nMemFree:          412000 kB\nMemAvailable:    9031440 kB\nBuffers:          200000 kB\n'
    expect(parseMemInfo(text)).toBe(9031440 * 1024)
    expect(parseMemInfo('MemFree: 1 kB')).toBeNull()
  })

  it('each OS has its source: vm_stat, /proc/meminfo, or os.freemem()', () => {
    expect(availableMemorySource('darwin')).toMatchObject({ kind: 'command', file: '/usr/bin/vm_stat' })
    expect(availableMemorySource('linux')).toMatchObject({ kind: 'file', path: '/proc/meminfo' })
    expect(availableMemorySource('win32')).toEqual({ kind: 'freemem' })
  })
})

describe('a read that fails (#695 review)', () => {
  afterEach(() => vi.restoreAllMocks())
  // os.freemem() on the owner's Mac: free pages only, far under the floor although 9 GB were reclaimable
  const free = () => 0.08 * GB
  const darwin = availableMemorySource('darwin')
  const linux = availableMemorySource('linux')

  it('is not replaced by os.freemem() on macOS or Linux: it reads null, says so in one log line, and the gate lets the start go', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failing = async () => {
      throw new Error('spawn /usr/bin/vm_stat ENOENT')
    }
    expect(await readAvailableMemory({ source: darwin, exec: failing, free })).toBeNull()
    expect(log).toHaveBeenCalledTimes(1)
    expect(String(log.mock.calls[0]![0])).toContain('/usr/bin/vm_stat')
    // Output it cannot parse is a failed read too
    expect(await readAvailableMemory({ source: darwin, exec: async () => ({ stdout: 'something else' }), free })).toBeNull()
    expect(await readAvailableMemory({ source: linux, readText: failing, free })).toBeNull()
    expect(log).toHaveBeenCalledTimes(3)
    const gate = new MemoryGate({ read: () => readAvailableMemory({ source: darwin, exec: failing, free }) })
    expect(await gate.short()).toBeNull()
  })

  it('a successful read is the source\'s, and Windows reads os.freemem()', async () => {
    const vm = 'Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 1000.\nPages inactive: 3000.\n'
    expect(await readAvailableMemory({ source: darwin, exec: async () => ({ stdout: vm }), free })).toBe(4000 * 4096)
    expect(await readAvailableMemory({ source: availableMemorySource('win32'), free })).toBe(0.08 * GB)
  })
})

describe('the gate', () => {
  afterEach(() => vi.useRealTimers())

  it('lets a start go above the floor, and reports the reading below it; a failing read never blocks', async () => {
    let free = 3 * GB
    const gate = new MemoryGate({ read: async () => free })
    expect(gate.floor).toBe(2 * GB)
    expect(await gate.short()).toBeNull()
    free = 1.5 * GB
    expect(await gate.short()).toEqual({ available: 1.5 * GB, floor: 2 * GB })
    expect(await new MemoryGate({ read: async () => { throw new Error('no vm_stat') } }).short()).toBeNull()
  })

  it('releases queued starts oldest first, one per check, once memory is back', async () => {
    vi.useFakeTimers()
    let free = 1 * GB
    const gate = new MemoryGate({ read: async () => free, recheckMs: 1_000, maxWaitMs: 60_000 })
    const order: string[] = []
    const a = gate.wait().then((o) => order.push(`a:${o}`))
    const b = gate.wait().then((o) => order.push(`b:${o}`))
    await vi.advanceTimersByTimeAsync(3_000)
    expect(order).toEqual([])
    expect(gate.queued).toBe(2)
    free = 4 * GB
    await vi.advanceTimersByTimeAsync(1_000)
    expect(order).toEqual(['a:ready'])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(order).toEqual(['a:ready', 'b:ready'])
    await Promise.all([a, b])
    expect(gate.queued).toBe(0)
  })

  it('never waits past its bound', async () => {
    vi.useFakeTimers()
    const gate = new MemoryGate({ read: async () => 0, recheckMs: 1_000, maxWaitMs: 5_000 })
    let outcome: string | undefined
    void gate.wait().then((o) => (outcome = o))
    await vi.advanceTimersByTimeAsync(4_000)
    expect(outcome).toBeUndefined()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(outcome).toBe('timeout')
    expect(gate.queued).toBe(0)
  })

  it('a cancelled wait leaves the queue at once; closing ends every wait', async () => {
    const gate = new MemoryGate({ read: async () => 0, recheckMs: 60_000 })
    const ctl = new AbortController()
    const cancelled = gate.wait(ctl.signal)
    const other = gate.wait()
    ctl.abort()
    expect(await cancelled).toBe('aborted')
    expect(gate.queued).toBe(1)
    gate.close()
    expect(await other).toBe('aborted')
    expect(await gate.wait()).toBe('aborted')
  })
})
