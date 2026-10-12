/**
 * The measurement's summary, as a table to read and as JSON to compare (#513).
 *
 * `summarize` reduces the raw records to the numbers a decision reads; `printSummary` prints them;
 * `compare` prints two summaries side by side, before and after a change. The JSON a run writes holds
 * both the summary and the raw records, so a question the summary did not ask can still be answered
 * from the file.
 */
import type { ResidentCost } from '../../src/sessions/tool-cost.js'
import type { PartChange, Usage } from './recorder.mjs'

export type Cli = 'claude' | 'codex'

/** One request of a scripted session, as either CLI reports it */
export type RequestRow = {
  step: string
  event: string
  usage: Usage | null
  /** Claude, through the recorder: whether the tool list, the system prompt and the history were reused */
  tools?: PartChange
  deferredEntries?: PartChange
  deferredEntryNames?: string[]
  system?: PartChange
  history?: 'first' | 'extends' | { rewrittenAt: number }
  loadedCentralu?: string[]
  appLoaded?: string[]
  deferred?: string[]
  resultChars?: Record<string, number>
  /** The tool calls the model made: in this request's answer (Claude), or in the turn, on its first row (Codex) */
  toolCalls?: string[]
  /** The first request counted as sent and without Centralu's tools (Claude, recorder.mts) */
  counted?: { sent: number; withoutOurs: number }
  /** Characters of the request's tool list, of Centralu's loaded tools in it, and of the system prompt */
  chars?: { tools: number; centralu: number; system: number }
}

export type SelectionRun = {
  /** The Centralu and app tools called, in order (bare names), and every call's count */
  called: string[]
  calls: number
  verdict: 'right' | 'none' | 'wrong'
  /** 1-based position of the first expected call among all the turn's tool calls (tool search included) */
  steps: number | null
  /** The first expected call's arguments against the tool's schema; null when it was never called */
  firstArgsValid: boolean | null
  /** Those arguments, as the model wrote them */
  firstArgs: unknown
  firstOk: boolean | null
  /**
   * #512: whether an expected tool was called anywhere in the turn (a directing seat often looks at the sessions
   * first, which `verdict` counts as wrong), whether that call went through centralu_run, and how many calls
   * looked for a tool (tool search, centralu_commands, centralu_help)
   */
  reached?: boolean
  viaRun?: boolean | null
  discovery?: number
  /** #512: the turn's requests, their input tokens summed (cache included), output, cache writes, uncached input, and rebuilds within the turn */
  requests?: number
  tokens?: number
  output?: number
  cacheWrite?: number
  uncached?: number
  rebuilds?: number
}

export type CacheRows = (RequestRow & { total: number; lost: number | null })[]

export type Summary = {
  definitions: Record<Cli, Record<string, ResidentCost>>
  prefixWalk?: Record<string, RequestRow[]>
  resident?: Partial<Record<Cli, Record<string, { runs: number[]; median: number; delta: number | null; ours?: number; centraluChars?: number; toolsChars?: number; systemChars?: number }>>>
  cache?: Partial<Record<Cli, CacheRows[]>>
  results?: Partial<Record<Cli, (RequestRow & { total: number; added: number | null })[]>>
  selection?: Partial<Record<Cli, Record<string, { profile: string; expect: string[]; runs: SelectionRun[] }>>>
}

export const total = (u: Usage | null) => (u ? u.input + u.cacheRead + u.cacheWrite : 0)

export function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2)
}

/**
 * What the cache did not reuse: everything the previous request sent should be readable from cache
 * by the next one (Claude Code marks the newest message; Codex caches prefixes on its own), so the
 * shortfall is what was written or read again in full. More than one cache block (1,024 tokens) is a
 * rebuild.
 */
export function withLoss<T extends RequestRow>(rows: T[]): (T & { total: number; lost: number | null })[] {
  let prev: Usage | null = null
  return rows.map((r) => {
    const lost = prev && r.usage ? Math.max(0, total(prev) - r.usage.cacheRead) : null
    if (r.usage) prev = r.usage
    return { ...r, total: total(r.usage), lost }
  })
}

export const REBUILD_TOKENS = 1024

const pad = (s: unknown, n: number) => String(s).padEnd(n)
const lpad = (s: unknown, n: number) => String(s).padStart(n)
const k = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n.toLocaleString('en-US'))
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : '—')

function part(r: RequestRow): string {
  if (!r.tools) return ''
  const h = r.history === 'first' || r.history === 'extends' ? r.history : `rewritten@${r.history?.rewrittenAt}`
  const d = r.deferredEntries === 'changed' ? `, deferred entries changed (${r.deferredEntryNames?.length ?? 0})` : ''
  return `tools ${r.tools}${d}, system ${r.system}, history ${h}`
}

export function printSummary(s: Summary, log: (line: string) => void = console.log): void {
  log('\n== Resident definitions per profile (characters; tokens come from a live run) ==')
  log(`${pad('cli', 7)}${pad('profile', 14)}${lpad('tools', 6)}${lpad('resident', 9)}${lpad('chars', 8)}${lpad('deferred', 10)}${lpad('instr.', 8)}  prefix`)
  for (const cli of ['claude', 'codex'] as const) {
    for (const c of Object.values(s.definitions[cli] ?? {})) {
      log(`${pad(cli, 7)}${pad(c.profile, 14)}${lpad(c.tools, 6)}${lpad(c.residentTools, 9)}${lpad(k(c.residentChars), 8)}${lpad(k(c.deferredChars), 10)}${lpad(k(c.instructionsChars), 8)}  ${c.prefixHash}`)
    }
  }

  for (const [name, rows] of Object.entries(s.prefixWalk ?? {})) {
    log(`\n== Claude request prefix through a scripted session (${name}; real CLI, no model) ==`)
    for (const r of rows) {
      const chars = r.chars ? `  [tool list ${k(r.chars.tools)}, centralu ${k(r.chars.centralu)}, system ${k(r.chars.system)}]` : ''
      const results = Object.entries(r.resultChars ?? {}).map(([n, c]) => `${n.replace(/^mcp__centralu__/, '')} ${k(c)}`).join(', ')
      log(
        `${pad(r.step, 22)}${pad(r.event.slice(0, 43), 44)}${part(r)}${chars}` +
          `${r.appLoaded?.length ? `  app tools loaded: ${r.appLoaded.join(',')}` : ''}${results ? `  results: ${results}` : ''}`,
      )
    }
  }

  for (const [cli, kinds] of Object.entries(s.resident ?? {})) {
    log(`\n== Resident context per session kind, ${cli}: the first request's input tokens (API usage) ==`)
    log(`${pad('kind', 14)}${lpad('median', 9)}${lpad('Δ none', 9)}${lpad('Centralu', 10)}${lpad('runs', 24)}${lpad('centralu chars', 16)}`)
    for (const [kind, r] of Object.entries(kinds)) {
      log(
        `${pad(kind, 14)}${lpad(k(r.median), 9)}${lpad(r.delta === null ? '—' : (r.delta >= 0 ? '+' : '') + k(r.delta), 9)}${lpad(k(r.ours), 10)}` +
          `${lpad(r.runs.map(k).join(' '), 24)}${lpad(k(r.centraluChars), 16)}`,
      )
    }
    log('(Δ none: against a session with no Centralu tools, so a directing seat\'s other system prompt is in it; Centralu: the same request counted without Centralu\'s tools, names and instructions)')
  }

  for (const [cli, reps] of Object.entries(s.cache ?? {})) {
    reps.forEach((rows, i) => {
      log(`\n== Cache per request, ${cli}, repetition ${i + 1} (lost = what the request before it sent and this one did not read from cache) ==`)
      log(`${pad('step', 18)}${pad('event', 40)}${lpad('input', 7)}${lpad('read', 8)}${lpad('write', 8)}${lpad('out', 6)}${lpad('lost', 8)}  prefix`)
      for (const r of rows) {
        const u = r.usage
        const flag = r.lost !== null && r.lost > REBUILD_TOKENS ? ' REBUILD' : ''
        log(`${pad(r.step, 18)}${pad(r.event.slice(0, 39), 40)}${lpad(k(u?.input), 7)}${lpad(k(u?.cacheRead), 8)}${lpad(k(u?.cacheWrite), 8)}${lpad(k(u?.output), 6)}${lpad(k(r.lost), 8)}${flag}  ${part(r)}`)
      }
    })
  }

  for (const [cli, rows] of Object.entries(s.results ?? {})) {
    log(`\n== Tool results over a longer session, ${cli} ==`)
    log(`${pad('step', 22)}${pad('event', 40)}${lpad('input', 9)}${lpad('added', 8)}  result chars`)
    for (const r of rows) {
      const chars = Object.entries(r.resultChars ?? {}).map(([n, c]) => `${n.replace(/^mcp__centralu__/, '')} ${k(c)}`).join(', ')
      log(`${pad(r.step, 22)}${pad(r.event.slice(0, 39), 40)}${lpad(k(r.total), 9)}${lpad(k(r.added), 8)}  ${chars}`)
    }
  }

  for (const [cli, prompts] of Object.entries(s.selection ?? {})) {
    log(`\n== Tool selection, ${cli} ==`)
    log(
      `${pad('prompt', 22)}${pad('expects', 24)}${lpad('right', 7)}${lpad('none', 6)}${lpad('wrong', 7)}${lpad('reached', 9)}${lpad('steps', 7)}${lpad('args ok', 9)}${lpad('1st ok', 8)}` +
        `${lpad('reqs', 6)}${lpad('tokens', 9)}${lpad('out', 6)}${lpad('rebuild', 9)}  calls`,
    )
    for (const [id, p] of Object.entries(prompts)) {
      const n = p.runs.length
      const count = (v: SelectionRun['verdict']) => p.runs.filter((r) => r.verdict === v).length
      const steps = p.runs.map((r) => r.steps).filter((x): x is number => x !== null)
      const firsts = p.runs.map((r) => r.firstArgsValid).filter((x): x is boolean => x !== null)
      const oks = p.runs.map((r) => r.firstOk).filter((x): x is boolean => x !== null)
      const med = (f: (r: SelectionRun) => number | undefined) => {
        const xs = p.runs.map(f).filter((x): x is number => x !== undefined)
        return xs.length ? k(median(xs)) : '—'
      }
      log(
        `${pad(id, 22)}${pad(p.expect.join('|') || '(none)', 24)}${lpad(`${count('right')}/${n}`, 7)}${lpad(count('none'), 6)}${lpad(count('wrong'), 7)}` +
          `${lpad(p.runs.some((r) => r.reached !== undefined) ? `${p.runs.filter((r) => r.reached).length}/${n}` : '—', 9)}` +
          `${lpad(steps.length ? median(steps) : '—', 7)}${lpad(firsts.length ? `${firsts.filter(Boolean).length}/${firsts.length}` : '—', 9)}` +
          `${lpad(oks.length ? `${oks.filter(Boolean).length}/${oks.length}` : '—', 8)}` +
          `${lpad(med((r) => r.requests), 6)}${lpad(med((r) => r.tokens), 9)}${lpad(med((r) => r.output), 6)}${lpad(p.runs.reduce((x, r) => x + (r.rebuilds ?? 0), 0), 9)}` +
          `  ${p.runs.map((r) => r.called.join('>') || '-').join(' ; ')}`,
      )
    }
    log('(reqs, tokens, out: medians per turn, tokens = every request\'s input with cache; rebuild: requests within a turn that lost more than a cache block)')
  }
}

/** Two runs side by side: every number the summary holds, as `before → after (Δ)` */
export function compare(a: Summary, b: Summary, log: (line: string) => void = console.log): void {
  const delta = (x: number | null | undefined, y: number | null | undefined) =>
    x === null || x === undefined || y === null || y === undefined ? '' : ` (${y - x >= 0 ? '+' : ''}${k(y - x)})`
  const row = (label: string, x: number | null | undefined, y: number | null | undefined) => log(`${pad(label, 48)}${lpad(k(x), 10)} → ${lpad(k(y), 10)}${delta(x, y)}`)

  log('\n== Resident definitions (characters: resident + instructions) ==')
  for (const cli of ['claude', 'codex'] as const) {
    const names = new Set([...Object.keys(a.definitions[cli] ?? {}), ...Object.keys(b.definitions[cli] ?? {})])
    for (const p of names) {
      const x = a.definitions[cli]?.[p]
      const y = b.definitions[cli]?.[p]
      row(`${cli} ${p}`, x && x.residentChars + x.instructionsChars, y && y.residentChars + y.instructionsChars)
      if (x && y && x.prefixHash !== y.prefixHash) log(`${pad('', 48)}prefix ${x.prefixHash} → ${y.prefixHash}`)
    }
  }

  const walks = new Set([...Object.keys(a.prefixWalk ?? {}), ...Object.keys(b.prefixWalk ?? {})])
  for (const w of walks) {
    log(`\n== Claude prefix walk: ${w} (requests where the tool list or history was not reused) ==`)
    const broken = (rows: RequestRow[] | undefined) =>
      (rows ?? []).filter((r) => r.tools === 'changed' || r.system === 'changed' || (typeof r.history === 'object' && r.history !== null)).map((r) => `${r.step}: ${part(r)}`)
    log(`  before: ${broken(a.prefixWalk?.[w]).join(' | ') || 'none'}`)
    log(`  after:  ${broken(b.prefixWalk?.[w]).join(' | ') || 'none'}`)
  }

  for (const cli of ['claude', 'codex'] as const) {
    const ra = a.resident?.[cli]
    const rb = b.resident?.[cli]
    if (ra || rb) {
      log(`\n== Resident context, ${cli} (first request input tokens, median) ==`)
      for (const kind of new Set([...Object.keys(ra ?? {}), ...Object.keys(rb ?? {})])) {
        row(`${kind}`, ra?.[kind]?.median, rb?.[kind]?.median)
        row(`${kind} Δ vs none`, ra?.[kind]?.delta, rb?.[kind]?.delta)
        row(`${kind} Centralu's own (count_tokens)`, ra?.[kind]?.ours, rb?.[kind]?.ours)
      }
    }
    const ca = a.cache?.[cli]
    const cb = b.cache?.[cli]
    if (ca || cb) {
      log(`\n== Cache, ${cli}: tokens not reused, per step (summed over repetitions) ==`)
      const byStep = (reps: CacheRows[] | undefined) => {
        const m = new Map<string, { lost: number; rebuilds: number; requests: number }>()
        for (const rows of reps ?? []) {
          for (const r of rows) {
            const e = m.get(r.step) ?? { lost: 0, rebuilds: 0, requests: 0 }
            e.lost += r.lost ?? 0
            e.rebuilds += r.lost !== null && r.lost > REBUILD_TOKENS ? 1 : 0
            e.requests++
            m.set(r.step, e)
          }
        }
        return m
      }
      const x = byStep(ca)
      const y = byStep(cb)
      for (const step of new Set([...x.keys(), ...y.keys()])) {
        row(`${step} lost`, x.get(step)?.lost, y.get(step)?.lost)
        row(`${step} rebuilds`, x.get(step)?.rebuilds, y.get(step)?.rebuilds)
      }
    }
    const sa = a.selection?.[cli]
    const sb = b.selection?.[cli]
    if (sa || sb) {
      log(`\n== Tool selection, ${cli} (right of runs; first-try argument validity) ==`)
      for (const id of new Set([...Object.keys(sa ?? {}), ...Object.keys(sb ?? {})])) {
        const rate = (p: { runs: SelectionRun[] } | undefined) => (p ? `${p.runs.filter((r) => r.verdict === 'right').length}/${p.runs.length}` : '—')
        const args = (p: { runs: SelectionRun[] } | undefined) => {
          const f = (p?.runs ?? []).map((r) => r.firstArgsValid).filter((v): v is boolean => v !== null)
          return f.length ? pct(f.filter(Boolean).length, f.length) : '—'
        }
        log(`${pad(id, 48)}${lpad(rate(sa?.[id]), 10)} → ${lpad(rate(sb?.[id]), 10)}   args ${args(sa?.[id])} → ${args(sb?.[id])}`)
      }
    }
    const xa = a.results?.[cli]
    const xb = b.results?.[cli]
    if (xa || xb) {
      log(`\n== Result growth, ${cli} (input tokens of the last request of the scripted session) ==`)
      row('last request input', xa?.at(-1)?.total, xb?.at(-1)?.total)
      const added = (rows: typeof xa) => (rows ?? []).reduce((n, r) => n + (r.added ?? 0), 0)
      row('added over the session', added(xa), added(xb))
    }
  }
}
