/**
 * One fixed format for a moment: English, 24-hour, the person's time zone (#428). Built by hand, not with `Intl`, so it
 * never depends on the machine's language or on how an engine spells midnight.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const
const two = (n: number): string => String(n).padStart(2, '0')

/** "15:12", or "15:12:05" with `seconds` */
export function formatClock(at: number | Date, opts: { seconds?: boolean } = {}): string {
  const d = new Date(at)
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`
  return opts.seconds ? `${hm}:${two(d.getSeconds())}` : hm
}

/** "17:02" today, "Nov 23, 17:02" on another day: a time waited for, which a bare clock would place on the wrong day */
export function formatWhen(at: number | Date, now: number | Date = Date.now()): string {
  const d = new Date(at)
  const n = new Date(now)
  const today = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
  return today ? formatClock(d) : `${formatDay(d, n)}, ${formatClock(d)}`
}

/** "Oct 16", or "Oct 16, 2025" when the year is not `now`'s */
export function formatDay(at: number | Date, now: number | Date = Date.now()): string {
  const d = new Date(at)
  const day = `${MONTHS[d.getMonth()]} ${d.getDate()}`
  return d.getFullYear() === new Date(now).getFullYear() ? day : `${day}, ${d.getFullYear()}`
}
