#!/usr/bin/env -S npx tsx
/**
 * The recordings' canary (#1498 step 3, owner decision 2026-11-09): a new CLI version is not re-recorded whole. A few
 * representative scenarios are recorded on it, compared with the newest version recorded before by the frames' shape
 * (which kinds of frame, with which field names; never their values or their timing), and only where they differ is more
 * re-recorded. This script decides that, not an agent's judgement:
 *
 *   pnpm frames:canary <claude | codex> [--compare-only]
 *
 * - The installed CLI's version (as the host reads it) names its folder, `adapters/<tool>/recordings/<tool>-<version>/`.
 *   The canary scenarios that folder lacks are recorded there by `scripts/frames-record.mts` (it spends model calls on
 *   the cheapest model; `--compare-only` records nothing and compares what is there).
 * - The canary scenarios, as one set, are compared with the same set on the newest earlier version that has them all.
 * - No difference: it says the earlier version's recordings still hold, exit 0. A difference: it prints it and names the
 *   scenarios to re-record (every scenario recorded on the earlier version whose frames hold a kind of frame that is gone
 *   or lost a field, and the canary scenarios that showed a new kind), exit 1. New fields are printed, not counted.
 * - Either way, the new recordings stay: the replay tests run every version's folder.
 *
 * What a canary run cost is read from the recordings it made (Claude Code's `total_cost_usd`); Codex's frames carry none.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const ADAPTERS = join(ROOT, 'packages/agent-host/src/adapters')

/**
 * The scenarios a canary records, per tool: few and cheap, and between them every kind of frame a session lives on (a plain
 * turn, a tool call the person approves, the model's thinking or reasoning, an interrupt)
 */
export const CANARY: Record<string, readonly string[]> = {
  claude: ['basic', 'approval', 'thinking', 'interrupt'],
  // Codex shows its reasoning in every turn: `basic` carries it. An MCP tool call stands in for the thinking scenario
  codex: ['basic', 'approval', 'interrupt', 'mcp-call'],
}

/** The recordings folder of each tool, and the prefix of its version folders */
const FOLDERS: Record<string, { dir: string; prefix: string }> = {
  claude: { dir: join(ADAPTERS, 'claude', 'recordings'), prefix: 'claude-code-' },
  codex: { dir: join(ADAPTERS, 'codex', 'recordings'), prefix: 'codex-' },
}

/** One recorded line: which way it went (`in` from the tool, `out` to it, `exit`), and the message */
export type Frame = { dir: string; msg?: unknown }

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** A JSON-RPC message (Codex's app-server), as against a stream-json line (Claude Code) */
const isRpc = (m: Obj) => 'jsonrpc' in m || (typeof m.method === 'string' && !('type' in m)) || ('id' in m && ('result' in m || 'error' in m) && !('type' in m))

/** The kinds of a content list (`text`, `tool_use`, …), in order, without repeats */
const contentKinds = (content: unknown): string => (Array.isArray(content) ? [...new Set(content.map((c) => (isObj(c) ? str(c.type) : typeof c)))].join('+') : typeof content)

/**
 * What kind of frame this is, as a word that does not depend on values a run chooses (ids, text, times): the message's type
 * and subtype, a stream event's type and its delta's, a message's content kinds, a JSON-RPC method (an answer: the method it
 * answers, which `methods` remembers by id)
 */
export function frameKind(f: Frame, methods: Map<string, string> = new Map()): string {
  if (f.dir === 'exit') return 'exit'
  const m = f.msg
  if (!isObj(m)) return `${f.dir} ${typeof m}`
  if (isRpc(m)) {
    const id = m.id === undefined ? null : `${f.dir === 'in' ? 'out' : 'in'}:${String(m.id)}`
    if (typeof m.method === 'string') {
      if (m.id !== undefined) methods.set(`${f.dir}:${String(m.id)}`, m.method)
      const p = isObj(m.params) ? m.params : {}
      const item = isObj(p.item) ? str(p.item.type) : isObj(p.msg) ? str(p.msg.type) : ''
      return `${f.dir} ${m.method}${item ? `:${item}` : ''}`
    }
    const asked = id ? methods.get(id) : undefined
    return `${f.dir} ${'error' in m ? 'error' : 'result'}${asked ? `:${asked}` : ''}`
  }
  const type = str(m.type)
  if (type === 'control_request') return `${f.dir} control_request:${isObj(m.request) ? str(m.request.subtype) : ''}`
  if (type === 'control_response') return `${f.dir} control_response:${isObj(m.response) ? str(m.response.subtype) : ''}`
  if (type === 'stream_event' && isObj(m.event)) {
    const e = m.event
    const sub = isObj(e.delta) ? str(e.delta.type) : isObj(e.content_block) ? str(e.content_block.type) : ''
    return `${f.dir} stream_event:${str(e.type)}${sub ? `/${sub}` : ''}`
  }
  if ((type === 'assistant' || type === 'user') && isObj(m.message)) return `${f.dir} ${type}:${contentKinds(m.message.content)}`
  return `${f.dir} ${type}${typeof m.subtype === 'string' ? `:${m.subtype}` : ''}`
}

/**
 * A key that is data rather than a name: an id (`toolu_01Qj…`, a uuid), a path, a number, a model's or a server's name used
 * as a key (`claude-haiku-5-5`)
 */
const dataKey = (k: string) =>
  k.length > 40 || /^\d+$/.test(k) || /[/\\.:\s@]/.test(k) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(k) || /^[a-z]+_[A-Za-z0-9]{16,}$/.test(k) || /-\d/.test(k)

/** The field names a message holds, as paths (`message.content[].type`), never its values; keys that are data read `*` */
export function fieldPaths(v: unknown, at = '', out: Set<string> = new Set(), depth = 0): Set<string> {
  if (depth > 8) return out
  if (Array.isArray(v)) {
    for (const x of v) fieldPaths(x, `${at}[]`, out, depth + 1)
    return out
  }
  if (!isObj(v)) return out
  for (const [k, x] of Object.entries(v)) {
    const path = `${at ? `${at}.` : ''}${dataKey(k) ? '*' : k}`
    out.add(path)
    fieldPaths(x, path, out, depth + 1)
  }
  return out
}

/** One kind of frame in a shape: how many frames of it there were, and in how many of them each field name was */
export type KindShape = { frames: number; fields: Map<string, number> }

/**
 * Recordings' shape: the kinds of frame they hold and each kind's field names. Not their order: frames that come from a timer
 * (the host's context-usage polls, rate-limit notices) and the process's exit land at another place on every run, and the
 * replay tests of the new recordings check the order the adapter depends on
 */
export type Shape = Map<string, KindShape>

export function shapeOf(frames: readonly Frame[]): Shape {
  const methods = new Map<string, string>()
  const shape: Shape = new Map()
  for (const f of frames) {
    const kind = frameKind(f, methods)
    const k = shape.get(kind) ?? { frames: 0, fields: new Map<string, number>() }
    k.frames++
    for (const p of fieldPaths(f.msg)) k.fields.set(p, (k.fields.get(p) ?? 0) + 1)
    shape.set(kind, k)
  }
  return shape
}

/**
 * The shape of several recordings together. The canary compares its scenarios as one set: whether the model thinks before a
 * plain answer, or calls a tool once or twice, is its choice on that run, and a kind one scenario of the set shows is the set's
 */
export function mergeShapes(shapes: Iterable<Shape>): Shape {
  const all: Shape = new Map()
  for (const shape of shapes)
    for (const [kind, k] of shape) {
      const a = all.get(kind) ?? { frames: 0, fields: new Map<string, number>() }
      a.frames += k.frames
      for (const [p, n] of k.fields) a.fields.set(p, (a.fields.get(p) ?? 0) + n)
      all.set(kind, a)
    }
  return all
}

/** How two shapes differ; every list empty when they do not */
export type ShapeDiff = {
  /** Kinds of frame only the earlier version sent */
  gone: string[]
  /** Kinds of frame only the new version sent */
  added: string[]
  /**
   * Per kind both sent: the field names every frame of it held before and none holds now (`gone`), and the names only the new
   * version has (`added`). A name only some frames held before (`rate_limit_info.utilization`, the fields of an empty list's
   * items) is one a run may leave out, so its absence is no change
   */
  fields: { kind: string; gone: string[]; added: string[] }[]
}

/**
 * `unread`: kinds whose absence changes nothing, as the adapter makes nothing of them (its surface's dropped messages). The
 * process's exit is never counted: whether it lands before the recorder stops is the run's timing
 */
export function diffShapes(before: Shape, now: Shape, unread: ReadonlySet<string> = new Set()): ShapeDiff {
  const gone = [...before.keys()].filter((k) => !now.has(k) && k !== 'exit' && !unread.has(k)).sort()
  const added = [...now.keys()].filter((k) => !before.has(k) && k !== 'exit').sort()
  const fields = [...before.keys()]
    .filter((k) => now.has(k))
    .sort()
    .map((kind) => {
      const b = before.get(kind)!
      const n = now.get(kind)!
      return {
        kind,
        gone: [...b.fields].filter(([p, count]) => count === b.frames && !n.fields.has(p)).map(([p]) => p).sort(),
        added: [...n.fields.keys()].filter((p) => !b.fields.has(p)).sort(),
      }
    })
    .filter((f) => f.gone.length || f.added.length)
  return { gone, added, fields }
}

/**
 * Whether the new version sends something the earlier recordings do not hold: a kind of frame gone or new, or a field every
 * frame of a kind had gone. A new field alone is not: the adapter reads none it was not written for, and the replay tests say
 * when one it was written for is missing
 */
export const differs = (d: ShapeDiff) => d.gone.length > 0 || d.added.length > 0 || d.fields.some((f) => f.gone.length > 0)

/**
 * The scenarios to re-record on the new version: every scenario recorded on the earlier version whose frames hold a kind that
 * is gone or lost a field, and every canary scenario whose new frames hold a kind the earlier version never sent
 */
export function toRerecord(d: ShapeDiff, earlier: ReadonlyMap<string, Shape>, now: ReadonlyMap<string, Shape>): string[] {
  const changed = new Set([...d.gone, ...d.fields.filter((f) => f.gone.length).map((f) => f.kind)])
  const added = new Set(d.added)
  const names = new Set<string>()
  for (const [name, shape] of earlier) if ([...shape.keys()].some((k) => changed.has(k))) names.add(name)
  for (const [name, shape] of now) if ([...shape.keys()].some((k) => added.has(k))) names.add(name)
  return [...names].sort()
}

/** What a recording's run cost, from Claude Code's `total_cost_usd` (cumulative within a process): null when its frames carry none */
export function costOf(frames: readonly Frame[]): number | null {
  let total = 0
  let process = 0
  let seen = false
  for (const f of frames) {
    if (f.dir === 'exit') {
      total += process
      process = 0
      continue
    }
    const m = f.msg
    if (isObj(m) && m.type === 'result' && typeof m.total_cost_usd === 'number') {
      process = Math.max(process, m.total_cost_usd)
      seen = true
    }
  }
  return seen ? total + process : null
}

/** The frames of a recording file (its header line left out) */
export function readFrames(file: string): Frame[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Frame & { header?: unknown })
    .filter((l) => !('header' in l))
}

const versionOf = (name: string, prefix: string) => name.slice(prefix.length)
const semver = (v: string) => v.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x))
/** Newest first */
const byVersion = (a: string, b: string) => {
  const x = semver(a)
  const y = semver(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] ?? -1
    const q = y[i] ?? -1
    if (p !== q) return typeof p === 'number' && typeof q === 'number' ? q - p : String(q).localeCompare(String(p))
  }
  return 0
}

/** The newest version other than `version` whose folder holds every scenario of `names` */
export function earlierVersion(versions: readonly string[], version: string, has: (v: string) => boolean): string | null {
  return [...versions].filter((v) => v !== version && byVersion(v, version) > 0 && has(v)).sort(byVersion)[0] ?? null
}

/** The kinds of frame an adapter drops on purpose (its surface's `dropped` messages), as `frameKind` names them */
export function unreadKinds(tool: string, limitations: readonly { kind: string; name: string; treatment: string }[]): Set<string> {
  const dropped = limitations.filter((l) => l.kind === 'message' && l.treatment === 'dropped').map((l) => l.name)
  return new Set(dropped.map((n) => (tool === 'claude' ? `in ${n.replace('/', ':')}` : `in ${n}`)))
}

async function limitationsOf(tool: string) {
  if (tool === 'claude') return (await import('../packages/agent-host/src/adapters/claude/surface.js')).CLAUDE_LIMITATIONS
  return (await import('../packages/agent-host/src/adapters/codex/surface.js')).CODEX_LIMITATIONS
}

async function installedVersion(tool: string): Promise<string | null> {
  if (tool === 'claude') {
    const { ClaudeAdapter } = await import('../packages/agent-host/src/adapters/claude/index.js')
    return (await new ClaudeAdapter().installedVersion()) ?? null
  }
  const { CodexAdapter } = await import('../packages/agent-host/src/adapters/codex/index.js')
  const v = await new CodexAdapter().installedVersion?.()
  return v ? v.replace(/^codex-cli /, '').split(/[-\s]/)[0]! : null
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const compareOnly = args.includes('--compare-only')
  const tool = args.find((a) => !a.startsWith('--'))
  if (!tool || !CANARY[tool]) {
    console.error('usage: pnpm frames:canary <claude | codex> [--compare-only]')
    return 2
  }
  const { dir, prefix } = FOLDERS[tool]!
  const names = CANARY[tool]!
  const version = await installedVersion(tool)
  if (!version) {
    console.error(`[canary] no installed ${tool} found (the host's own lookup)`)
    return 2
  }
  const folder = (v: string) => join(dir, `${prefix}${v}`)
  const file = (v: string, name: string) => join(folder(v), `${name}.jsonl`)
  const versions = existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith(prefix)).map((n) => versionOf(n, prefix)) : []
  const before = earlierVersion(versions, version, (v) => names.every((n) => existsSync(file(v, n))))
  if (!before) {
    console.error(`[canary] no ${tool} version before ${version} has every canary scenario (${names.join(', ')}): nothing to compare with; record them all`)
    return 2
  }
  console.log(`[canary] ${tool} ${version} installed; compared with ${before}, the newest recorded before it`)

  const missing = names.filter((n) => !existsSync(file(version, n)))
  let cost: number | null = null
  if (missing.length && compareOnly) {
    console.error(`[canary] ${version} has no recording of ${missing.join(', ')}, and --compare-only records nothing`)
    return 2
  }
  if (missing.length) {
    console.log(`[canary] recording ${missing.join(', ')} on ${version} (model calls on the cheapest model)`)
    const r = spawnSync(process.execPath, ['--import', 'tsx', join(ROOT, 'scripts/frames-record.mts'), tool, ...missing], { cwd: ROOT, stdio: 'inherit' })
    const made = missing.filter((n) => existsSync(file(version, n)))
    if (r.status !== 0 || made.length < missing.length) {
      console.error(`[canary] the recording did not finish (exit ${r.status}); recorded: ${made.join(', ') || 'none'}`)
      return 2
    }
    const costs = made.map((n) => costOf(readFrames(file(version, n))))
    cost = costs.every((c) => c === null) ? null : costs.reduce<number>((s, c) => s + (c ?? 0), 0)
  }

  const shapes = (v: string) => new Map(names.map((n) => [n, shapeOf(readFrames(file(v, n)))]))
  const now = shapes(version)
  const d = diffShapes(mergeShapes(shapes(before).values()), mergeShapes(now.values()), unreadKinds(tool, await limitationsOf(tool)))
  const earlier = new Map<string, Shape>()
  for (const n of readdirSync(folder(before)).filter((n) => n.endsWith('.jsonl'))) earlier.set(n.replace(/\.jsonl$/, ''), shapeOf(readFrames(join(folder(before), n))))

  if (d.gone.length) console.log(`  kinds of frame only ${before} sent: ${d.gone.join(', ')}`)
  if (d.added.length) console.log(`  kinds of frame only ${version} sent: ${d.added.join(', ')}`)
  for (const f of d.fields.filter((f) => f.gone.length)) console.log(`  ${f.kind}: fields every frame had, gone: ${f.gone.join(', ')}`)
  const news = d.fields.filter((f) => f.added.length)
  if (news.length) console.log(`  new fields (no reason to re-record alone):\n${news.map((f) => `    ${f.kind}: ${f.added.join(', ')}`).join('\n')}`)
  if (cost !== null) console.log(`[canary] this run's recordings cost $${cost.toFixed(4)} (the tool's own count)`)
  const again = differs(d) ? toRerecord(d, earlier, now) : []
  if (!again.length) {
    console.log(`[canary] no difference: ${before}'s recordings still hold for ${version}`)
    return 0
  }
  console.log(`[canary] re-record on ${version}: ${again.join(' ')}`)
  console.log(`  pnpm exec tsx scripts/frames-record.mts ${tool} ${again.join(' ')}`)
  return 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(await main())
