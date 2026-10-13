import { describe, expect, it } from 'vitest'
import { formatElapsed, nextElapsedTick } from './elapsed.js'

/**
 * Elapsed time is a number that answers "did it stop?"
 * If 3 seconds and 3 minutes look the same, showing it is pointless.
 */
describe('formatElapsed', () => {
  it('under 10 seconds, by the second', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(9)).toBe('9s')
  })
  it('under 1 minute, by five seconds', () => {
    expect(formatElapsed(10)).toBe('10s')
    expect(formatElapsed(14)).toBe('10s')
    expect(formatElapsed(37)).toBe('35s')
    expect(formatElapsed(59)).toBe('55s')
  })
  it('up to 10 minutes, in minutes and tens of seconds: it keeps moving, and claims no precision it does not show', () => {
    expect(formatElapsed(60)).toBe('1m 0s')
    expect(formatElapsed(125)).toBe('2m 0s')
    expect(formatElapsed(139)).toBe('2m 10s')
    expect(formatElapsed(599)).toBe('9m 50s')
  })
  it('from 10 minutes, in minutes', () => {
    expect(formatElapsed(600)).toBe('10m')
    expect(formatElapsed(3599)).toBe('59m')
  })
  it('from 1 hour, in hours and minutes', () => {
    expect(formatElapsed(3600)).toBe('1h 0m')
    expect(formatElapsed(7860)).toBe('2h 11m')
  })
})

describe('when the count next changes', () => {
  it('aligns simultaneous turns to a shared wall-clock step', () => {
    expect(nextElapsedTick(1_000, 1_000)).toBe(1_000)
    expect(nextElapsedTick(1_000, 1_400)).toBe(600)
    expect(nextElapsedTick(0, 12_000)).toBe(3_000)
    expect(nextElapsedTick(0, 65_000)).toBe(5_000)
    expect(nextElapsedTick(0, 600_000)).toBe(60_000)
    expect(nextElapsedTick(0, 59_999)).toBe(1)
  })
  it('out of view, is the next whole minute', () => {
    expect(nextElapsedTick(0, 5_000, true)).toBe(55_000)
  })
})
