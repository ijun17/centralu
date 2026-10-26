import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { UsageSnapshot } from '@cc/protocol'
import { softRead } from '../usage-read.js'
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

/** `257.0K`, `1.2M`, `0`, `$12.50`, `1,234` as a number, or null for anything else */
export function parseAmount(text: string): number | null {
  const m = /^\$?\s*([\d,]*\.?\d+)\s*([KMB])?$/i.exec(text.trim())
  const digits = m?.[1]
  if (!digits) return null
  const n = Number(digits.replace(/,/g, ''))
  if (!Number.isFinite(n)) return null
  const k = SUFFIX.get((m[2] ?? '').toUpperCase()) ?? 1
  return Math.round(n * k * 100) / 100
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
 * tables are read by their labels, so a row it adds or moves does not shift the others, and one that is not a number is
 * left out. Output that holds none of them gives no totals rather than a wrong one.
 */
export function parseStats(stdout: string): UsageSnapshot {
  const found = new Map<string, number>()
  for (const raw of stdout.replace(ANSI, '').split(/\r?\n/)) {
    const line = raw.replace(/^[│|]\s*/, '').replace(/\s*[│|]$/, '').trim()
    for (const row of ROWS) {
      if (found.has(row.id) || !line.startsWith(row.match)) continue
      const n = parseAmount(line.slice(row.match.length))
      if (n !== null) found.set(row.id, n)
    }
  }
  const rows: Row[] = ROWS.flatMap((r) => {
    const value = found.get(r.id)
    return value === undefined ? [] : [{ id: r.id, label: r.label, value, unit: r.unit }]
  })
  return { plan: null, windows: [], daily: [], noLimits: true, ...(rows.length > 0 ? { totals: { scope: 'all time', rows } } : {}) }
}

const NO_LIMITS: UsageSnapshot = { plan: null, windows: [], daily: [], noLimits: true }

/** Totals move with every turn, but a panel needs them to the minute at best: a minute keeps a busy window from running a binary each time */
const FRESH_MS = 60_000
const FAIL_MS = 60_000
const SOFT_MS = 3_000
const RUN_MS = 15_000

export function openCodeUsageReader(): () => Promise<UsageSnapshot> {
  return softRead<UsageSnapshot>({
    freshMs: FRESH_MS,
    failMs: FAIL_MS,
    softMs: SOFT_MS,
    fallback: () => NO_LIMITS,
    onFail: (e) => console.error(`[usage] opencode: could not read the totals: ${e.message}`),
    read: async () => {
      const l = findOpenCode()
      if (!l) throw new Error('OpenCode not found')
      const r = await exec(l.command, [...l.args, 'stats'], { timeout: RUN_MS, windowsHide: true, maxBuffer: 1024 * 1024 })
      return parseStats(r.stdout)
    },
  })
}
