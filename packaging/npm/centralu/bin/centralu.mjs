#!/usr/bin/env node
/**
 * Centralu 실행기.
 *
 * **왜 npm으로 주는가:** macOS는 앱을 검사해서 위험하다고 판정하는 게 아니라,
 * 파일에 붙은 `com.apple.quarantine` 딱지를 보고 개발자 신원을 따진다. 그 딱지는
 * **받아온 프로그램이** 붙인다 — 브라우저는 붙이고 npm은 안 붙인다. 그래서 npm으로
 * 설치하면 서명이 애드혹이어도 경고 없이 그냥 열린다 (docs/plans/beta-release-checklist.md §2).
 *
 * 앱 본체는 아키텍처별 패키지(`centralu-darwin-arm64`)에 들어 있다. 이 패키지는
 * 그것을 찾아 띄우는 얇은 껍데기다 — esbuild·swc가 쓰는 것과 같은 구조.
 *
 * Linux is served from the same shim (issue #14). The two platforms disagree about what
 * "the app" even is — macOS hands a `.app` directory to LaunchServices, Linux runs a
 * self-contained AppImage itself — so that difference lives in one table (`TARGETS`)
 * instead of being rediscovered in every function.
 */
import { execFileSync, spawn } from 'node:child_process'
import { isNewer } from './semver.mjs'
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const pkg = require('../package.json')

const APP_NAME = 'Centralu'
const BUNDLE = `${APP_NAME}.app`
const INSTALLED = `/Applications/${BUNDLE}`

/** Where a menu entry for the app goes on freedesktop desktops */
const DESKTOP_ENTRY = join(homedir(), '.local/share/applications/centralu.desktop')

/**
 * The arch package for this machine, and what the app is called inside it.
 *
 * `artifact` must match `scripts/release-npm.mts` exactly — that script renames what
 * Tauri produced (`Centralu_0.1.0-beta.2_amd64.AppImage`) to a fixed name precisely so
 * this file does not have to know version or architecture. If the two ever disagree the
 * symptom is "installed fine, does nothing", so keep them in one place mentally.
 *
 * Only combinations that are actually published belong here. Listing a package that was
 * never released would turn "not supported yet" into "your install is broken", which
 * sends the user off to reinstall something that can never appear.
 */
const TARGETS = {
  'darwin-arm64': { pkg: 'centralu-darwin-arm64', artifact: BUNDLE },
  'linux-x64': { pkg: 'centralu-linux-x64', artifact: `${APP_NAME}.AppImage` },
}

const TARGET = TARGETS[`${process.platform}-${process.arch}`]

/** 아키텍처별 패키지 안의 앱. 못 찾으면 null */
function bundledApp() {
  if (!TARGET) return null
  let root
  try {
    root = dirname(require.resolve(`${TARGET.pkg}/package.json`))
  } catch {
    return null // 이 아키텍처용 패키지가 안 깔린 것 — 아래에서 이유를 말한다
  }
  const app = join(root, TARGET.artifact)
  return existsSync(app) ? app : null
}

/**
 * 지금 이 기계에서 왜 못 쓰는지를 **구체적으로** 말한다.
 * "설치가 안 됐습니다"만 뜨면 사용자가 할 수 있는 일이 없다.
 */
function explainMissing() {
  if (!TARGET) {
    // Kept as its own case: "not published for your machine" and "not published for
    // Intel Macs, and here is the reason" send the user to different places.
    if (process.platform === 'darwin') {
      return (
        `${APP_NAME}는 아직 Apple Silicon 전용입니다 (지금 아키텍처: ${process.arch}).\n` +
        'Intel 맥 지원은 네이티브 애드온까지 함께 묶어야 해서 별도 작업으로 잡혀 있습니다.'
      )
    }
    const supported = Object.keys(TARGETS).join(', ')
    return (
      `${APP_NAME}는 아직 ${process.platform}/${process.arch}를 지원하지 않습니다.\n` +
      `지금 지원하는 조합: ${supported}\n` +
      'https://github.com/ijun17/centralu/issues/14 에 진행 상황이 있습니다.'
    )
  }
  return (
    `앱 본체 패키지(${TARGET.pkg})를 찾지 못했습니다.\n` +
    '설치가 중간에 끊겼을 수 있습니다 — `npm i -g centralu`로 다시 설치해 주세요.'
  )
}

function requireApp() {
  const app = bundledApp()
  if (!app) {
    console.error(explainMissing())
    process.exit(1)
  }
  return app
}

/**
 * 앱을 띄운다. `/Applications`에 설치돼 있으면 그쪽을 먼저 쓴다.
 *
 * That preference is macOS-only, and not for lack of an equivalent: `centralu install`
 * on Linux writes a launcher that points back at this same package, so there is never a
 * second copy to prefer.
 */
function run(args) {
  if (process.platform === 'darwin') {
    const app = existsSync(INSTALLED) ? INSTALLED : requireApp()
    // `open`은 LaunchServices를 거친다 — Dock 아이콘·단일 인스턴스가 그래야 제대로 산다
    const r = spawn('open', ['-a', app, ...(args.length ? ['--args', ...args] : [])], { stdio: 'inherit' })
    r.on('exit', (code) => process.exit(code ?? 0))
    return
  }
  // Linux has no LaunchServices — the AppImage is its own launcher, so run it directly.
  //
  // Staying attached to the terminal is on purpose. The two usual first failures on
  // Linux both explain themselves on stderr and nowhere else: a missing FUSE
  // ("AppImages require FUSE to run", with the workaround in the same sentence) and a
  // missing system library from the loader. Detaching would hand back the shell prompt
  // and throw away the one line that says what to do.
  const app = requireApp()
  const r = spawn(app, args, { stdio: 'inherit' })
  r.on('error', (e) => {
    console.error(`${app}를 실행하지 못했습니다: ${e.message}`)
    // EACCES here means the executable bit did not survive the trip through npm, which
    // is invisible from the message alone.
    if (e.code === 'EACCES') console.error(`실행 권한이 없습니다 — \`chmod +x "${app}"\` 뒤에 다시 시도해 주세요.`)
    process.exit(1)
  })
  r.on('exit', (code) => process.exit(code ?? 0))
}

/**
 * 앱을 시스템 메뉴에 등록한다.
 *
 * **postinstall로 몰래 하지 않는다.** 남의 `/Applications`에 조용히 쓰는 것은 신뢰를 깎고,
 * pnpm은 postinstall을 기본 차단한다. 사용자가 원할 때 명시적으로 부르게 한다.
 */
function install() {
  const app = requireApp()
  if (process.platform !== 'darwin') return installDesktopEntry(app)
  if (existsSync(INSTALLED)) {
    console.log(`기존 ${INSTALLED}를 새 버전으로 교체합니다.`)
    rmSync(INSTALLED, { recursive: true, force: true })
  }
  // cp가 아니라 ditto — 번들의 권한·확장속성을 그대로 옮긴다 (서명이 깨지지 않게)
  execFileSync('/usr/bin/ditto', [app, INSTALLED], { stdio: 'inherit' })
  console.log(`설치했습니다: ${INSTALLED}`)
  console.log('이제 Launchpad·Spotlight에서도 찾을 수 있습니다.')
}

/**
 * The Linux answer to "copy it into /Applications so it shows up in Launchpad".
 *
 * It writes a launcher, not a copy. On macOS the `.app` has to move because
 * LaunchServices only indexes a few directories; on Linux the menu indexes `.desktop`
 * files that may point anywhere, so pointing at the npm package leaves exactly one copy
 * of the binary — and `npm i -g centralu@newer` then updates the menu entry too,
 * because the path it names does not change.
 */
function installDesktopEntry(app) {
  const icon = join(dirname(app), 'icon.png')
  const entry = [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${APP_NAME}`,
    'Comment=Run, watch and steer several coding agents in one window',
    // Quoted because the path runs through node_modules and npm prefixes can contain spaces
    `Exec="${app}" %U`,
    `Icon=${existsSync(icon) ? icon : 'centralu'}`,
    'Terminal=false',
    'Categories=Development;Utility;',
    // Guessed, not measured: this must equal the WM class the running window reports,
    // and we have no Linux desktop here to read it off. If the taskbar shows two icons
    // for one window, this line is why.
    'StartupWMClass=Centralu',
    '',
  ].join('\n')
  mkdirSync(dirname(DESKTOP_ENTRY), { recursive: true })
  writeFileSync(DESKTOP_ENTRY, entry)
  chmodSync(DESKTOP_ENTRY, 0o755)
  console.log(`등록했습니다: ${DESKTOP_ENTRY}`)
  console.log('이제 앱 목록에서도 찾을 수 있습니다 (데스크톱에 따라 다시 로그인해야 보일 수 있습니다).')
}

function uninstall() {
  const installed = process.platform === 'darwin' ? INSTALLED : DESKTOP_ENTRY
  if (!existsSync(installed)) {
    console.log(`${installed}가 없습니다 — 지울 것이 없습니다.`)
    return
  }
  rmSync(installed, { recursive: true, force: true })
  console.log(`지웠습니다: ${installed}`)
  console.log('패키지 자체를 지우려면: npm uninstall -g centralu')
  console.log(`대화 기록은 그대로 남아 있습니다 (~/.centralu). 지우려면 직접 지우세요.`)
}

/**
 * npm 레지스트리가 곧 업데이트 채널이다 — 서버도 서명 키도 따로 필요 없다.
 *
 * 실패를 뭉뚱그리지 않는다. 못 닿은 것(네트워크)과 없는 것(404)은 **사용자가 할 일이 다르다** —
 * 앞은 연결을 보라는 말이고, 뒤는 봐도 소용없다는 말이다.
 */
async function latestVersion(timeoutMs = 2000) {
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg.name}/latest`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.status === 404) return { ok: false, reason: 'missing' }
    if (!res.ok) return { ok: false, reason: `http ${res.status}` }
    const body = await res.json()
    const version = body?.version
    return typeof version === 'string' ? { ok: true, version } : { ok: false, reason: 'bad-response' }
  } catch {
    return { ok: false, reason: 'network' } // 네트워크가 없어도 앱은 떠야 한다
  }
}


async function update() {
  const res = await latestVersion(8000)
  if (!res.ok) {
    if (res.reason === 'missing') {
      console.error(`레지스트리에 ${pkg.name}가 없습니다. 이름이 바뀌었거나 아직 발행 전입니다.`)
      console.error('https://github.com/ijun17/centralu/releases 를 확인해 주세요.')
    } else if (res.reason === 'network') {
      console.error('레지스트리에 닿지 못했습니다. 네트워크를 확인하고 다시 시도해 주세요.')
    } else {
      console.error(`레지스트리가 예상 밖의 응답을 했습니다 (${res.reason}).`)
    }
    process.exit(1)
  }
  const latest = res.version
  if (!isNewer(latest, pkg.version)) {
    console.log(`이미 최신입니다 (${pkg.version}).`)
    return
  }
  console.log(`${pkg.version} → ${latest} 로 올립니다.`)
  execFileSync('npm', ['i', '-g', `${pkg.name}@${latest}`], { stdio: 'inherit' })
  // /Applications에 넣어둔 사람은 그쪽도 함께 갱신해야 옛 버전이 남지 않는다.
  // On Linux the menu entry points at the package instead of a copy, so rewriting it is
  // cheap — but it is still worth doing, because the Exec path is what would go stale.
  const installed = process.platform === 'darwin' ? INSTALLED : DESKTOP_ENTRY
  if (existsSync(installed)) {
    console.log(`${installed}도 갱신합니다.`)
    execFileSync(process.argv[1], ['install'], { stdio: 'inherit' })
  }
  console.log('끝났습니다. 앱이 떠 있다면 다시 시작해 주세요.')
}

/** 앱을 띄운 뒤에만 알린다 — 업데이트 확인 때문에 실행이 늦어지면 안 된다 */
async function notifyIfOutdated() {
  // 여기서는 실패를 **전부 삼킨다.** 앱을 띄우러 온 사람에게 레지스트리 사정을 말할 이유가 없다
  const res = await latestVersion()
  if (res.ok && isNewer(res.version, pkg.version)) {
    console.log(`\n새 버전이 있습니다: ${pkg.version} → ${res.version}\n  centralu update`)
  }
}

const HELP = `${APP_NAME} ${pkg.version}

  centralu              앱을 실행합니다
  centralu install      앱 목록에 등록합니다 (macOS는 /Applications, Linux는 메뉴 항목)
  centralu uninstall    그 등록을 지웁니다 (대화 기록은 남습니다)
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
