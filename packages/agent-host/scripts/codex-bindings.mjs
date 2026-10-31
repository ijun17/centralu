/**
 * A-1: verifies the Codex app-server protocol contract.
 *
 * The generated bindings (747 files) are not committed whole: that would bury the signal a review
 * needs to see under noise. `protocol-contract.json` (the methods, fields and words we actually use)
 * is committed, and **anything that has disappeared** is reported by diffing it against the
 * generated output (change axis C4: protocol drift detection).
 *
 * What is committed of the bindings is what the adapter is compiled against (#1339): every generated
 * type the host's sources import, and every type those import. A field Codex renames in one of them
 * then fails the build where the adapter reads it, as well as the drift check here. A params type the
 * contract names but nothing imports is not committed: nothing is compiled against it, and the
 * contract check above still holds its method and fields.
 *
 *   pnpm codex:bindings                   — verifies the contract, and writes those types into generated/ (to
 *                                           commit), replacing the folder: nothing else belongs in it; and
 *                                           protocol-types.sha256, which says which Codex made them and what each
 *                                           file holds (generated-types.test.ts fails on a hand edit)
 *   pnpm codex:bindings --check-contract  — verifies the contract only: a name we use is gone (a real break)
 *   pnpm codex:bindings --check-types     — that generated/ holds the types as this Codex makes them (stale types)
 *   pnpm codex:bindings --check           — both (drift.yml runs them as two jobs, so the two read apart)
 *
 * On Windows `codex` is an npm shim (codex.cmd), which only a shell runs: it is started through one there.
 *
 * What is checked: the method, notification, item-type and value names we use; the arguments we send to each request
 * (both ways, see below); the fields we read from an answer (`responseFields`); and the enum words we send or compare
 * (`enumValues`).
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const ADAPTER = join(ROOT, 'packages/agent-host/src/adapters/codex')
const CONTRACT = join(ADAPTER, 'protocol-contract.json')
const flag = (name) => process.argv.includes(name)
// Any --check writes nothing; --check is both checks
const WRITE = !process.argv.some((a) => a.startsWith('--check'))
const CHECK_CONTRACT = WRITE || flag('--check') || flag('--check-contract')
const CHECK_TYPES = flag('--check') || flag('--check-types')
const MANIFEST = join(ADAPTER, 'protocol-types.sha256')
const DEST = join(ADAPTER, 'generated')

/** Runs codex: through a shell on Windows, where it is an npm shim (codex.cmd) execFile cannot start; args are ours */
const quote = (a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)
const codex = (args, opts = {}) =>
  process.platform === 'win32'
    ? execFileSync('codex', args.map(quote), { ...opts, shell: true })
    : execFileSync('codex', args, opts)

/** A file's text as the manifest names it: sha256 of its UTF-8 bytes */
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

const contract = JSON.parse(readFileSync(CONTRACT, 'utf8'))
const version = String(codex(['--version'], { encoding: 'utf8' })).trim()
const tmp = mkdtempSync(join(tmpdir(), 'codex-bindings-'))

try {
  codex(['app-server', 'generate-ts', '--out', tmp], { stdio: 'pipe' })
} catch (e) {
  console.error('[codex] type generation failed — check whether the codex CLI is installed:', e.message)
  process.exit(1)
}

/** Scrapes protocol string literals out of the entire generated TS output */
function literalsIn(dir) {
  const found = new Set()
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.name.endsWith('.ts')) {
        for (const m of readFileSync(p, 'utf8').matchAll(/"([a-zA-Z][a-zA-Z0-9/._-]*)"/g)) found.add(m[1])
      }
    }
  }
  walk(dir)
  return found
}

const literals = literalsIn(tmp)

const groups = [
  ['clientRequests', 'client request'],
  ['clientNotifications', 'client notification'],
  ['serverNotifications', 'server notification'],
  ['serverRequests', 'server request (approval)'],
  ['threadItemTypes', 'thread item type'],
  ['approvalDecisions', 'approval decision value'],
  ['approvalPolicies', 'approval policy value'],
  ['mcpToolApprovalModes', 'MCP tool approval mode'],
]

const missing = []
for (const [key, label] of groups) {
  for (const name of contract[key] ?? []) {
    if (!literals.has(name)) missing.push(`${label}: ${name}`)
  }
}

/*
 * Measurement showed that comparing only method **names** is not enough (2026-09-07):
 * `turn/interrupt` was still there, but turnId had been added as a required argument, and for
 * months we had only been sending threadId while assuming "it must be stopping" — Stop never
 * actually worked once.
 *
 * So **the list of arguments we send** is also recorded in the contract, and checked both ways
 * against the generated parameter type:
 *   - a field required by the type that we do not send  → the server rejects it (that bug)
 *   - a field we send that is not in the type            → its name changed (silently ignored)
 */
function paramFields(src) {
  const open = src.indexOf('= {')
  if (open < 0) return null
  const body = src.slice(open + 3, src.lastIndexOf('}')).replace(/\/\*[\s\S]*?\*\//g, '')
  const fields = []
  let depth = 0
  let start = 0
  const push = (seg) => {
    const m = /^\s*(\w+)(\??)\s*:/.exec(seg)
    if (m) fields.push({ name: m[1], required: m[2] !== '?' })
  }
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if ('{[(<'.includes(c)) depth++
    else if ('}])>'.includes(c)) depth--
    else if (c === ',' && depth === 0) {
      push(body.slice(start, i))
      start = i + 1
    }
  }
  push(body.slice(start))
  return fields
}

const sources = new Map()
const collect = (d) => {
  for (const entry of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, entry.name)
    if (entry.isDirectory()) collect(p)
    else if (entry.name.endsWith('.ts')) sources.set(entry.name.slice(0, -3), readFileSync(p, 'utf8'))
  }
}
collect(tmp)

for (const [method, spec] of Object.entries(contract.requestParams ?? {})) {
  const src = sources.get(spec.type)
  if (!src) {
    missing.push(`request param type: ${spec.type} (${method})`)
    continue
  }
  const fields = paramFields(src)
  if (!fields) {
    missing.push(`could not read the request param type: ${spec.type} (${method})`)
    continue
  }
  const sent = new Set(spec.send)
  for (const f of fields) {
    if (f.required && !sent.has(f.name)) missing.push(`${method}: does not send the required param '${f.name}'`)
  }
  const known = new Set(fields.map((f) => f.name))
  for (const name of sent) {
    if (!known.has(name)) missing.push(`${method}: '${name}' is not in ${spec.type} (did the name change?)`)
  }
}

/*
 * What we read back, and the words we send or compare (#342). Moving off full-history hydration made the adapter
 * depend on an answer's shape (a turns page's `data` and `nextCursor`, a turn's `status`) and on enum words
 * (`itemsView: 'full'`, `'inProgress'`). A renamed field or word does not fail a request: it reads as absent, and
 * the running turn's id after a resume (#313) or every page after the first would be lost without a sound.
 */
for (const [type, names] of Object.entries(contract.responseFields ?? {})) {
  const src = sources.get(type)
  const fields = src ? paramFields(src) : null
  if (!fields) {
    missing.push(`response type: ${type}`)
    continue
  }
  const known = new Set(fields.map((f) => f.name))
  for (const name of names) {
    if (!known.has(name)) missing.push(`${type}: no field '${name}' (did the name change?)`)
  }
}
for (const [type, values] of Object.entries(contract.enumValues ?? {})) {
  const src = sources.get(type)
  if (!src) {
    missing.push(`enum type: ${type}`)
    continue
  }
  for (const v of values) {
    if (!src.includes(`"${v}"`)) missing.push(`${type}: no value "${v}"`)
  }
}

/*
 * The types the adapter is compiled against (#1339): what the host's sources import from generated/, and everything
 * those import. Each contract method must still have a params type in the generated unions
 * (`{ "method": "item/started", "params": ItemStartedNotification }`).
 */
const committed = new Map()
/** The generated files the sources under `dir` import (generated/ itself is read by `visit`), by path without `.ts` */
function importedFromGenerated(dir) {
  const found = new Set()
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const full = join(entry.parentPath, entry.name)
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name) || full.startsWith(DEST + sep)) continue
    for (const m of readFileSync(full, 'utf8').matchAll(/(?:from|import\()\s*'(\.[^']*\/generated\/[^']+?)(?:\.js)?'/g)) {
      found.add(relative(DEST, resolve(dirname(full), m[1])).split('\\').join('/'))
    }
  }
  return [...found]
}
{
  const roots = importedFromGenerated(join(ROOT, 'packages/agent-host/src'))
  for (const [union, key] of [['ServerNotification', 'serverNotifications'], ['ServerRequest', 'serverRequests']]) {
    const src = readFileSync(join(tmp, `${union}.ts`), 'utf8')
    for (const method of contract[key] ?? []) {
      const quoted = method.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
      const m = new RegExp(`"method": "${quoted}",[^}]*?"?params"?: (\\w+)`).exec(src)
      const name = m?.[1]
      const from = name ? new RegExp(`import type \\{ ${name} \\} from "\\./([^"]+)"`).exec(src)?.[1] : undefined
      if (!from) missing.push(`${union}: no params type for ${method}`)
    }
  }
  const visit = (file) => {
    if (committed.has(file)) return
    const path = join(tmp, `${file}.ts`)
    if (!existsSync(path)) {
      missing.push(`generated type: ${file}`)
      return
    }
    const text = readFileSync(path, 'utf8')
    committed.set(file, text)
    for (const m of text.matchAll(/from "(\.[^"]+)"/g)) visit(join(dirname(file), m[1]).split('\\').join('/'))
  }
  for (const root of roots) visit(root)
}
/** What generated/ no longer matches; said apart from what disappeared from the contract, since the fix differs */
const stale = []
/** Every file under generated/, by path without `.ts` */
const committedNow = () => {
  const out = new Map()
  if (!existsSync(DEST)) return out
  for (const entry of readdirSync(DEST, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
    const full = join(entry.parentPath, entry.name)
    out.set(relative(DEST, full).split('\\').join('/').slice(0, -3), readFileSync(full, 'utf8'))
  }
  return out
}
if (CHECK_TYPES) {
  const now = committedNow()
  for (const [file, text] of committed) {
    if (!now.has(file)) stale.push(`generated/${file}.ts: not committed`)
    else if (now.get(file) !== text) stale.push(`generated/${file}.ts: differs from what Codex makes now`)
  }
  for (const file of now.keys()) if (!committed.has(file)) stale.push(`generated/${file}.ts: no longer read by the adapter`)
}

if (CHECK_CONTRACT && missing.length > 0) {
  console.error(
    `[codex] the protocol has changed (${version}). ${missing.length} item(s) we depend on have disappeared:\n  ` +
      missing.join('\n  ') +
      '\n→ update adapters/codex to match the new protocol, and refresh protocol-contract.json.',
  )
  rmSync(tmp, { recursive: true, force: true })
  process.exit(1)
}
if (stale.length > 0) {
  const made = existsSync(MANIFEST) ? (/^# (.+)$/m.exec(readFileSync(MANIFEST, 'utf8'))?.[1] ?? 'an unknown version') : 'an unknown version'
  console.error(
    `[codex] generated/ does not hold the types the adapter reads as ${version} makes them (committed: ${made}). ${stale.length} file(s):\n  ` +
      stale.join('\n  ') +
      `\n→ run pnpm codex:bindings with ${version} and commit generated/; fix what the build then says about the adapter.`,
  )
  rmSync(tmp, { recursive: true, force: true })
  process.exit(1)
}

if (WRITE) {
  rmSync(DEST, { recursive: true, force: true })
  for (const [file, text] of committed) {
    mkdirSync(dirname(join(DEST, file)), { recursive: true })
    writeFileSync(join(DEST, `${file}.ts`), text)
  }
  const lines = [...committed].sort(([a], [b]) => (a < b ? -1 : 1)).map(([file, text]) => `${sha256(text)}  generated/${file}.ts`)
  writeFileSync(MANIFEST, [`# ${version}`, ...lines].join('\n') + '\n')
  console.log(`[codex] contract verified (${version}) · wrote the ${committed.size} types the adapter is compiled against into generated/ (commit them)`)
} else {
  if (CHECK_TYPES && !CHECK_CONTRACT) {
    console.log(`[codex] generated/ holds the ${committed.size} types the adapter reads as ${version} makes them`)
    rmSync(tmp, { recursive: true, force: true })
    process.exit(0)
  }
  console.log(
    `[codex] contract verified (${version}) — all ${groups.reduce((n, [k]) => n + contract[k].length, 0)} dependent item(s) + ` +
      `${Object.keys(contract.requestParams ?? {}).length} request param set(s) + ` +
      `${Object.keys(contract.responseFields ?? {}).length} response type(s) + ` +
      `${Object.keys(contract.enumValues ?? {}).length} enum(s) match` +
      (CHECK_TYPES ? `, and generated/ holds the ${committed.size} types the adapter reads as Codex makes them` : ''),
  )
}

rmSync(tmp, { recursive: true, force: true })
if (!existsSync(CONTRACT)) process.exit(1)
