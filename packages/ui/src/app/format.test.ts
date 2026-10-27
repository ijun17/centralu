import { describe, expect, it } from 'vitest'
import { dayKey, formatBytes, formatCount, formatDayLong, formatDuration, formatReadAt, formatSaidAt } from './format.js'

describe('formatBytes', () => {
  it('writes whole bytes under a kilobyte', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1)).toBe('1 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })

  it('writes a small file in bytes, not as 0KB', () => {
    expect(formatBytes(100)).toBe('100 B')
  })

  it('steps to the next unit at 1024, and writes one decimal below 100', () => {
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(10 * 1024)).toBe('10 KB')
    expect(formatBytes(99.5 * 1024)).toBe('99.5 KB')
    expect(formatBytes(100 * 1024)).toBe('100 KB')
    expect(formatBytes(630 * 1024)).toBe('630 KB')
  })

  it('writes a value that rounds up to 1024 in the next unit, not as 1024.0 KB', () => {
    expect(formatBytes(1024 * 1024 - 1)).toBe('1 MB')
    expect(formatBytes(1023.96 * 1024)).toBe('1 MB')
    expect(formatBytes(1023 * 1024)).toBe('1023 KB')
  })

  it('keeps going to gigabytes and terabytes, not 5120.0 MB', () => {
    expect(formatBytes(1024 ** 2)).toBe('1 MB')
    expect(formatBytes(630 * 1024 ** 2)).toBe('630 MB')
    expect(formatBytes(5 * 1024 ** 3)).toBe('5 GB')
    expect(formatBytes(8.5 * 1024 ** 3)).toBe('8.5 GB')
    expect(formatBytes(3 * 1024 ** 4)).toBe('3 TB')
    expect(formatBytes(5000 * 1024 ** 4)).toBe('5000 TB')
  })

  it('does not write nonsense for what is not a size', () => {
    expect(formatBytes(-5)).toBe('0 B')
    expect(formatBytes(NaN)).toBe('0 B')
    expect(formatBytes(Infinity)).toBe('0 B')
  })
})

describe('formatCount', () => {
  it('writes the number itself under a thousand', () => {
    expect(formatCount(0)).toBe('0')
    expect(formatCount(812)).toBe('812')
    expect(formatCount(999)).toBe('999')
  })

  it('steps to k at 1000 with one decimal below 100', () => {
    expect(formatCount(1000)).toBe('1k')
    expect(formatCount(1500)).toBe('1.5k')
    expect(formatCount(12_400)).toBe('12.4k')
    expect(formatCount(18_000)).toBe('18k')
    expect(formatCount(99_940)).toBe('99.9k')
    expect(formatCount(100_000)).toBe('100k')
    expect(formatCount(540_000)).toBe('540k')
  })

  it('writes a value that rounds up to 1000k as 1M, not 1000k', () => {
    expect(formatCount(999_499)).toBe('999k')
    expect(formatCount(999_500)).toBe('1M')
    expect(formatCount(999_999)).toBe('1M')
  })

  it('writes millions as M, not 2500.0k', () => {
    expect(formatCount(1_900_000)).toBe('1.9M')
    expect(formatCount(2_500_000)).toBe('2.5M')
    expect(formatCount(25_300_000)).toBe('25.3M')
    expect(formatCount(1.2e9)).toBe('1.2B')
  })

  it('does not write nonsense for what is not a count', () => {
    expect(formatCount(-1)).toBe('0')
    expect(formatCount(NaN)).toBe('0')
  })
})

describe('formatDuration', () => {
  it('writes milliseconds under a second and tenths under ten seconds', () => {
    expect(formatDuration(5)).toBe('5ms')
    expect(formatDuration(250)).toBe('250ms')
    expect(formatDuration(999)).toBe('999ms')
    expect(formatDuration(1000)).toBe('1s')
    expect(formatDuration(1500)).toBe('1.5s')
    expect(formatDuration(9999)).toBe('9.9s')
  })

  it('writes whole seconds to a minute and minutes with seconds to ten minutes', () => {
    expect(formatDuration(10_000)).toBe('10s')
    expect(formatDuration(42_900)).toBe('42s')
    expect(formatDuration(60_000)).toBe('1m 0s')
    expect(formatDuration(125_000)).toBe('2m 5s')
    expect(formatDuration(599_999)).toBe('9m 59s')
  })

  it('writes only minutes from ten minutes, then hours and minutes', () => {
    expect(formatDuration(600_000)).toBe('10m')
    expect(formatDuration(3_599_000)).toBe('59m')
    expect(formatDuration(3_600_000)).toBe('1h 0m')
    expect(formatDuration(7_500_000)).toBe('2h 5m')
    expect(formatDuration(86_399_000)).toBe('23h 59m')
  })

  it('writes days and hours from a day, not 75h 3m', () => {
    expect(formatDuration(86_400_000)).toBe('1d 0h')
    expect(formatDuration((75 * 60 + 3) * 60_000)).toBe('3d 3h')
    expect(formatDuration(40 * 86_400_000 + 5 * 3_600_000)).toBe('40d 5h')
  })

  it('coarse reads to the minute: whole seconds to a minute, then no seconds', () => {
    expect(formatDuration(0, { coarse: true })).toBe('0s')
    expect(formatDuration(500, { coarse: true })).toBe('0s')
    expect(formatDuration(45_900, { coarse: true })).toBe('45s')
    expect(formatDuration(60_000, { coarse: true })).toBe('1m')
    expect(formatDuration(125_000, { coarse: true })).toBe('2m')
    expect(formatDuration(3_600_000, { coarse: true })).toBe('1h 0m')
    expect(formatDuration(3 * 86_400_000 + 4 * 3_600_000, { coarse: true })).toBe('3d 4h')
  })

  it('writes nothing odd for what is not a length', () => {
    expect(formatDuration(-5)).toBe('0ms')
    expect(formatDuration(NaN)).toBe('0ms')
    expect(formatDuration(0)).toBe('0ms')
    expect(formatDuration(NaN, { coarse: true })).toBe('0s')
  })
})

/*
 * The times in the conversation (owner, 2026-10-18): the clock time under a bubble, the day on a divider, both in
 * English whatever the system's language. Moments are built in local time, as the screen reads them. Newer ICU puts a
 * narrow no-break space before AM/PM, so spaces are compared as spaces.
 */
const spaced = (s: string) => s.replace(/\s/g, ' ')

describe('formatSaidAt', () => {
  it('writes the clock time only, in English with AM/PM', () => {
    expect(spaced(formatSaidAt(new Date(2026, 9, 18, 15, 42).getTime()))).toBe('3:42 PM')
    expect(spaced(formatSaidAt(new Date(2026, 9, 18, 9, 5).getTime()))).toBe('9:05 AM')
  })

  it('writes midnight and noon as a chat app does', () => {
    expect(spaced(formatSaidAt(new Date(2026, 9, 18, 0, 7).getTime()))).toBe('12:07 AM')
    expect(spaced(formatSaidAt(new Date(2026, 9, 18, 12, 0).getTime()))).toBe('12:00 PM')
  })
})

describe('formatDayLong', () => {
  it('names the weekday, the month and the year in English', () => {
    expect(formatDayLong(new Date(2026, 9, 18, 15, 42).getTime())).toBe('Sunday, October 18, 2026')
    expect(formatDayLong(new Date(2027, 0, 1, 0, 0).getTime())).toBe('Friday, January 1, 2027')
  })
})

describe('dayKey', () => {
  it('is one key for one local day, and a new one past midnight', () => {
    const morning = new Date(2026, 9, 18, 0, 0).getTime()
    const night = new Date(2026, 9, 18, 23, 59).getTime()
    const next = new Date(2026, 9, 19, 0, 0).getTime()
    expect(dayKey(morning)).toBe(dayKey(night))
    expect(dayKey(next)).not.toBe(dayKey(night))
    // The same day of another month or year is another day
    expect(dayKey(new Date(2026, 10, 18).getTime())).not.toBe(dayKey(morning))
    expect(dayKey(new Date(2027, 9, 18).getTime())).not.toBe(dayKey(morning))
  })
})

describe('formatReadAt', () => {
  const now = new Date(2026, 9, 27, 13, 5).getTime()

  it('writes the clock time alone for today', () => {
    expect(spaced(formatReadAt(new Date(2026, 9, 27, 9, 5).getTime(), now))).toBe('9:05 AM')
  })

  it('adds the date for an earlier day, and the year for an earlier year', () => {
    expect(spaced(formatReadAt(new Date(2026, 9, 25, 15, 42).getTime(), now))).toBe('Oct 25, 3:42 PM')
    expect(spaced(formatReadAt(new Date(2025, 11, 30, 15, 42).getTime(), now))).toBe('Dec 30, 2025, 3:42 PM')
  })

  it('treats just before midnight as yesterday, not today', () => {
    expect(spaced(formatReadAt(new Date(2026, 9, 26, 23, 59).getTime(), now))).toBe('Oct 26, 11:59 PM')
  })
})
