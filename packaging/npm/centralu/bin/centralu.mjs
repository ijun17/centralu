#!/usr/bin/env node
/**
 * Centralu 실행기.
 *
 * **왜 npm으로 주는가:** macOS는 앱을 검사해서 위험하다고 판정하는 게 아니라,
 * 파일에 붙은 `com.apple.quarantine` 딱지를 보고 개발자 신원을 따진다. 그 딱지는
 * **받아온 프로그램이** 붙인다 — 브라우저는 붙이고 npm은 안 붙인다. 그래서 npm으로
 * 설치하면 서명이 애드혹이어도 경고 없이 그냥 열린다 (docs/plans/beta-release-checklist.md §2).
 *
 * 앱 본체는 아키텍처별 패키지(`@centralu/darwin-arm64`)에 들어 있다. 이 패키지는
 * 그것을 찾아 띄우는 얇은 껍데기다 — esbuild·swc가 쓰는 것과 같은 구조.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const pkg = require('../package.json')

const APP_NAME = 'Centralu'
const BUNDLE = `${APP_NAME}.app`
const INSTALLED = `/Applications/${BUNDLE}`

/** 아키텍처별 패키지 안의 `.app`. 못 찾으면 null */
function bundledApp() {
  for (const dep of ['@centralu/darwin-arm64']) {
    try {
      return join(dirname(require.resolve(`${dep}/package.json`)), BUNDLE)
    } catch {
      // 이 아키텍처용 패키지가 안 깔린 것 — 아래에서 이유를 말한다
    }
  }
  return null
}

/**
 * 지금 이 맥에서 왜 못 쓰는지를 **구체적으로** 말한다.
 * "설치가 안 됐습니다"만 뜨면 사용자가 할 수 있는 일이 없다.
 */
function explainMissing() {
  if (process.platform !== 'darwin') {
    return `${APP_NAME}는 macOS 앱입니다 (지금 플랫폼: ${process.platform}).`
  }
  if (process.arch !== 'arm64') {
    return (
      `${APP_NAME}는 아직 Apple Silicon 전용입니다 (지금 아키텍처: ${process.arch}).\n` +
      'Intel 맥 지원은 네이티브 애드온까지 함께 묶어야 해서 별도 작업으로 잡혀 있습니다.'
    )
  }
  return (
    '앱 본체 패키지(@centralu/darwin-arm64)를 찾지 못했습니다.\n' +
    '설치가 중간에 끊겼을 수 있습니다 — `npm i -g centralu`로 다시 설치해 주세요.'
  )
}

function requireApp() {
  const app = bundledApp()
  if (!app || !existsSync(app)) {
    console.error(explainMissing())
    process.exit(1)
  }
  return app
}

/** 앱을 띄운다. `/Applications`에 설치돼 있으면 그쪽을 먼저 쓴다 */
function run(args) {
  const app = existsSync(INSTALLED) ? INSTALLED : requireApp()
  // `open`은 LaunchServices를 거친다 — Dock 아이콘·단일 인스턴스가 그래야 제대로 산다
  const r = spawn('open', ['-a', app, ...(args.length ? ['--args', ...args] : [])], { stdio: 'inherit' })
  r.on('exit', (code) => process.exit(code ?? 0))
}

/**
 * `/Applications`에 복사한다.
 *
 * **postinstall로 몰래 하지 않는다.** 남의 `/Applications`에 조용히 쓰는 것은 신뢰를 깎고,
 * pnpm은 postinstall을 기본 차단한다. 사용자가 원할 때 명시적으로 부르게 한다.
 */
function install() {
  const app = requireApp()
  if (existsSync(INSTALLED)) {
    console.log(`기존 ${INSTALLED}를 새 버전으로 교체합니다.`)
    rmSync(INSTALLED, { recursive: true, force: true })
  }
  // cp가 아니라 ditto — 번들의 권한·확장속성을 그대로 옮긴다 (서명이 깨지지 않게)
  execFileSync('/usr/bin/ditto', [app, INSTALLED], { stdio: 'inherit' })
  console.log(`설치했습니다: ${INSTALLED}`)
  console.log('이제 Launchpad·Spotlight에서도 찾을 수 있습니다.')
}

function uninstall() {
  if (!existsSync(INSTALLED)) {
    console.log(`${INSTALLED}가 없습니다 — 지울 것이 없습니다.`)
    return
  }
  rmSync(INSTALLED, { recursive: true, force: true })
  console.log(`지웠습니다: ${INSTALLED}`)
  console.log('패키지 자체를 지우려면: npm uninstall -g centralu')
  console.log(`대화 기록은 그대로 남아 있습니다 (~/.control-center). 지우려면 직접 지우세요.`)
}

/** npm 레지스트리가 곧 업데이트 채널이다 — 서버도 서명 키도 따로 필요 없다 */
async function latestVersion(timeoutMs = 2000) {
  const stop = AbortSignal.timeout(timeoutMs)
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg.name}/latest`, { signal: stop })
    if (!res.ok) return null
    const body = await res.json()
    return typeof body?.version === 'string' ? body.version : null
  } catch {
    return null // 네트워크가 없어도 앱은 떠야 한다
  }
}

/** `1.2.10` > `1.2.9` — 문자열 비교로는 틀린다 */
function isNewer(a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

async function update() {
  const latest = await latestVersion(8000)
  if (!latest) {
    console.error('레지스트리에 닿지 못했습니다. 네트워크를 확인하고 다시 시도해 주세요.')
    process.exit(1)
  }
  if (!isNewer(latest, pkg.version)) {
    console.log(`이미 최신입니다 (${pkg.version}).`)
    return
  }
  console.log(`${pkg.version} → ${latest} 로 올립니다.`)
  execFileSync('npm', ['i', '-g', `${pkg.name}@${latest}`], { stdio: 'inherit' })
  // /Applications에 넣어둔 사람은 그쪽도 함께 갱신해야 옛 버전이 남지 않는다
  if (existsSync(INSTALLED)) {
    console.log(`${INSTALLED}도 갱신합니다.`)
    execFileSync(process.argv[1], ['install'], { stdio: 'inherit' })
  }
  console.log('끝났습니다. 앱이 떠 있다면 다시 시작해 주세요.')
}

/** 앱을 띄운 뒤에만 알린다 — 업데이트 확인 때문에 실행이 늦어지면 안 된다 */
async function notifyIfOutdated() {
  const latest = await latestVersion()
  if (latest && isNewer(latest, pkg.version)) {
    console.log(`\n새 버전이 있습니다: ${pkg.version} → ${latest}\n  centralu update`)
  }
}

const HELP = `${APP_NAME} ${pkg.version}

  centralu              앱을 실행합니다
  centralu install      /Applications에 복사합니다 (Launchpad·Spotlight에 뜨게)
  centralu uninstall    /Applications에서 지웁니다 (대화 기록은 남습니다)
  centralu update       새 버전이 있으면 올립니다
  centralu --version    버전을 출력합니다

필요한 것: Node 22+, 그리고 claude 또는 codex CLI (앱 첫 화면이 상태를 알려줍니다)`

const [cmd, ...rest] = process.argv.slice(2)
switch (cmd) {
  case 'install':
    install()
    break
  case 'uninstall':
    uninstall()
    break
  case 'update':
    await update()
    break
  case '--version':
  case '-v':
    console.log(pkg.version)
    break
  case '--help':
  case '-h':
  case 'help':
    console.log(HELP)
    break
  default:
    run(cmd ? [cmd, ...rest] : [])
    await notifyIfOutdated()
}
