/**
 * A-1: verifies the Codex app-server protocol contract.
 *
 * The generated bindings (642 files, 2.6MB) are **never committed** — committing them whole would
 * bury the signal a review needs to see under noise. Instead, only `protocol-contract.json` (the
 * list of methods we actually use) is committed, and **anything that has disappeared** is reported
 * by diffing it against the generated output (change axis C4: protocol drift detection).
 *
 * One exception: `generated/Verbosity.ts` is committed (#54). The adapter imports it at compile
 * time (the satisfies drift trap on CODEX_VERBOSITIES), and without it every place tsc runs would
 * break — especially `pnpm verify` in release. Regenerating it here also updates that file, so if
 * codex changes its enum values, both a git diff and a compile error surface it.
 *
 *   pnpm codex:bindings          — generates types (for local reference, gitignored) + verifies the contract
 *   pnpm codex:bindings --check  — verifies the contract only (for CI)
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, cpSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const ADAPTER = join(ROOT, 'packages/agent-host/src/adapters/codex')
const CONTRACT = join(ADAPTER, 'protocol-contract.json')
const KEEP = !process.argv.includes('--check') // --check does not keep the generated output

const contract = JSON.parse(readFileSync(CONTRACT, 'utf8'))
const version = execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim()
const tmp = mkdtempSync(join(tmpdir(), 'codex-bindings-'))

try {
  execFileSync('codex', ['app-server', 'generate-ts', '--out', tmp], { stdio: 'pipe' })
} catch (e) {
  console.error('[codex] 타입 생성 실패 — codex CLI가 설치돼 있는지 확인하세요:', e.message)
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
  ['clientRequests', '클라이언트 요청'],
  ['clientNotifications', '클라이언트 알림'],
  ['serverNotifications', '서버 알림'],
  ['serverRequests', '서버 요청(승인)'],
  ['approvalDecisions', '승인 결정값'],
  ['approvalPolicies', '승인 정책값'],
  ['mcpToolApprovalModes', 'MCP 도구 승인 방식'],
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
    missing.push(`요청 인자 타입: ${spec.type} (${method})`)
    continue
  }
  const fields = paramFields(src)
  if (!fields) {
    missing.push(`요청 인자 타입을 읽지 못함: ${spec.type} (${method})`)
    continue
  }
  const sent = new Set(spec.send)
  for (const f of fields) {
    if (f.required && !sent.has(f.name)) missing.push(`${method}: 필수 인자 '${f.name}'을 안 보냅니다`)
  }
  const known = new Set(fields.map((f) => f.name))
  for (const name of sent) {
    if (!known.has(name)) missing.push(`${method}: '${name}'은 ${spec.type}에 없습니다 (이름이 바뀌었나?)`)
  }
}

if (missing.length > 0) {
  console.error(
    `[codex] 프로토콜이 바뀌었습니다 (${version}). 우리가 의존하는 항목 ${missing.length}개가 사라졌습니다:\n  ` +
      missing.join('\n  ') +
      '\n→ adapters/codex를 새 프로토콜에 맞추고 protocol-contract.json을 갱신하세요.',
  )
  rmSync(tmp, { recursive: true, force: true })
  process.exit(1)
}

if (KEEP) {
  // Kept only for local reference (gitignored — not subject to typecheck or lint either)
  const dest = join(ADAPTER, 'generated')
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  cpSync(tmp, dest, { recursive: true })
  console.log(`[codex] 계약 확인 (${version}) · 참고용 타입을 generated/ 에 두었습니다 (커밋 대상 아님)`)
} else {
  console.log(
    `[codex] 계약 확인 (${version}) — 의존 항목 ${groups.reduce((n, [k]) => n + contract[k].length, 0)}개 + ` +
      `요청 인자 ${Object.keys(contract.requestParams ?? {}).length}건 모두 일치`,
  )
}

rmSync(tmp, { recursive: true, force: true })
if (!existsSync(CONTRACT)) process.exit(1)
