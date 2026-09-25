/**
 * A-1: Codex app-server 프로토콜 계약 검증.
 *
 * 생성된 바인딩(642개, 2.6MB)은 **커밋하지 않는다** — 통째로 커밋하면 리뷰가 봐야 할
 * 신호가 노이즈에 묻힌다. 대신 `protocol-contract.json`(우리가 실제로 쓰는 메서드 목록)만
 * 커밋하고, 생성물과 대조해 **사라진 것**을 알린다 (변경 축 C4: 프로토콜 변동 감지).
 *
 * 예외 하나: `generated/Verbosity.ts`는 커밋한다 (#54). 어댑터가 컴파일 타임에 import해서
 * (CODEX_VERBOSITIES의 satisfies 드리프트 덫), 없으면 tsc가 도는 모든 곳 — 특히 release의
 * `pnpm verify` — 이 깨진다. 여기서 재생성하면 그 파일도 갱신되므로, codex가 단계를 바꾸면
 * git diff와 컴파일 에러가 함께 드러낸다.
 *
 *   pnpm codex:bindings          — 타입 생성 (로컬 참고용, gitignore됨) + 계약 검증
 *   pnpm codex:bindings --check  — 계약 검증만 (CI용)
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, cpSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const ADAPTER = join(ROOT, 'packages/agent-host/src/adapters/codex')
const CONTRACT = join(ADAPTER, 'protocol-contract.json')
const KEEP = !process.argv.includes('--check') // --check는 생성물을 남기지 않는다

const contract = JSON.parse(readFileSync(CONTRACT, 'utf8'))
const version = execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim()
const tmp = mkdtempSync(join(tmpdir(), 'codex-bindings-'))

try {
  execFileSync('codex', ['app-server', 'generate-ts', '--out', tmp], { stdio: 'pipe' })
} catch (e) {
  console.error('[codex] 타입 생성 실패 — codex CLI가 설치돼 있는지 확인하세요:', e.message)
  process.exit(1)
}

/** 생성된 TS 전체에서 프로토콜 문자열 리터럴을 긁어 모은다 */
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
 * 메서드 **이름**만 대조하는 것으로는 부족하다는 걸 실측이 보여줬다 (2026-09-07):
 * `turn/interrupt`는 그대로 있었지만 turnId가 필수 인자로 늘어 있었고, 우리는 threadId만
 * 보내며 몇 달을 "멈췄겠지" 하고 있었다 — 스톱이 한 번도 안 먹었다.
 *
 * 그래서 **우리가 보내는 인자 목록**도 계약에 적고, 생성된 파라미터 타입과 양방향으로 맞춘다:
 *   - 타입의 필수 필드인데 우리가 안 보내면  → 서버가 거절한다 (그 버그)
 *   - 우리가 보내는데 타입에 없으면          → 이름이 바뀐 것이다 (조용히 무시된다)
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
  // 로컬 참고용으로만 남긴다 (gitignore됨 — 타입체크·린트 대상도 아니다)
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
