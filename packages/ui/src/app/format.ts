import { formatClock, formatDay } from '@cc/core'

export { formatClock, formatDay }

/**
 * How the app writes a size, a count and a length of time (#428). (A moment, `formatClock` and `formatDay`, is written
 * in core, which needs it too.)
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

/** A count of changed files, "10k+" when the host stopped counting at its cap (`more`, #850 review) */
export const formatChangedCount = (n: number, more?: boolean): string =>
  more ? `${formatCount(n)}+` : String(n)

/**
 * A length of time, in one style: the two largest units that matter, no space before a unit ("1.5s", "3m 20s", "2h 5m",
 * "3d 4h"). Eight places each wrote their own and disagreed: "42 s" beside "42s", "75h 3m" past a day, "125.0 s",
 * a 4-hour wait spelled "4 hours".
 *
 * - Precise (default): milliseconds under a second ("250ms"), tenths under ten seconds ("1.5s"), whole seconds to a
 *   minute, minutes and seconds to ten minutes ("9m 50s": a precision that stops being useful there), then minutes.
 * - `coarse`: for a wait that is only ever read to the minute: whole seconds to a minute, then minutes only.
 *
 * Under a day the hours and minutes are both written ("1h 0m"), so a count that grows a unit does not change width.
 */
export function formatDuration(ms: number, { coarse = false }: { coarse?: boolean } = {}): string {
  const total = Math.max(0, Number.isFinite(ms) ? ms : 0)
  if (!coarse && total < 1000) return `${Math.floor(total)}ms`
  if (!coarse && total < 10_000) return `${Math.floor(total / 100) / 10}s`
  const s = Math.floor(total / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (!coarse && s < 600) return `${m}m ${s % 60}s`
  if (m < 60) return `${m}m`
  if (m < 1440) return `${Math.floor(m / 60)}h ${m % 60}m`
  return `${Math.floor(m / 1440)}d ${Math.floor(m / 60) % 24}h`
}

/**
 * The time under a message's bubble (owner, 2026-10-18), as a chat app writes it: the clock time only ("3:42 PM"),
 * since a divider in the conversation says the day (`formatDayLong`). In English whatever the system's language: the
 * app's words are English.
 */
export function formatSaidAt(at: number): string {
  return new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

/** The day a divider in the conversation names ("Saturday, October 18, 2026") */
export function formatDayLong(at: number): string {
  return new Date(at).toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

/** The local calendar day a moment falls on, for comparing two moments */
export function dayKey(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}
