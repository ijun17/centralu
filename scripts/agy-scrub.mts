#!/usr/bin/env -S npx tsx
/**
 * Turns a raw `agy` recording (`scripts/agy-record.mts`) into a fixture (docs/plans/antigravity-adapter.md §10.1, #1498).
 *
 *   pnpm exec tsx scripts/agy-scrub.mts --version <agy version> <raw.jsonl>... --to <fixture folder>
 *
 * The fixture is one header line, then per line of the run:
 *
 *   {t, dir: 'spawn', args}         a process started, with its arguments
 *   {t, dir: 'out', msg}            a line written to agy's stdin (the repository's direction names: `out` goes to the tool)
 *   {t, dir: 'in', msg}             a line agy printed on stdout
 *   {t, dir: 'err', text}           a line agy printed on stderr, kept: the unknown-id warning and `error: interrupted` are read
 *   {t, dir: 'gate', msg}           a hook request the gate got and what it answered
 *   {t, dir: 'exit', code, signal}  how the process ended
 *   {t, dir: 'note', msg}           what the recorder checked itself (whether a command ran)
 *
 * Scrubbed, on top of the shared rules (`frames-scrub.mts`: home, temp and user, credentials, email addresses):
 * conversation ids become `conv-<n>` and any other id `id-<n>`, wherever they appear (a transcript path, a log line);
 * agy's state folder becomes `<agy-home>`, the plugin root `<plugin-root>`, the working folder `<cwd>`. The text the
 * model streams in pieces is scrubbed joined (#1562 review). The tool list in `init` is kept: it is the drift baseline.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { scrubPieces } from './frames-scrub.mts'

type Raw = { t: number; dir: string; line?: string; msg?: Record<string, unknown> }

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const ZERO_UUID = '00000000-0000-4000-8000-000000000000'
const CONVERSATION_KEY = /^(conversation_?id|conversationId|root_conversation_id)$/i

/** The same folder as `/var/…` and `/private/var/…` (macOS resolves the temp folder to the second) */
const forms = (p: string): string[] => {
  const plain = [p, p.replace(/^\/private\//, '/'), p.startsWith('/var/') ? `/private${p}` : p]
  // As a `file://` URI writes it (`log_uri`, `workspace_uris`): a name with a space or a non-ASCII letter is escaped
  return [...new Set([...plain, ...plain.map((f) => encodeURI(f))])]
}

export function scrubAgy(raw: readonly Raw[], places: { home?: string } = {}): unknown[] {
  const home = places.home ?? homedir()
  const parsed = raw.map((r) => ({ ...r, msg: r.msg ?? (r.line && (r.dir === 'in' || r.dir === 'out') ? tryJson(r.line) : undefined) }))

  // The folders this run used: the plugin root from the arguments, the working folder from `init`
  const roots: [string, string][] = []
  for (const r of parsed) {
    const args = r.dir === 'spawn' ? ((r.msg?.args as string[] | undefined) ?? []) : []
    const i = args.indexOf('--add-dir')
    if (i >= 0 && args[i + 1]) for (const f of forms(args[i + 1]!)) roots.push([f, '<plugin-root>'])
    const cwd = (r.msg?.init as { cwd?: string } | undefined)?.cwd
    if (r.dir === 'in' && cwd) for (const f of forms(cwd)) roots.push([f, '<cwd>'])
  }
  for (const f of forms(join(home, '.gemini', 'antigravity-cli'))) roots.push([f, '<agy-home>'])
  roots.sort((a, b) => b[0].length - a[0].length)

  // Conversation ids first, in order of appearance; every other id after
  const ids = new Map<string, string>()
  let conv = 0
  let other = 0
  const collect = (v: unknown, key?: string): void => {
    if (typeof v === 'string') {
      if (key && CONVERSATION_KEY.test(key) && /^[0-9a-f-]{36}$/i.test(v) && v !== ZERO_UUID && !ids.has(v.toLowerCase())) ids.set(v.toLowerCase(), `conv-${++conv}`)
    } else if (Array.isArray(v)) v.forEach((x) => collect(x))
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) collect(x, k)
  }
  for (const r of parsed) collect(r.msg)

  const text = (s: string): string => {
    let out = s
    for (const [from, to] of roots) out = out.split(from).join(to)
    out = out.replace(UUID, (u) => {
      const k = u.toLowerCase()
      if (k === ZERO_UUID) return u
      if (!ids.has(k)) ids.set(k, `id-${++other}`)
      return ids.get(k)!
    })
    return scrubPieces([out], { cwd: '<cwd>', home })[0]!
  }
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return text(v)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }

  const out: Record<string, unknown>[] = []
  for (const r of parsed) {
    if (r.dir === 'header') continue
    if (r.dir === 'exit') out.push({ t: r.t, dir: 'exit', code: (r.msg?.code as number | null) ?? null, signal: (r.msg?.sig as string | null) ?? null })
    else if (r.dir === 'err') out.push({ t: r.t, dir: 'err', text: text(r.line ?? '') })
    else if (r.dir === 'spawn') out.push({ t: r.t, dir: 'spawn', args: walk(r.msg?.args ?? []) })
    else if (r.dir === 'in' || r.dir === 'out') out.push({ t: r.t, dir: r.dir, msg: r.msg === undefined ? { unparsed: text(r.line ?? '') } : walk(r.msg) })
    else out.push({ t: r.t, dir: r.dir, msg: walk(r.msg) })
  }
  rejoinDeltas(out, text)
  for (const f of out) if (f.dir === 'in') blankQuota(f.msg)
  return out
}

/**
 * `/usage` answers with the account's own quota: how much is left and when its week resets. The shape is what a test
 * reads, so the reading becomes a fixed one (half left, a fixed reset time), in its structured form and in its text.
 */
function blankQuota(msg: unknown): void {
  const m = msg as { response?: unknown; command?: { name?: unknown; data?: unknown } } | undefined
  if (m?.command?.name !== 'usage') return
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(visit)
    if (!v || typeof v !== 'object') return
    const o = v as Record<string, unknown>
    if (typeof o.remaining_fraction === 'number') o.remaining_fraction = 0.5
    if (typeof o.reset_time === 'string') o.reset_time = FIXED_RESET
    // "it will fully refresh in 5 days, 9 hours": when this account's week ends
    if (typeof o.description === 'string') o.description = o.description.replace(/\b\d+ (day|hour|minute|second)s?\b/g, '1 $1')
    Object.values(o).forEach(visit)
  }
  visit(m.command.data)
  if (typeof m.response === 'string') m.response = m.response.replace(/\b\d{1,3}%/g, '50%').replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, FIXED_RESET)
}
const FIXED_RESET = '2026-01-01T00:00:00Z'

/**
 * Each answer's streamed pieces (`agent_response` frames of one step) scrubbed as the text they make: a path split over two
 * pieces is found whole. When the joined text scrubs differently from its pieces, the whole scrubbed text goes in the first
 * piece and the others are emptied, so nothing private is left in any of them.
 */
function rejoinDeltas(frames: Record<string, unknown>[], text: (s: string) => string): void {
  const runs = new Map<string, { text_delta: string }[]>()
  for (const f of frames) {
    const su = f.dir === 'in' ? ((f.msg as { step_update?: { step_type?: string; conversation_id?: string; step_index?: number; text_delta?: unknown } }).step_update ?? null) : null
    if (su?.step_type !== 'agent_response' || typeof su.text_delta !== 'string') continue
    const key = `${su.conversation_id}:${su.step_index}`
    runs.set(key, [...(runs.get(key) ?? []), su as { text_delta: string }])
  }
  for (const run of runs.values()) {
    const joined = run.map((p) => p.text_delta).join('')
    const scrubbed = text(joined)
    if (scrubbed === joined) continue
    run.forEach((p, i) => (p.text_delta = i === 0 ? scrubbed : ''))
  }
}

function tryJson(line: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(line) as Record<string, unknown>
  } catch {
    return undefined
  }
}

const isMain = process.argv[1]?.endsWith('agy-scrub.mts')
if (isMain) {
  const flag = (name: string) => {
    const i = process.argv.indexOf(`--${name}`)
    return i > 0 ? process.argv[i + 1] : undefined
  }
  const version = flag('version')
  const to = flag('to')
  const inputs = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--'))
  if (!version || !to || !inputs.length) {
    console.error('usage: agy-scrub.mts --version <agy version> <raw.jsonl>... --to <fixture folder>')
    process.exit(2)
  }
  for (const input of inputs) {
    const raw = readFileSync(input, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Raw)
    const head = raw.find((r) => r.dir === 'header')?.msg ?? {}
    const scenario = String(head.scenario ?? basename(input).replace(/\.raw\.jsonl$/, ''))
    const header = { header: { tool: 'agy', version, scenario, what: head.what, model: head.model, os: process.platform, recorded: new Date().toISOString().slice(0, 10) } }
    const file = join(to, `${scenario}.jsonl`)
    writeFileSync(file, [header, ...scrubAgy(raw)].map((l) => JSON.stringify(l)).join('\n') + '\n')
    console.log(`wrote ${file}`)
  }
}
