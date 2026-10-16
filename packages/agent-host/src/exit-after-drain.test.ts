import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExitAfterDrain } from './exit-after-drain.js'

afterEach(() => vi.useRealTimers())

describe('an exit reported after the output', () => {
  it('waits for the output, whichever comes first, and reports once', () => {
    const fired: number[] = []
    const r = new ExitAfterDrain(() => fired.push(1))
    r.drained()
    expect(fired).toEqual([])
    r.exited()
    r.drained()
    expect(fired).toEqual([1])
  })

  it('reports anyway once the cap has passed, and nothing once cancelled', () => {
    vi.useFakeTimers()
    const fired: string[] = []
    const late = new ExitAfterDrain(() => fired.push('late'), 150)
    late.exited()
    vi.advanceTimersByTime(149)
    expect(fired).toEqual([])
    vi.advanceTimersByTime(1)
    expect(fired).toEqual(['late'])
    const gone = new ExitAfterDrain(() => fired.push('gone'))
    gone.exited()
    gone.cancel()
    vi.advanceTimersByTime(5000)
    expect(fired).toEqual(['late'])
    expect(vi.getTimerCount()).toBe(0)
  })
})
