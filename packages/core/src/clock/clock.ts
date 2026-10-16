/**
 * How the app writes a moment: one fixed format, English, 24-hour, in the person's own time zone (#428).
 *
 * Before, a clock was written four ways: forced `en-US` ("03:12 PM"), the system's locale (so the same app showed "15:12"
 * on one screen and "3:12 PM" on the next), a date as "10/16/2026" or "Oct 16", and by hand in the usage cache. They are
 * built by hand here, not through `Intl`, so what is written never depends on the machine's language or on how an
 * engine spells midnight.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const
const two = (n: number): string => String(n).padStart(2, '0')

/** "15:12", or "15:12:05" with `seconds` */
export function formatClock(at: number | Date, opts: { seconds?: boolean } = {}): string {
  const d = new Date(at)
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`
  return opts.seconds ? `${hm}:${two(d.getSeconds())}` : hm
}

/** "Oct 16", with the year ("Oct 16, 2025") when it is not `now`'s: a date a year old would otherwise read as this year's */
export function formatDay(at: number | Date, now: number | Date = Date.now()): string {
  const d = new Date(at)
  const day = `${MONTHS[d.getMonth()]} ${d.getDate()}`
  return d.getFullYear() === new Date(now).getFullYear() ? day : `${day}, ${d.getFullYear()}`
}
