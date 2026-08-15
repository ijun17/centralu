/**
 * A-1: Codex app-server 프로토콜 계약 검증.
 *
 * 생성된 바인딩(642개, 2.6MB)은 **커밋하지 않는다** — 우리 어댑터는 그중 하나도 import하지 않고,
 * 통째로 커밋하면 리뷰가 봐야 할 신호가 노이즈에 묻힌다.
 * 대신 `protocol-contract.json`(우리가 실제로 쓰는 메서드 목록)만 커밋하고,
 * 생성물과 대조해 **사라진 것**을 알린다 (변경 축 C4: 프로토콜 변동 감지).
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
]

const missing = []
for (const [key, label] of groups) {
  for (const name of contract[key] ?? []) {
    if (!literals.has(name)) missing.push(`${label}: ${name}`)
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
  console.log(`[codex] 계약 확인 (${version}) — 의존 항목 ${groups.reduce((n, [k]) => n + contract[k].length, 0)}개 모두 존재`)
}

rmSync(tmp, { recursive: true, force: true })
if (!existsSync(CONTRACT)) process.exit(1)
