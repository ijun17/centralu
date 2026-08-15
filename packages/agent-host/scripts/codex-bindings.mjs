/**
 * A-1: Codex app-server 프로토콜 타입 바인딩 생성.
 *
 * Codex CLI가 타입 생성기를 내장하고 있으므로(M0에서 확인), 생성 결과를 저장소에 커밋해
 * **프로토콜 변동이 diff로 드러나게** 한다 (변경 축 C4 방어).
 *
 *   pnpm codex:bindings          — 생성/갱신
 *   pnpm codex:bindings --check  — 최신인지 확인만 (CI용, 다르면 실패)
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const DEST = join(ROOT, 'packages/agent-host/src/adapters/codex/generated')
const CHECK = process.argv.includes('--check')

const version = execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim()
const tmp = mkdtempSync(join(tmpdir(), 'codex-bindings-'))

try {
  execFileSync('codex', ['app-server', 'generate-ts', '--out', tmp], { stdio: 'pipe' })
} catch (e) {
  console.error('[bindings] 생성 실패 — codex CLI가 설치돼 있는지 확인하세요:', e.message)
  process.exit(1)
}

// v2 타입은 상위 디렉토리의 공용 타입을 참조하므로 **전체를 담는다** (부분 복사는 참조가 깨진다)
if (!existsSync(join(tmp, 'v2'))) {
  console.error('[bindings] v2 디렉토리가 없습니다 — 생성기 출력 구조가 바뀌었습니다:', readdirSync(tmp).slice(0, 10))
  process.exit(1)
}
const src = tmp

const count = readdirSync(join(src, 'v2')).filter((f) => f.endsWith('.ts')).length

if (CHECK) {
  if (!existsSync(DEST)) {
    console.error('[bindings] 커밋된 바인딩이 없습니다. `pnpm codex:bindings` 를 실행하세요.')
    process.exit(1)
  }
  const diff = readdirSync(src)
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => {
      const a = join(src, f)
      const b = join(DEST, f)
      return !existsSync(b) || readFileSync(a, 'utf8') !== readFileSync(b, 'utf8')
    })
  if (diff.length > 0) {
    console.error(
      `[bindings] 프로토콜이 바뀌었습니다 (codex ${version}). 달라진 파일 ${diff.length}개:\n  ` +
        diff.slice(0, 10).join('\n  ') +
        '\n→ `pnpm codex:bindings` 로 갱신하고, 어댑터가 여전히 맞는지 확인하세요.',
    )
    process.exit(1)
  }
  console.log(`[bindings] 최신 (codex ${version}, ${count}개 타입)`)
} else {
  rmSync(DEST, { recursive: true, force: true })
  mkdirSync(DEST, { recursive: true })
  cpSync(src, DEST, { recursive: true })
  console.log(`[bindings] ${count}개 타입 생성 (codex ${version}) → ${DEST}`)
}

rmSync(tmp, { recursive: true, force: true })
