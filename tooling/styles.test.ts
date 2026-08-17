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
  // 아래 둘은 "예외로 허용한 색"이 실제로 산출물까지 갔는지 본다.
  // 토큰만 선언하고 유틸리티가 생성되지 않으면 diff는 배경 없이 그려지는데,
  // 동작 테스트로는 절대 안 잡히는 유형이다 (E2E는 클래스 이름을 보지 않는다).
  { needle: 'bg-add-bg', why: 'diff 추가 배경 (유채색 예외)' },
  { needle: 'cc-orbit', why: '작업 중 회전 테두리 (@property + @keyframes)' },
  { needle: 'cc-chip', why: '세션 표식 칩의 안쪽 그림자 (@layer components)' },
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

  /**
   * 유채색은 **여기 적힌 것만** 허용한다.
   *
   * 정책: 색을 다 빼고 시작했고, 앞으로 **하나씩 근거를 달아 더한다**.
   * 기준은 "예뻐지는가"가 아니라 **밝기 체계를 건드리는가**다 —
   * "화면에서 가장 밝은 것 = 나를 기다리는 것"이 언제나 참이어야 하므로,
   * 상태·긴급도를 말하는 자리에는 색이 들어올 수 없다. 아래 예외들은 그 체계 **밖**에 있다:
   *
   * 이 검사는 **CSS만** 본다. 별도 파일로 들어오는 색(예: 파일 타입 아이콘 SVG —
   * vscode-icons, MIT)은 여기 걸리지 않는다. 그건 분류를 말하는 그림이라
   * 밝기 체계와 겹치지 않아서 의도한 예외지만, 검사 범위 밖이라는 사실 자체는 알고 있어야 한다.
   *
   *   - diff 추가/삭제(add/del): 승인 판단은 훑어보며 하는 일인데, 초록·빨강은 학습된
   *     관습을 넘어 거의 반사에 가깝다. 대신 diff 본문 밖으로 나가지 않는다.
   *   - 은하수 궤도(cc-orbit): '작업 중'을 회전으로 말하는 테두리. 채도는 올리되
   *     명도는 눌러, **순백(beacon)보다 밝아지지 않게** 한다 — 밝기의 꼭대기는 대기의 몫이다.
   *
   * 이 목록에 없는 유채색이 CSS에 들어오면 실패한다 — 예외를 늘리려면 여기 근거를 적어라.
   *
   * **정책이 바뀌면 여기 있는 결정들을 되짚어라.** 궤도 색이 그 예다: 무채색 시절의
   * 근거로 눌러 놨는데 정책이 바뀐 뒤에도 아무도 다시 보지 않아, 사용자가
   * "색을 뺀 거냐"고 물어서야 알았다. 목록은 허용의 기록이자 **재검토 대상 목록**이다.
   */
  it('허용된 예외 말고는 팔레트가 무채색이다 (R=G=B)', () => {
    const ALLOWED = new Set([
      '7ee787', '10251a', // diff 추가
      'ffa198', '2b1517', // diff 삭제
      // 은하수 궤도 — '작업 중'을 회전으로 말하는 테두리.
      // 처음엔 거의 흰빛으로 눌러 놨다가, 색 정책이 "보수적으로 더한다"로 바뀐 뒤
      // 제대로 된 색으로 올렸다. 지키는 선: **순백보다 밝아지지 않는다**
      // (회전 궤도는 상태를 말하므로 밝기 체계 안에 있고, 그 꼭대기는 대기의 몫이다).
      '2d6cf0', '7b3fe4', 'd63aa8', 'ff8a3d', '4ad6d0',
    ])
    const hexes = [...css.matchAll(/#([0-9a-f]{6})\b/gi)].map((m) => m[1]!.toLowerCase())
    const chromatic = hexes.filter((h) => {
      const [r, g, b] = [h.slice(0, 2), h.slice(2, 4), h.slice(4, 6)]
      return !(r === g && g === b) && !ALLOWED.has(h)
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

  /**
   * 코드가 부르는 네이티브 기능과 권한을 맞춰 본다.
   *
   * 이 유형을 두 번 놓쳤다: 창 이동(core:window:allow-start-dragging)과
   * 전역 단축키(global-shortcut:*). 둘 다 `…:default` 묶음에 들어 있을 거라고
   * 짐작했는데 아니었다 — window:default는 읽기 전용이고, global-shortcut:default는
   * **아무것도 켜지 않는다**("shortcuts can be inherently dangerous").
   * 증상은 조용한 무동작이라 E2E(브라우저 mock)로는 영원히 못 잡는다.
   */
  const NATIVE_CALLS: { pattern: RegExp; permission: string; files: string[]; what: string }[] = [
    {
      pattern: /startDragging\(/,
      permission: 'core:window:allow-start-dragging',
      files: ['packages/platform/src/tauri/index.ts'],
      what: '창 이동',
    },
    {
      pattern: /\bregister\(/,
      permission: 'global-shortcut:allow-register',
      files: ['apps/desktop/src/main.tsx'],
      what: '전역 단축키 등록',
    },
    {
      pattern: /isRegistered\(/,
      permission: 'global-shortcut:allow-is-registered',
      files: ['apps/desktop/src/main.tsx'],
      what: '전역 단축키 확인',
    },
  ]

  it.each(NATIVE_CALLS)('$what: 코드가 부르면 권한도 있다', ({ pattern, permission, files }) => {
    const used = files.some((f) => pattern.test(readFileSync(join(ROOT, f), 'utf8')))
    if (!used) return // 안 쓰면 권한도 필요 없다
    expect(capability.permissions).toContain(permission)
  })

  it('아무것도 켜지 않는 default 묶음에 기대지 않는다', () => {
    // 이름이 default라고 해서 필요한 게 들어 있지는 않다 (실측으로 두 번 당했다)
    expect(capability.permissions).not.toContain('global-shortcut:default')
  })

  /**
   * 상단 바 높이는 **세 곳**에 같은 값으로 있어야 한다.
   *
   *   1. App.tsx의 h-* (화면이 실제로 그리는 높이)
   *   2. tauri.conf.json의 trafficLightPosition.y (첫 프레임 전의 위치)
   *   3. traffic_lights.rs의 HEADER_H (그 뒤로 계속 잡아주는 값)
   *
   * 셋이 필요한 이유는 macOS 26부터 창 관리자가 리사이즈와 동기적으로 버튼 위치를
   * 확정하지 않기 때문이다 — 설정만으로는 창이 뜨면서 기본 자리로 되돌아간다.
   * 그래서 설정은 첫 프레임을 맡고, Rust가 그 뒤를 맡는다.
   *
   * 하나만 고치면 아무 오류 없이 그냥 어긋나 보인다(실제로 그렇게 어긋났다).
   * E2E는 브라우저라 신호등을 볼 수 없으므로 여기서 세 값을 맞춰 본다.
   */
  it('상단 바 높이가 설정·Rust·화면에서 모두 같다', () => {
    const header = readFileSync(join(ROOT, 'packages/ui/src/app/App.tsx'), 'utf8')
    const m = /className="flex h-(\d+) shrink-0 items-center gap-4 border-b border-edge bg-pit/.exec(header)
    expect(m, '상단 바의 h-* 클래스를 찾지 못했다').toBeTruthy()
    const barPx = Number(m![1]) * 4 // tailwind h-9 = 36px
    const BUTTON = 12 // macOS 신호등 지름

    const conf = JSON.parse(
      readFileSync(join(ROOT, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'),
    ) as { app: { windows: { trafficLightPosition?: { x: number; y: number } }[] } }
    const pos = conf.app.windows[0]!.trafficLightPosition
    expect(pos, 'trafficLightPosition이 없으면 첫 프레임이 기본 자리에서 시작한다').toBeTruthy()
    expect(pos!.y).toBe((barPx - BUTTON) / 2)

    const rust = readFileSync(join(ROOT, 'apps/desktop/src-tauri/src/traffic_lights.rs'), 'utf8')
    const h = /const HEADER_H: f64 = ([\d.]+);/.exec(rust)
    expect(h, 'traffic_lights.rs의 HEADER_H를 찾지 못했다').toBeTruthy()
    expect(Number(h![1])).toBe(barPx)

    const x = /const INSET_X: f64 = ([\d.]+);/.exec(rust)
    expect(Number(x![1]), '설정과 Rust의 x가 다르면 첫 프레임에서 옆으로 튄다').toBe(pos!.x)
  })

  it('웹뷰가 OS 드롭을 가로채지 않는다 (파일 첨부가 죽는다)', () => {
    const conf = JSON.parse(
      readFileSync(join(ROOT, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'),
    ) as { app: { windows: { dragDropEnabled?: boolean }[] } }
    expect(conf.app.windows[0]!.dragDropEnabled).toBe(false)
  })
})
