/**
 * How the app writes a size and a count (#428).
 *
 * Eight places each wrote their own, and the copies disagreed: a byte size came out as "5120.0 MB", "1024.0 KB", "0KB"
 * or "630MB" depending on the screen, a token count as "1000k" or "2500.0k". One rule: the number is scaled to the largest
 * unit it reaches, written with one decimal below 100 and none from there ("1.5 KB", "630 MB", "8.5 GB"), and a value
 * that rounds up to the next unit is written in it ("1 MB", not "1024 KB").
 */

/** `n` scaled by `base` until its rounded value is below `base`, with the unit it ended on; the first unit is whole */
function scaled(n: number, base: number, units: readonly string[]): string {
  const round = (v: number) => (v < 100 ? Math.round(v * 10) / 10 : Math.round(v))
  let value = Math.max(0, Number.isFinite(n) ? n : 0)
  let i = 0
  while (i < units.length - 1 && round(value) >= base) {
    value /= base
    i++
  }
  return `${i === 0 ? Math.round(value) : round(value)}${units[i]}`
}

const BYTE_UNITS = [' B', ' KB', ' MB', ' GB', ' TB'] as const
const COUNT_UNITS = ['', 'k', 'M', 'B'] as const

/** A size in bytes: 812 B, 1.5 KB, 630 MB, 8.5 GB */
export const formatBytes = (n: number): string => scaled(n, 1024, BYTE_UNITS)

/** A count in a few characters, for tokens: 812, 1.5k, 12.4k, 540k, 1.9M */
export const formatCount = (n: number): string => scaled(n, 1000, COUNT_UNITS)
