#!/usr/bin/env -S npx tsx
/**
 * Turns a raw ACP recording into a fixture (docs/plans/acp-adapter.md §10.1, #1498).
 *
 *   pnpm exec tsx scripts/acp-scrub.mts <raw.jsonl> <out.jsonl> --tool <name> --version <v> --scenario <name> --cwd <path>
 *
 * The raw file is the host's (`CC_ACP_RECORD`, lines `{t, dir, line}`) or a probe's (`{t, dir, msg}`). The fixture is one
 * header line, then `{t, dir: 'in' | 'out', msg}` per frame and `{t, dir: 'exit', code, signal}` when the process ended.
 * Scrubbed: the working folder and the home folder become `<cwd>` and `<home>`; session, tool call and message ids become
 * stable placeholders; anything shaped like a credential or an email address is removed; command and model lists keep
 * their names only; stderr is dropped.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'

type Frame = { t: number; dir: string; msg?: unknown; line?: string; raw?: string }

const SECRET = /\b(?:figd_[\w-]+|sk-[\w-]{16,}|ghp_\w{20,}|gho_\w{20,}|xox[abp]-[\w-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g

export function scrub(frames: readonly Frame[], cwd: string, home: string = homedir()): unknown[] {
  const ids = new Map<string, string>()
  const counters: Record<string, number> = {}
  const stable = (kind: string, value: string) => {
    const key = `${kind}:${value}`
    if (!ids.has(key)) ids.set(key, `${kind}-${(counters[kind] = (counters[kind] ?? 0) + 1)}`)
    return ids.get(key)!
  }
  // A Windows path also appears without its drive (measured: an OpenCode tool title), and with `/` for `\`
  const variants = (p: string) => {
    const forms = [p, p.replace(/^[A-Za-z]:[\\/]/, '')]
    return [...new Set(forms.flatMap((x) => [x, x.replace(/\\/g, '/')]))].filter((x) => x.length > 3).sort((a, b) => b.length - a.length)
  }
  const text = (s: string) => {
    let out = s
    for (const v of variants(cwd)) out = out.split(v).join('<cwd>')
    for (const v of variants(home)) out = out.split(v).join('<home>')
    return out.replace(SECRET, '<secret>').replace(EMAIL, '<email>')
  }
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === 'string') {
      if (key === 'sessionId' || key === 'subagentSessionId') return stable('ses', v)
      if (key === 'toolCallId') return stable('call', v)
      if (key === 'messageId') return stable('msg', v)
      return text(v)
    }
    if (Array.isArray(v)) return v.map((x) => walk(x))
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      if (key === 'availableCommands' || o.sessionUpdate === 'available_commands_update') {
        return { ...o, availableCommands: Array.isArray(o.availableCommands) ? o.availableCommands.map((c) => ({ name: (c as { name?: unknown }).name })) : [] }
      }
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, walk(x, k)]))
    }
    return v
  }
  const out: unknown[] = []
  for (const f of frames) {
    if (f.dir === 'stderr' || f.dir === 'note') continue
    if (f.dir === 'exit') {
      const m = (f.msg ?? {}) as { code?: number | null; sig?: string | null }
      out.push({ t: f.t, dir: 'exit', code: m.code ?? null, signal: m.sig ?? null })
      continue
    }
    const msg = f.msg ?? (f.line ? JSON.parse(f.line) : f.raw ? JSON.parse(f.raw) : null)
    if (!msg) continue
    out.push({ t: f.t, dir: f.dir, msg: walk(msg) })
  }
  return out
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('acp-scrub.mts')) {
  const [input, output] = process.argv.slice(2)
  const flag = (name: string) => {
    const i = process.argv.indexOf(`--${name}`)
    return i > 0 ? process.argv[i + 1] : undefined
  }
  const cwd = flag('cwd')
  if (!input || !output || !cwd || !flag('tool') || !flag('version') || !flag('scenario')) {
    console.error('usage: acp-scrub.mts <raw.jsonl> <out.jsonl> --tool <name> --version <v> --scenario <name> --cwd <path>')
    process.exit(2)
  }
  const frames = readFileSync(input, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Frame)
  const header = { header: { tool: flag('tool'), version: flag('version'), scenario: flag('scenario'), protocolVersion: 1, os: process.platform, recorded: new Date().toISOString().slice(0, 10) } }
  writeFileSync(output, [header, ...scrub(frames, cwd)].map((l) => JSON.stringify(l)).join('\n') + '\n')
  console.log(`wrote ${output}`)
}
