import { describe, expect, it } from 'vitest'
import { formatClock, formatDay } from './clock.js'

/** Built from local fields, so the expected text does not depend on the machine's time zone */
const local = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime()

describe('formatClock', () => {
  it('writes 24-hour hours and minutes, padded', () => {
    expect(formatClock(local(2026, 10, 16, 15, 12))).toBe('15:12')
    expect(formatClock(local(2026, 10, 16, 3, 5))).toBe('03:05')
  })

  it('writes midnight as 00, never 24 and never 12 AM', () => {
    expect(formatClock(local(2026, 10, 16, 0, 0))).toBe('00:00')
    expect(formatClock(local(2026, 10, 16, 12, 0))).toBe('12:00')
    expect(formatClock(local(2026, 10, 16, 23, 59))).toBe('23:59')
  })

  it('adds seconds on request', () => {
    expect(formatClock(local(2026, 10, 16, 15, 12, 5), { seconds: true })).toBe('15:12:05')
  })

  it('takes a Date as well', () => {
    expect(formatClock(new Date(2026, 9, 16, 15, 12))).toBe('15:12')
  })
})

describe('formatDay', () => {
  const NOW = local(2026, 10, 16, 12)

  it('writes the month and the day', () => {
    expect(formatDay(local(2026, 10, 16, 9), NOW)).toBe('Oct 16')
    expect(formatDay(local(2026, 1, 3), NOW)).toBe('Jan 3')
    expect(formatDay(local(2026, 12, 31, 23, 59), NOW)).toBe('Dec 31')
  })

  it('adds the year when it is not this year', () => {
    expect(formatDay(local(2025, 10, 16), NOW)).toBe('Oct 16, 2025')
    expect(formatDay(local(2027, 1, 1), NOW)).toBe('Jan 1, 2027')
  })
})
