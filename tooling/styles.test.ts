/**
 * L5-1 시각 회귀 최소선 (docs/plans/m1.5-plan.md 검증 프로토콜).
 *
 * 배경: Tailwind v4의 자동 소스 탐지가 모노레포의 packages/ui를 못 찾아
 * **CSS가 통째로 비어 있는데도 E2E 16개가 전부 통과**한 적이 있다.
 * 동작 테스트는 클래스 이름을 보지 않으므로 이 유형을 영원히 못 잡는다.
 * 그래서 "빌드 산출물에 실제로 스타일이 들어 있는가"를 직접 확인한다.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 이 클래스들이 빠지면 화면이 무너진다 — 각각 다른 출처를 대표하도록 골랐다 */
const REQUIRED = [
  { needle: '--color-void', why: '@theme 토큰 (팔레트 자체)' },
  { needle: '.keycap', why: '@layer components (시그니처 요소)' },
  { needle: 'bg-void', why: 'packages/ui 컴포넌트에서 쓰는 유틸리티' },
  { needle: 'text-ash', why: '텍스트 위계' },
  { needle: 'border-edge', why: '경계선' },
]

let css = ''
let jsBytes = 0
let outDir = ''

beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), 'cc-css-'))
  execFileSync('pnpm', ['exec', 'vite', 'build', '--outDir', outDir, '--emptyOutDir'], {
    cwd: join(ROOT, 'apps/web'),
    stdio: 'pipe',
  })
  const assets = join(outDir, 'assets')
  // CSS 청크가 여러 개일 수 있다 — 하나만 검사하면 지연 로드 청크가 게이트를 빠져나간다
  const files = readdirSync(assets).filter((f) => f.endsWith('.css'))
  expect(files.length, '빌드 결과에 CSS 파일이 없다').toBeGreaterThan(0)
  css = files.map((f) => readFileSync(join(assets, f), 'utf8')).join('\n')
  jsBytes = readdirSync(assets)
    .filter((f) => f.endsWith('.js'))
    .reduce((n, f) => n + readFileSync(join(assets, f)).length, 0)
}, 120_000)

afterAll(() => {
  if (outDir && existsSync(outDir)) rmSync(outDir, { recursive: true, force: true })
})

describe('빌드된 CSS에 스타일이 실제로 들어 있다', () => {
  it.each(REQUIRED)('$needle — $why', ({ needle }) => {
    expect(css).toContain(needle)
  })

  it('기본 스타일만 나온 수준(4KB 미만)이 아니다', () => {
    // 소스 탐지가 실패했을 때 정확히 이 크기였다 (preflight만 4.19KB)
    expect(css.length).toBeGreaterThan(8_000)
  })

  it('팔레트가 무채색이다 (R=G=B) — 색은 상태 전용이라는 규칙의 기계 검증', () => {
    const hexes = [...css.matchAll(/#([0-9a-f]{6})\b/gi)].map((m) => m[1]!.toLowerCase())
    const chromatic = hexes.filter((h) => {
      const [r, g, b] = [h.slice(0, 2), h.slice(2, 4), h.slice(4, 6)]
      return !(r === g && g === b)
    })
    expect([...new Set(chromatic)]).toEqual([])
  })
})

describe('번들 회귀 (C-3 결정: 뷰어에 편집기 엔진을 넣지 않는다)', () => {
  it('CodeMirror·Shiki가 번들에 들어오지 않았다', () => {
    // 읽기 전용 뷰어에 편집기 엔진은 과하다. 넣으려면 지연 로드가 전제이고,
    // Shiki의 기본 엔진은 WASM이라 Tauri CSP와도 충돌한다 (tech-stack 금지 목록).
    expect(css).not.toMatch(/cm-editor|shiki/i)
  })

  it('앱 전체 JS가 1.5MB를 넘지 않는다', () => {
    // 지금 ~300KB. 이 선을 넘으면 무거운 의존이 들어온 것이니 근거를 남기고 올려라.
    expect(jsBytes).toBeLessThan(1_500_000)
  })
})

/**
 * Tauri 권한 게이트.
 *
 * E2E는 브라우저에서 도는 mock을 쓰므로 **Tauri 권한 누락을 절대 잡지 못한다.**
 * 실제로 창 이동이 세 번 연속 "안 된다"로 돌아온 원인이 이것이었다:
 * `core:window:default`는 읽기 전용 묶음이라 `allow-start-dragging`이 없고,
 * 그러면 data-tauri-drag-region도 startDragging()도 조용히 거부된다.
 *
 * 그래서 코드가 부르는 창 기능과 권한 파일을 여기서 맞춰 본다.
 */
describe('Tauri 권한', () => {
  const capability = JSON.parse(
    readFileSync(join(ROOT, 'apps/desktop/src-tauri/capabilities/default.json'), 'utf8'),
  ) as { permissions: string[] }

  it('창을 끌 수 있는 권한이 있다 (타이틀바를 숨겼으므로 필수)', () => {
    expect(capability.permissions).toContain('core:window:allow-start-dragging')
  })

  it('startDragging을 부르는 코드와 권한이 함께 간다', () => {
    const tauriPort = readFileSync(join(ROOT, 'packages/platform/src/tauri/index.ts'), 'utf8')
    // 코드가 부르면 권한이 있어야 하고, 권한이 있으면 부르는 곳이 있어야 한다
    expect(tauriPort.includes('startDragging()')).toBe(
      capability.permissions.includes('core:window:allow-start-dragging'),
    )
  })

  it('웹뷰가 OS 드롭을 가로채지 않는다 (파일 첨부가 죽는다)', () => {
    const conf = JSON.parse(
      readFileSync(join(ROOT, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'),
    ) as { app: { windows: { dragDropEnabled?: boolean }[] } }
    expect(conf.app.windows[0]!.dragDropEnabled).toBe(false)
  })
})
