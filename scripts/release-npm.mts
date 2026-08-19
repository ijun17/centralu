/**
 * npm 릴리스 — 빌드된 `.app`을 아키텍처 패키지에 넣고 두 패키지를 발행한다.
 *
 * **기본은 리허설이다.** `--publish` 없이 부르면 `npm pack`까지만 하고 멈춘다.
 * 발행은 되돌릴 수 없다(npm은 24시간 뒤 unpublish를 막는다). 그래서 실수하기 어렵게 만든다.
 *
 *   pnpm release:npm              # 리허설 — 빌드·복사·검사·pack
 *   pnpm release:npm --publish    # 실제 발행
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_NAME, APP_VERSION } from '../packages/protocol/src/brand.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = `${APP_NAME}.app`
const BUILT = join(ROOT, `apps/desktop/src-tauri/target/release/bundle/macos/${BUNDLE}`)
const ARCH_PKG = join(ROOT, 'packaging/npm/darwin-arm64')
const MAIN_PKG = join(ROOT, 'packaging/npm/centralu')

const publish = process.argv.includes('--publish')
const skipBuild = process.argv.includes('--skip-build')

const sh = (cmd: string, args: string[], cwd = ROOT) =>
  execFileSync(cmd, args, { cwd, stdio: 'inherit', encoding: 'utf8' })
const out = (cmd: string, args: string[], cwd = ROOT) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim()

function step(msg: string) {
  console.log(`\n\x1b[1m▶ ${msg}\x1b[0m`)
}

function fail(msg: string): never {
  console.error(`\n\x1b[31m✗ ${msg}\x1b[0m`)
  process.exit(1)
}

// ── 1. 발행해도 되는 상태인가 ──────────────────────────────────────────
step('발행 전 확인')

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  fail(`이 스크립트는 Apple Silicon 맥에서만 돈다 (지금: ${process.platform}/${process.arch})`)
}

if (out('git', ['status', '--porcelain'])) {
  // 커밋되지 않은 변경이 섞여 나가면 "발행된 것"과 "저장소의 것"이 달라진다.
  // host 기동 배너에 박히는 빌드 해시도 `-dirty`가 되어 어느 코드인지 못 가린다.
  fail('작업 트리가 깨끗하지 않다. 커밋하거나 되돌린 뒤 다시 실행해라.')
}

sh('pnpm', ['verify'])

console.log(`  버전 ${APP_VERSION} · 커밋 ${out('git', ['rev-parse', '--short', 'HEAD'])}`)

// ── 2. 빌드 ────────────────────────────────────────────────────────────
if (skipBuild) {
  console.log('\n  --skip-build: 이미 빌드된 번들을 쓴다')
} else {
  step('배포 앱 빌드')
  sh('pnpm', ['--filter', '@cc/desktop', 'exec', 'tauri', 'build'])
}
if (!existsSync(BUILT)) fail(`번들이 없다: ${BUILT}`)

// ── 3. 번들을 아키텍처 패키지로 ────────────────────────────────────────
step('번들 복사')
const dest = join(ARCH_PKG, BUNDLE)
rmSync(dest, { recursive: true, force: true })
// cp가 아니라 ditto — 권한·확장속성을 그대로 옮긴다 (서명이 깨지지 않게)
sh('/usr/bin/ditto', [BUILT, dest])

// ── 4. 넣은 것이 실제로 성립하는가 ─────────────────────────────────────
step('번들 검증')

// (a) 서명이 살아 있나 — npm tarball을 왕복해도 살아남는 것은 확인했지만, 넣기 전이 깨져 있으면 소용없다
sh('/usr/bin/codesign', ['--verify', '--deep', '--strict', dest])
console.log('  서명 유효')

// (b) 실행 파일에 실행 비트가 있나 — 이게 빠지면 설치는 되는데 안 열린다
const bin = join(dest, 'Contents/MacOS/centralu')
if (!existsSync(bin)) fail(`실행 파일이 없다: ${bin}`)
const mode = out('/bin/sh', ['-c', `stat -f '%p' '${bin}'`])
if (!/[157][157][157]$/.test(mode.slice(-3))) fail(`실행 비트가 없다 (${mode})`)
console.log('  실행 비트 정상')

// (c) 아키텍처
const arch = out('/usr/bin/file', ['-b', bin])
if (!arch.includes('arm64')) fail(`arm64가 아니다: ${arch}`)
console.log(`  ${arch.split(',')[0]}`)

// ── 5. 버전을 한 곳(brand.ts)에서 받아 적는다 ──────────────────────────
step('패키지 버전 맞추기')
for (const pkgDir of [ARCH_PKG, MAIN_PKG]) {
  const file = join(pkgDir, 'package.json')
  const json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  json.version = APP_VERSION
  if (json.optionalDependencies) {
    // 메인 패키지는 **정확한 버전**을 가리켜야 한다. 범위(^)로 두면 아키텍처 패키지만
    // 새 버전이 깔려 껍데기와 알맹이가 어긋날 수 있다
    json.optionalDependencies = Object.fromEntries(
      Object.keys(json.optionalDependencies as object).map((k) => [k, APP_VERSION]),
    )
  }
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`)
  console.log(`  ${json.name as string}@${APP_VERSION}`)
}

// ── 6. pack (그리고 원하면 publish) ────────────────────────────────────
// 아키텍처 패키지가 **먼저** 발행돼야 한다. 반대로 하면 메인 패키지를 깐 사람이
// 없는 optional dependency를 바라보는 순간이 생긴다.
for (const pkgDir of [ARCH_PKG, MAIN_PKG]) {
  const name = (JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { name: string }).name
  if (publish) {
    step(`발행: ${name}`)
    sh('npm', ['publish', '--access', 'public'], pkgDir)
  } else {
    step(`리허설(pack): ${name}`)
    sh('npm', ['pack', '--dry-run'], pkgDir)
  }
}

console.log(
  publish
    ? `\n\x1b[32m발행 완료 — npm i -g centralu\x1b[0m`
    : `\n리허설이 끝났다. 실제로 올리려면: \x1b[1mpnpm release:npm --publish\x1b[0m`,
)
