import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { UsageSnapshot } from '@cc/protocol'
import type { LocalUsage } from '../contract.js'
import { localUsageReader } from '../usage-read.js'
import { findOpenCode } from './install.js'

const exec = promisify(execFile)

type Row = NonNullable<UsageSnapshot['totals']>['rows'][number]

/** The rows kept from `opencode stats`, by the label it prints: what is used, not the averages it also prints */
const ROWS: { match: string; id: string; label: string; unit: Row['unit'] }[] = [
  { match: 'Sessions', id: 'sessions', label: 'Sessions', unit: 'count' },
  { match: 'Messages', id: 'messages', label: 'Messages', unit: 'count' },
  { match: 'Input', id: 'input', label: 'Input', unit: 'tokens' },
  { match: 'Output', id: 'output', label: 'Output', unit: 'tokens' },
  { match: 'Cache Read', id: 'cache-read', label: 'Cache read', unit: 'tokens' },
  { match: 'Cache Write', id: 'cache-write', label: 'Cache write', unit: 'tokens' },
  { match: 'Total Cost', id: 'cost', label: 'Cost', unit: 'usd' },
]

/**
 * `257.0K`, `1.2M`, `0`, `$12.50`, `1,234` as a number, or null for anything else. For the token and cost rows, which
 * `opencode stats` writes with `toFixed` and a suffix, never localized (measured, and confirmed in review RV1625); the
 * counts are `parseCount`'s.
 */
export function parseAmount(text: string): number | null {
  const m = /^\$?\s*([\d,]*\.?\d+)\s*([KMB])?$/i.exec(text.trim())
  const digits = m?.[1]
  if (!digits) return null
  const n = Number(digits.replace(/,/g, ''))
  if (!Number.isFinite(n)) return null
  const k = SUFFIX.get((m[2] ?? '').toUpperCase()) ?? 1
  return Math.round(n * k * 100) / 100
}

/**
 * The two count rows (sessions, messages) are written with `toLocaleString()` in the language of the computer (Windows'
 * regional setting; `LANG` is ignored): `1,204`, `1.204`, `1 204` with a no-break or narrow no-break space, `1'204`,
 * `1’204`, and the Indian `12,34,567`. A count is a whole number, so a separator can only be a grouping one: digits in
 * groups of exactly three behind one separator used throughout (two, then three, for the Indian grouping), or plain digits.
 * Reading `1.204` as a decimal, 1.2, is the error this avoids. Anything else is null: the row shows as unread, never as a
 * number that may be wrong.
 */
const GROUPED = /^\d{1,3}([.,\u00A0\u202F '’])\d{3}(?:\1\d{3})*$/
const LAKH = /^\d{1,2}(?:,\d{2})+,\d{3}$/
export function parseCount(text: string): number | null {
  const t = text.trim()
  if (!(/^\d+$/.test(t) || GROUPED.test(t) || LAKH.test(t))) return null
  const n = Number(t.replace(/\D/g, ''))
  return Number.isSafeInteger(n) ? n : null
}

const SUFFIX = new Map([
  ['K', 1e3],
  ['M', 1e6],
  ['B', 1e9],
])
/** A terminal colour sequence, in case the CLI colours its tables when it thinks it is on a screen */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

/**
 * OpenCode's usage (#1623). It has no limits to read; `opencode stats` prints what it counted on this computer as boxed
 * tables (measured, 1.19.4: no JSON form, `--days` and `--project` only narrow it, 0.8 to 1.3 s a run on Windows). The
 * tables are read by their labels (the label, then the value after two spaces or more), so a row it adds or moves does not
 * shift the others. A row it printed in a form that is not a number the host can trust has a null value: the screen shows
 * it as unread. A row it did not print is absent. Output that holds none of them gives no totals rather than a wrong one.
 */
export function parseStats(stdout: string): LocalUsage {
  const found = new Map<string, number | null>()
  for (const raw of stdout.replace(ANSI, '').split(/\r?\n/)) {
    const line = raw.replace(/^[│|]\s*/, '').replace(/\s*[│|]$/, '').trim()
    const cells = /^(\S.*?)\s{2,}(\S.*)$/.exec(line)
    const row = ROWS.find((r) => r.match === cells?.[1])
    if (!row || !cells?.[2] || found.has(row.id)) continue
    found.set(row.id, row.unit === 'count' ? parseCount(cells[2]) : parseAmount(cells[2]))
  }
  const rows: Row[] = ROWS.flatMap((r) => {
    const value = found.get(r.id)
    return value === undefined ? [] : [{ id: r.id, label: r.label, value, unit: r.unit }]
  })
  return { plan: null, ...(rows.length > 0 ? { totals: { scope: 'all time', rows } } : {}) }
}

/** What a read that has nothing (not finished, or failed) answers: no totals */
const NOTHING: LocalUsage = { plan: null }

/** Totals move with every turn, but a panel needs them to the minute at best: a minute keeps a busy window from running a binary each time */
const FRESH_MS = 60_000
const FAIL_MS = 60_000
const SOFT_MS = 3_000
/**
 * `opencode stats` reads every session it has, so a large database may take longer than the soft wait: the first answer is
 * then provisional and the panel receives the totals when the run ends (`settle`). A run that outlasts this is killed, read as
 * a failure, and not started again for `FAIL_MS`.
 */
const RUN_MS = 15_000

export function openCodeUsageReader(): (ask?: { settle?: boolean }) => Promise<LocalUsage> {
  return localUsageReader({
    freshMs: FRESH_MS,
    failMs: FAIL_MS,
    softMs: SOFT_MS,
    fallback: () => NOTHING,
    onFail: (e) => console.error(`[usage] opencode: could not read the totals: ${e.message}`),
    read: async () => {
      const l = findOpenCode()
      if (!l) throw new Error('OpenCode not found')
      const r = await exec(l.command, [...l.args, 'stats'], { timeout: RUN_MS, windowsHide: true, maxBuffer: 1024 * 1024 })
      return parseStats(r.stdout)
    },
  })
}
