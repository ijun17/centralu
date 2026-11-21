import { formatClock, formatDay } from '@cc/core'

export { formatClock, formatDay }

/**
 * One way every screen writes a size, a count and a length of time (#428); a moment is written in core, which needs it
 * too. One decimal below 100, none from there, and a value that rounds up to the next unit is written in it ("1 MB").
 */

/** The first unit is whole */
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

/** A count of changed files, "10k+" when the host stopped counting at its cap (`more`, #850) */
export const formatChangedCount = (n: number, more?: boolean): string =>
  more ? `${formatCount(n)}+` : String(n)

/**
 * The two largest units that matter, no space ("1.5s", "3m 20s", "2h 5m", "3d 4h"). Seconds stop at ten minutes, where
 * they stop being useful; `coarse` is for a wait read only to the minute. "1h 0m" keeps the width as a unit is added.
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

/** Under a message's bubble: the clock time only, as a divider says the day; English whatever the system's language */
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

export function dayKey(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

/** "3:42 PM" today, "Oct 25, 3:42 PM" earlier this year, "Dec 30, 2025, 3:42 PM" before */
export function formatReadAt(at: number, now: number): string {
  const time = formatSaidAt(at)
  if (dayKey(at) === dayKey(now)) return time
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear()
  const day = new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })
  return `${day}, ${time}`
}
