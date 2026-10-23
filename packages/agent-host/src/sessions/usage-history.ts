import type { ToolName, UsageHistory, UsageHistoryBy, UsageHistoryReadings, UsageHistoryRow } from '@cc/protocol'
import { mergeCauses, type StoredReading, type UsageBucket, type UsageRecords } from '../dev-services/store/usage-history.js'

/**
 * Answers `usage.history` (docs/agent-host.md §6.2) from what `UsageRecorder` stored: the readings of the limit
 * windows as they are, and the hourly buckets summed by day or hour and by one key.
 */

/** The key of the row that holds every key below the first `MAX_KEYS`, so a range of a hundred sessions stays small */
export const OTHERS_KEY = '*'
/** At most this many keys per answer, most tokens first */
export const MAX_KEYS = 50
/** The key of the sessions that belong to no project (the orchestrator) */
export const NO_PROJECT_KEY = 'none'

export type HistoryNames = {
  session(id: string): string | undefined
  project(id: string): string | undefined
}

export type HistoryParams = { from: number; to: number; groupBy: 'day' | 'hour'; by: UsageHistoryBy; tool?: ToolName }

const HOUR_MS = 60 * 60_000

/** The host's local midnight at or before `ms` */
function dayStart(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

const keyOf = (b: UsageBucket, by: UsageHistoryBy): string =>
  by === 'session' ? b.sessionId : by === 'project' ? b.projectId || NO_PROJECT_KEY : by === 'model' ? b.model : b.tool

function nameOf(key: string, by: UsageHistoryBy, names: HistoryNames): string {
  if (key === OTHERS_KEY) return 'Others'
  if (by === 'session') return names.session(key) ?? key
  if (by === 'project') return key === NO_PROJECT_KEY ? 'Orchestrator' : (names.project(key) ?? key)
  return key || 'Default model'
}

const tokensOf = (r: Pick<UsageHistoryRow, 'inputTokens' | 'cacheReadTokens' | 'cacheCreationTokens' | 'outputTokens'>): number =>
  r.inputTokens + r.cacheReadTokens + r.cacheCreationTokens + r.outputTokens

/** The buckets as rows per period and key; the keys past `MAX_KEYS` are summed into `OTHERS_KEY` */
export function historyRows(buckets: readonly UsageBucket[], p: Pick<HistoryParams, 'groupBy' | 'by'>, names: HistoryNames): UsageHistoryRow[] {
  const rows = new Map<string, UsageHistoryRow>()
  // A name is looked up once per key, not once per day and key: a lookup may be a query
  const named = new Map<string, string>()
  for (const b of buckets) {
    const period = p.groupBy === 'day' ? dayStart(b.hour) : b.hour
    const key = keyOf(b, p.by)
    const id = `${period}\n${key}`
    let r = rows.get(id)
    if (!r) {
      let name = named.get(key)
      if (name === undefined) named.set(key, (name = nameOf(key, p.by, names)))
      rows.set(id, (r = emptyRow(period, key, name)))
    }
    add(r, b)
  }
  const total = new Map<string, number>()
  for (const r of rows.values()) total.set(r.key, (total.get(r.key) ?? 0) + tokensOf(r))
  const keep = new Set([...total].sort((a, b) => b[1] - a[1]).slice(0, MAX_KEYS).map(([k]) => k))
  if (keep.size === total.size) return [...rows.values()].sort(byPeriod)
  const out = new Map<string, UsageHistoryRow>()
  for (const r of rows.values()) {
    if (keep.has(r.key)) {
      out.set(`${r.period}\n${r.key}`, r)
      continue
    }
    const id = `${r.period}\n${OTHERS_KEY}`
    let o = out.get(id)
    if (!o) out.set(id, (o = emptyRow(r.period, OTHERS_KEY, 'Others')))
    addRow(o, r)
  }
  return [...out.values()].sort(byPeriod)
}

const byPeriod = (a: UsageHistoryRow, b: UsageHistoryRow): number => (a.period < b.period ? -1 : a.period > b.period ? 1 : 0)

function emptyRow(period: number | string, key: string, name: string): UsageHistoryRow {
  return {
    period: typeof period === 'string' ? period : new Date(period).toISOString(),
    key,
    name,
    requests: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cacheCreation5mTokens: 0,
    cacheCreation1hTokens: 0,
    outputTokens: 0,
    rebuilds: 0,
    rebuildCauses: {},
  }
}

function add(r: UsageHistoryRow, b: UsageBucket): void {
  r.requests += b.requests
  r.inputTokens += b.input
  r.cacheReadTokens += b.cacheRead
  r.cacheCreationTokens += b.cacheWrite
  r.cacheCreation5mTokens += b.cacheWrite5m
  r.cacheCreation1hTokens += b.cacheWrite1h
  r.outputTokens += b.output
  r.rebuilds += b.rebuilds
  r.rebuildCauses = mergeCauses(r.rebuildCauses, b.causes)
}

function addRow(o: UsageHistoryRow, r: UsageHistoryRow): void {
  o.requests += r.requests
  o.inputTokens += r.inputTokens
  o.cacheReadTokens += r.cacheReadTokens
  o.cacheCreationTokens += r.cacheCreationTokens
  o.cacheCreation5mTokens += r.cacheCreation5mTokens
  o.cacheCreation1hTokens += r.cacheCreation1hTokens
  o.outputTokens += r.outputTokens
  o.rebuilds += r.rebuilds
  o.rebuildCauses = mergeCauses(o.rebuildCauses, r.rebuildCauses)
}

/** The readings as one series per tool, account and window */
export function readingSeries(readings: readonly StoredReading[]): UsageHistoryReadings[] {
  const series = new Map<string, UsageHistoryReadings>()
  for (const r of readings) {
    const id = `${r.tool}\n${r.account}\n${r.id}\n${r.scope ?? ''}`
    let s = series.get(id)
    if (!s) series.set(id, (s = { tool: r.tool, account: r.account, window: r.id, label: r.label, scope: r.scope, points: [] }))
    s.label = r.label
    s.points.push({ at: new Date(r.at).toISOString(), percent: r.percent, resetsAt: r.resetsAt === null ? null : new Date(r.resetsAt).toISOString() })
  }
  return [...series.values()]
}

/** `usage.history`: the readings taken in `[from, to)` and the token rows of the hours that begin in it */
export function usageHistory(usage: UsageRecords, p: HistoryParams, names: HistoryNames): UsageHistory {
  const firstHour = usage.firstHour(p.tool)
  const fromHour = Math.floor(p.from / HOUR_MS) * HOUR_MS
  return {
    by: p.by,
    readings: readingSeries(usage.readings(p.from, p.to, p.tool)),
    rows: historyRows(usage.buckets(fromHour, p.to, p.tool), p, names),
    ...(firstHour === null ? {} : { recordedSince: new Date(firstHour).toISOString() }),
  }
}

const num = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n))

/**
 * The orchestrator's `usage_history` (docs/agent-host.md §6.2): the top keys by tokens with their cache hit rate and
 * rebuilds, then how each limit window moved. A few lines: it is read to pace work, so it stays short.
 */
export function usageHistoryText(h: UsageHistory, days: number): string {
  const total = new Map<string, { name: string; row: UsageHistoryRow }>()
  for (const r of h.rows) {
    const t = total.get(r.key)
    if (!t) total.set(r.key, { name: r.name, row: { ...r, rebuildCauses: { ...r.rebuildCauses } } })
    else addRow(t.row, r)
  }
  const lines = [`Usage over the last ${days} day${days === 1 ? '' : 's'} on this computer, by ${h.by}:`]
  const top = [...total.values()].sort((a, b) => tokensOf(b.row) - tokensOf(a.row)).slice(0, 15)
  if (top.length === 0) lines.push('No requests recorded in this range.')
  for (const { name, row: r } of top) {
    const input = r.inputTokens + r.cacheReadTokens + r.cacheCreationTokens
    const hit = input > 0 ? `${Math.round((r.cacheReadTokens / input) * 100)}%` : '–'
    lines.push(`- ${name}: ${num(tokensOf(r))} tokens (in ${num(r.inputTokens)}, cache read ${num(r.cacheReadTokens)}, cache write ${num(r.cacheCreationTokens)}, out ${r.outputTokens > 0 ? num(r.outputTokens) : 'n/a'}), cache hit ${hit}, ${r.requests} requests, ${r.rebuilds} rebuilds`)
  }
  if (h.recordedSince) lines.push(`Recorded since ${h.recordedSince.slice(0, 16).replace('T', ' ')} UTC.`)
  for (const s of h.readings) {
    const first = s.points[0]
    const last = s.points[s.points.length - 1]
    if (!first || !last) continue
    lines.push(`Limit ${s.tool} ${s.label}${s.scope ? ` (${s.scope})` : ''}: ${first.percent}% → ${last.percent}% over ${s.points.length} readings${last.resetsAt ? `, resets ${last.resetsAt.slice(0, 16).replace('T', ' ')} UTC` : ''}`)
  }
  return lines.join('\n')
}
