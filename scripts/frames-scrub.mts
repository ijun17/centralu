#!/usr/bin/env -S npx tsx
/**
 * Turns a raw recording of a tool's frames (ACP or any JSON-lines protocol) into a fixture (docs/plans/acp-adapter.md §10.1, #1498).
 *
 *   pnpm exec tsx scripts/frames-scrub.mts <raw.jsonl> <out.jsonl> --tool <name> --version <v> --scenario <name> --cwd <path>
 *   pnpm exec tsx scripts/frames-scrub.mts --rescrub <fixture.jsonl>...   # a committed fixture again, in place
 *
 * The raw file is the host's (`CC_RECORD_FRAMES`, lines `{t, dir, line}`) or a probe's (`{t, dir, msg}`). The fixture is one
 * header line, then `{t, dir: 'in' | 'out', msg}` per frame and `{t, dir: 'exit', code, signal}` when the process ended.
 * Scrubbed:
 *
 * - the working folder, the home folder and the temp folder become `<cwd>`, `<home>` and `<tmp>`, in each form a path
 *   takes (with or without its drive, `\` or `/`); so does any other person's home or temp folder on Windows, macOS and
 *   Linux (`C:\Users\<name>`, `/Users/<name>`, `/home/<name>`, `/private/var/folders/…/T`), and the user name alone;
 * - text the agent streams in chunks is scrubbed joined, then split again where it was (#1562 review: a path split across two
 *   chunks kept the user name);
 * - session, tool call and message ids become stable placeholders;
 * - anything shaped like a credential or an email address is removed, and so is the value of an environment entry named
 *   like one (the bridge's `CC_BRIDGE_TOKEN` in `session/new`);
 * - the command list (the person's own skills among them) keeps only how many there were, as `command-<n>`;
 * - stderr is dropped.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'

type Frame = { t: number; dir: string; msg?: unknown; line?: string; raw?: string }

const SECRET = /\b(?:figd_[\w-]+|sk-[\w-]{16,}|ghp_\w{20,}|gho_\w{20,}|xox[abp]-[\w-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g
/** Another person's home or temp folder: what the machine's own folders did not already cover */
const FOREIGN: readonly [RegExp, string][] = [
  [/(?:\/private)?\/var\/folders\/[^/\s"'`]+\/[^/\s"'`]+\/T(?=[/\\\s"'`]|$)/g, '<tmp>'],
  [/\b[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'`<>]+/g, '<home>'],
  [/(?<![\w<])(?:\\|\/)?Users[\\/]+(?!Shared\b)[^\\/\s"'`<>]+(?=[\\/])/g, '<home>'],
  [/\/home\/[^/\s"'`<>]+/g, '<home>'],
]

/** The kinds of update whose text an agent streams in pieces */
const CHUNKED = new Set(['agent_message_chunk', 'agent_thought_chunk', 'user_message_chunk'])

export type ScrubPlaces = { cwd: string; home?: string; tmp?: string; user?: string }

/** A Windows path also appears without its drive (measured: an OpenCode tool title), and with `/` for `\` */
function variants(p: string): string[] {
  const forms = [p, p.replace(/^[A-Za-z]:[\\/]/, '')]
  return [...new Set(forms.flatMap((x) => [x, x.replace(/\\/g, '/'), x.replace(/\\/g, '\\\\')]))].filter((x) => x.length > 3).sort((a, b) => b.length - a.length)
}

/** Where in `s` something must be replaced, earliest first and never overlapping */
function spans(s: string, places: Required<ScrubPlaces>): { start: number; end: number; with: string }[] {
  const found: { start: number; end: number; with: string }[] = []
  const literal = (needle: string, replacement: string) => {
    for (let i = s.indexOf(needle); i >= 0; i = s.indexOf(needle, i + needle.length)) found.push({ start: i, end: i + needle.length, with: replacement })
  }
  // The most specific first: the working folder sits inside the temp folder, which sits inside the home folder
  for (const v of variants(places.cwd)) literal(v, '<cwd>')
  for (const v of variants(places.tmp)) literal(v, '<tmp>')
  for (const v of variants(places.home)) literal(v, '<home>')
  const pattern = (re: RegExp, replacement: string) => {
    for (const m of s.matchAll(re)) found.push({ start: m.index, end: m.index + m[0].length, with: replacement })
  }
  for (const [re, replacement] of FOREIGN) pattern(re, replacement)
  if (places.user.length >= 3) pattern(new RegExp(`\\b${places.user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), '<user>')
  pattern(SECRET, '<secret>')
  pattern(EMAIL, '<email>')
  // Earliest first, the longest where two start together; one that overlaps a kept one is dropped
  found.sort((a, b) => a.start - b.start || b.end - a.end)
  const kept: typeof found = []
  for (const f of found) if (!kept.length || f.start >= kept.at(-1)!.end) kept.push(f)
  return kept
}

/** `pieces` scrubbed as the one text they make, each kept where it was: a replacement goes in the piece it starts in */
export function scrubPieces(pieces: readonly string[], places: ScrubPlaces): string[] {
  const all = withDefaults(places)
  const joined = pieces.join('')
  const found = spans(joined, all)
  const out: string[] = []
  let at = 0
  let next = 0
  for (const piece of pieces) {
    const end = at + piece.length
    let text = ''
    for (let i = at; i < end; i++) {
      while (next < found.length && found[next]!.end <= i) next++
      const f = found[next]
      if (f && i >= f.start && i < f.end) {
        if (i === f.start) text += f.with
        continue
      }
      text += joined[i]
    }
    out.push(text)
    at = end
  }
  return out
}

function withDefaults(p: ScrubPlaces): Required<ScrubPlaces> {
  return { cwd: p.cwd, home: p.home ?? homedir(), tmp: p.tmp ?? tmpdir(), user: p.user ?? safeUser() }
}

function safeUser(): string {
  try {
    return userInfo().username
  } catch {
    return ''
  }
}

export function scrub(frames: readonly Frame[], cwd: string, home: string = homedir(), more: Omit<ScrubPlaces, 'cwd' | 'home'> = {}): unknown[] {
  const places: ScrubPlaces = { cwd, home, ...more }
  const ids = new Map<string, string>()
  const counters: Record<string, number> = {}
  const stable = (kind: string, value: string) => {
    if (new RegExp(`^${kind}-\\d+$`).test(value)) return value
    const key = `${kind}:${value}`
    if (!ids.has(key)) ids.set(key, `${kind}-${(counters[kind] = (counters[kind] ?? 0) + 1)}`)
    return ids.get(key)!
  }
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === 'string') {
      if (key === 'sessionId' || key === 'subagentSessionId') return stable('ses', v)
      if (key === 'toolCallId') return stable('call', v)
      if (key === 'messageId') return stable('msg', v)
      return scrubPieces([v], places)[0]
    }
    if (Array.isArray(v)) return v.map((x) => walk(x))
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      // An environment entry for a server the client starts (`mcpServers[].env`): a token's value is a secret
      if (typeof o.name === 'string' && typeof o.value === 'string' && /TOKEN|SECRET|PASSWORD|KEY/i.test(o.name)) return { ...o, value: '<secret>' }
      if (key === 'availableCommands' || o.sessionUpdate === 'available_commands_update') {
        const list = Array.isArray(o.availableCommands) ? o.availableCommands : []
        return { ...o, availableCommands: list.map((_c, i) => ({ name: `command-${i + 1}` })) }
      }
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, walk(x, k)]))
    }
    return v
  }
  const out: { t: number; dir: string; msg?: unknown; code?: number | null; signal?: string | null }[] = []
  for (const f of frames) {
    if (f.dir === 'stderr' || f.dir === 'note') continue
    if (f.dir === 'exit') {
      const m = (f.msg ?? {}) as { code?: number | null; sig?: string | null; signal?: string | null }
      out.push({ t: f.t, dir: 'exit', code: m.code ?? (f as { code?: number | null }).code ?? null, signal: m.sig ?? m.signal ?? (f as { signal?: string | null }).signal ?? null })
      continue
    }
    const msg = f.msg ?? (f.line ? JSON.parse(f.line) : f.raw ? JSON.parse(f.raw) : null)
    if (!msg) continue
    out.push({ t: f.t, dir: f.dir, msg })
  }
  rejoinChunks(out, places)
  return out.map((f) => (f.dir === 'exit' ? f : { ...f, msg: walk(f.msg) }))
}

/** The text of a streamed chunk frame, by reference, so it can be written back */
function chunkOf(msg: unknown): { kind: string; session: string; content: { text: string } } | null {
  const params = (msg as { method?: string; params?: { sessionId?: string; update?: { sessionUpdate?: string; content?: { type?: string; text?: unknown } } } } | null)
  if (params?.method !== 'session/update') return null
  const u = params.params?.update
  if (!u?.sessionUpdate || !CHUNKED.has(u.sessionUpdate) || u.content?.type !== 'text' || typeof u.content.text !== 'string') return null
  return { kind: u.sessionUpdate, session: String(params.params?.sessionId ?? ''), content: u.content as { text: string } }
}

/** Each run of consecutive chunks of one kind is scrubbed as one text (`scrubPieces`), in place */
function rejoinChunks(frames: readonly { dir: string; msg?: unknown }[], places: ScrubPlaces): void {
  let run: { kind: string; session: string; content: { text: string } }[] = []
  const flush = () => {
    if (run.length > 1) scrubPieces(run.map((c) => c.content.text), places).forEach((text, i) => (run[i]!.content.text = text))
    run = []
  }
  for (const f of frames) {
    const c = f.dir === 'in' ? chunkOf(f.msg) : null
    if (!c) {
      flush()
      continue
    }
    if (run.length && (run[0]!.kind !== c.kind || run[0]!.session !== c.session)) flush()
    run.push(c)
  }
  flush()
}

const isMain = import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('frames-scrub.mts')
if (isMain && process.argv[2] === '--rescrub') {
  // A committed fixture's paths were scrubbed already; what this pass adds is the rest (chunks, foreign folders, the user)
  for (const file of process.argv.slice(3)) {
    const [head, ...lines] = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    const frames = lines.map((l) => JSON.parse(l) as Frame)
    writeFileSync(file, [head, ...scrub(frames, '<cwd>').map((l) => JSON.stringify(l))].join('\n') + '\n')
    console.log(`rescrubbed ${file}`)
  }
} else if (isMain) {
  const [input, output] = process.argv.slice(2)
  const flag = (name: string) => {
    const i = process.argv.indexOf(`--${name}`)
    return i > 0 ? process.argv[i + 1] : undefined
  }
  const cwd = flag('cwd')
  if (!input || !output || !cwd || !flag('tool') || !flag('version') || !flag('scenario')) {
    console.error('usage: frames-scrub.mts <raw.jsonl> <out.jsonl> --tool <name> --version <v> --scenario <name> --cwd <path>')
    process.exit(2)
  }
  const frames = readFileSync(input, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Frame)
  const header = { header: { tool: flag('tool'), version: flag('version'), scenario: flag('scenario'), protocolVersion: 1, os: process.platform, recorded: new Date().toISOString().slice(0, 10) } }
  writeFileSync(output, [header, ...scrub(frames, cwd)].map((l) => JSON.stringify(l)).join('\n') + '\n')
  console.log(`wrote ${output}`)
}
