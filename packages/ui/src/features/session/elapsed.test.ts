import { describe, expect, it } from 'vitest'
import { formatElapsed } from './SessionView.jsx'

/**
 * Elapsed time is a number that answers "did it stop?"
 * If 3 seconds and 3 minutes look the same, showing it is pointless.
 */
describe('formatElapsed', () => {
  it('under 1 minute, in seconds', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(59)).toBe('59s')
  })
  it('from 1 minute, in minutes and seconds — dropping the seconds makes the number look stopped', () => {
    expect(formatElapsed(60)).toBe('1m 0s')
    expect(formatElapsed(125)).toBe('2m 5s')
  })
  it('from 1 hour, in hours and minutes', () => {
    expect(formatElapsed(3600)).toBe('1h 0m')
    expect(formatElapsed(7860)).toBe('2h 11m')
  })
})
