/**
 * npm 릴리스 — 빌드된 `.app`을 아키텍처 패키지에 넣고 두 패키지를 발행한다.
 *
 * **기본은 리허설이다.** `--publish` 없이 부르면 `npm pack`까지만 하고 멈춘다.
 * 발행은 되돌릴 수 없다(npm은 24시간 뒤 unpublish를 막는다). 그래서 실수하기 어렵게 만든다.
 *
 *   pnpm release:npm              # 리허설 — 빌드·복사·검사·pack
 *   pnpm release:npm --publish    # 실제 발행
 *
 * Platform coverage (#14). The platform package is always the one for the host this
 * runs on, and there is no cross-build switch. That is not laziness: every check
 * below interrogates a real artifact — the code signature, the exec bit, the machine
 * type reported by `file` — and none of those questions can be answered honestly
 * about a Linux binary from a Mac. A cross-build flag would only let us publish an
 * unverified bundle. The other host comes from CI instead
 * (`.github/workflows/publish-linux-npm.yml`).
 */
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_NAME, APP_VERSION } from '../packages/protocol/src/brand.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE_ROOT = join(ROOT, 'apps/desktop/src-tauri/target/release/bundle')
const MAIN_PKG = join(ROOT, 'packaging/npm/centralu')

const publish = process.argv.includes('--publish')
const skipBuild = process.argv.includes('--skip-build')
/**
 * Publish the platform package but not the `centralu` shim.
 *
 * Needed because the shim pins its platform packages to an exact version, so it can
 * only go out once *every* platform is already on the registry at that version. With
 * more than one platform that is no longer a single run on a single machine: Linux is
 * published from CI, macOS from a Mac, and whoever goes last publishes the shim.
 */
const platformOnly = process.argv.includes('--platform-only')
/**
 * 2단계 인증이 켜진 계정은 발행마다 OTP를 묻는다. 그 물음은 **대화형 입력**이라
 * 자동화된 자리(에이전트·CI)에서는 답할 수 없어 그냥 멈춰 버린다.
 * 미리 받아서 넘길 수 있게 열어 둔다: `pnpm release:npm --publish --otp=123456`
 */
const otp = process.argv.find((a) => a.startsWith('--otp='))?.slice('--otp='.length)
/**
 * 프리릴리스도 `npm i -g centralu`(태그 없는 기본 설치)로 받게 할지.
 *
 * 아직 정식 릴리스가 하나도 없으면 `latest` 태그가 비어서 그 명령이 **실패한다** —
 * "No matching version found for centralu@latest". 베타만 있는 동안에는 이걸 켠다.
 * 정식이 나온 뒤에는 켜면 안 된다 (베타가 정식을 덮는다).
 */
const alsoLatest = process.argv.includes('--also-latest')

/**
 * 프리릴리스(`0.1.0-beta.1`)는 반드시 태그를 붙여야 한다 — npm이 거부한다.
 * 안 그러면 베타가 `latest`가 되어, 아무 생각 없이 설치한 사람이 베타를 받는다.
 */
const tag = APP_VERSION.includes('-') ? 'beta' : 'latest'

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

/**
 * Exactly one match under `dir`, or stop.
 *
 * Tauri stamps the version and the architecture into Linux bundle file names
 * (`Centralu_0.1.0-beta.2_amd64.AppImage`) and rewrites them on the way, so matching a
 * literal name would break the first time the version format changes. Reading the
 * directory instead is only safe if we refuse to guess: `target/` is never cleaned
 * between builds, so "take the first one" would happily ship last month's bundle.
 */
function soleFile(dir: string, keep: (name: string) => boolean): string {
  if (!existsSync(dir)) fail(`bundle directory is missing — did the build produce anything? ${dir}`)
  const hits = readdirSync(dir).filter(keep)
  if (hits.length === 0) fail(`no bundle found in ${dir}`)
  if (hits.length > 1) fail(`${hits.length} bundles in ${dir} — delete the stale ones: ${hits.join(', ')}`)
  return join(dir, hits[0] as string)
}

/** Read the first `n` bytes without pulling a ~100MB bundle into memory. */
function head(path: string, n: number): Buffer {
  const buf = Buffer.alloc(n)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, buf, 0, n, 0)
  } finally {
    closeSync(fd)
  }
  return buf
}

type Target = {
  /** npm package suffix (`centralu-<id>`) *and* the `packaging/npm/` directory name */
  id: string
  /** `tauri build --bundles` override; omitted where tauri.conf.json already names the right targets */
  bundles?: string
  /** the name the artifact takes inside the npm package — fixed, so the launcher can find it */
  artifact: string
  /** locate what the build just produced */
  locate: () => string
  /** copy it into the package directory, keeping whatever makes it runnable */
  install: (src: string, dest: string) => void
  /** prove the copied artifact is intact, executable, and the right machine */
  check: (dest: string) => void
}

const TARGETS: Record<string, Target | undefined> = {
  'darwin-arm64': {
    id: 'darwin-arm64',
    artifact: `${APP_NAME}.app`,
    locate: () => join(BUNDLE_ROOT, 'macos', `${APP_NAME}.app`),
    install: (src, dest) => {
      rmSync(dest, { recursive: true, force: true })
      // cp가 아니라 ditto — 권한·확장속성을 그대로 옮긴다 (서명이 깨지지 않게)
      sh('/usr/bin/ditto', [src, dest])
    },
    check: (dest) => {
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
    },
  },

  'linux-x64': {
    id: 'linux-x64',
    /*
     * `tauri.linux.conf.json` builds both a `.deb` and an AppImage; narrow it here because
     * only the AppImage is shipped through npm. The AppImage carries its own webkit2gtk and
     * friends, so it runs on a machine where the user installed nothing — which is the whole
     * point of shipping through npm. A `.deb` needs root and apt: a different delivery
     * channel, not this one. Building it during a release would only cost time.
     */
    bundles: 'appimage',
    artifact: `${APP_NAME}.AppImage`,
    locate: () => soleFile(join(BUNDLE_ROOT, 'appimage'), (n) => n.endsWith('.AppImage')),
    install: (src, dest) => {
      rmSync(dest, { force: true })
      cpSync(src, dest)
      /*
       * Ship the icon next to the AppImage. `centralu install` writes a freedesktop
       * `.desktop` entry, and that entry can only point at an icon *file on disk* — the one
       * embedded in the AppImage is invisible to the menu. Without this the launcher falls
       * back to the bare name `centralu`, which resolves to nothing, and the app shows up in
       * the application menu as a generic grey square.
       *
       * Copied at release time rather than committed so it cannot drift from the icon the
       * build actually used; `.gitignore` covers it like the bundle itself.
       */
      cpSync(join(ROOT, 'apps/desktop/src-tauri/icons/icon.png'), join(dirname(dest), 'icon.png'))
      /*
       * Set +x rather than trusting whatever produced the file. The bit is easy to lose in
       * transit — a GitHub Actions artifact is a zip and drops it outright — and losing it
       * gives a symptom that does not name its cause: the package installs fine and then
       * nothing happens. `packages/agent-host/scripts/bundle.mjs` carries the same guard for
       * node-pty's spawn-helper, and the comment there records how long that one took to find.
       */
      chmodSync(dest, 0o755)
    },
    check: (dest) => {
      /*
       * (a) macOS verifies the code signature here. An AppImage has none, so check what the
       *     signature was really standing in for: that this file is the artifact we think it
       *     is and did not arrive truncated. A type-2 AppImage is an ELF whose bytes 8..10
       *     are the magic `AI\x02` — both halves matter, since a half-written file can still
       *     start with a valid ELF header.
       */
      const magic = head(dest, 11)
      if (magic.subarray(0, 4).toString('latin1') !== '\x7fELF') fail(`not an ELF binary: ${dest}`)
      if (magic[8] !== 0x41 || magic[9] !== 0x49 || magic[10] !== 0x02) {
        fail(`not a type-2 AppImage — magic is ${[...magic.subarray(8, 11)].join(',')}, expected 65,73,2`)
      }
      console.log('  AppImage magic ok')

      // (b) exec bit — same failure mode as macOS: it installs, then nothing opens
      const mode = out('/usr/bin/stat', ['-c', '%a', dest])
      if (!/[157]$/.test(mode)) fail(`no exec bit (${mode})`)
      console.log('  exec bit ok')

      // (c) machine type
      const arch = out('/usr/bin/file', ['-b', dest])
      if (!arch.includes('x86-64')) fail(`not x86-64: ${arch}`)
      console.log(`  ${arch.split(',')[0]}`)
    },
  },
}

// ── 1. 발행해도 되는 상태인가 ──────────────────────────────────────────
step('발행 전 확인')

const HOST = `${process.platform}-${process.arch}`
const target = TARGETS[HOST]
if (!target) {
  fail(
    `no npm package is defined for ${HOST} (have: ${Object.keys(TARGETS).join(', ')}).\n` +
      'The bundle must be built on the platform it ships to, so this cannot be overridden here — ' +
      'add a target above and a matching packaging/npm/<id>/package.json first.',
  )
}

const ARCH_PKG = join(ROOT, 'packaging/npm', target.id)
if (!existsSync(join(ARCH_PKG, 'package.json'))) fail(`platform package is missing: ${ARCH_PKG}/package.json`)

if (out('git', ['status', '--porcelain'])) {
  // 커밋되지 않은 변경이 섞여 나가면 "발행된 것"과 "저장소의 것"이 달라진다.
  // host 기동 배너에 박히는 빌드 해시도 `-dirty`가 되어 어느 코드인지 못 가린다.
  fail('작업 트리가 깨끗하지 않다. 커밋하거나 되돌린 뒤 다시 실행해라.')
}

if (publish) {
  // 빌드까지 다 돌린 뒤에 인증에서 막히면 몇 분을 버린다 — 제일 먼저 확인한다
  try {
    console.log(`  npm 사용자: ${out('npm', ['whoami'])}`)
  } catch {
    fail('npm에 로그인돼 있지 않다. `npm login`을 먼저 실행해라 (웹 로그인은 CLI 인증과 별개다).')
  }
}

sh('pnpm', ['verify'])

console.log(
  `  ${target.id} · 버전 ${APP_VERSION} · 태그 ${tag} · 커밋 ${out('git', ['rev-parse', '--short', 'HEAD'])}`,
)

// ── 2. 빌드 ────────────────────────────────────────────────────────────
if (skipBuild) {
  console.log('\n  --skip-build: 이미 빌드된 번들을 쓴다')
} else {
  step('배포 앱 빌드')
  sh('pnpm', [
    '--filter',
    '@cc/desktop',
    'exec',
    'tauri',
    'build',
    ...(target.bundles ? ['--bundles', target.bundles] : []),
  ])
}
const built = target.locate()
if (!existsSync(built)) fail(`번들이 없다: ${built}`)

// ── 3. 번들을 아키텍처 패키지로 ────────────────────────────────────────
step('번들 복사')
const dest = join(ARCH_PKG, target.artifact)
target.install(built, dest)

// ── 4. 넣은 것이 실제로 성립하는가 ─────────────────────────────────────
step('번들 검증')
target.check(dest)

// `files`가 실제로 넣은 것을 가리키지 않으면 tarball이 **껍데기만** 나간다 — pack 로그를
// 눈으로 확인하기 전에는 티가 안 난다. 이름을 한 곳(APP_NAME)에서 받아 쓰는 이상 여기서 막는다.
const archManifest = JSON.parse(readFileSync(join(ARCH_PKG, 'package.json'), 'utf8')) as { files?: string[] }
if (!archManifest.files?.includes(target.artifact)) {
  fail(`${ARCH_PKG}/package.json "files" does not list ${target.artifact} — the tarball would ship empty`)
}
// And the other way round: npm drops a `files` entry that is not on disk without saying so,
// so a listed-but-absent icon packs, installs, and only shows up as a wrong menu entry later.
for (const entry of archManifest.files ?? []) {
  if (!existsSync(join(ARCH_PKG, entry))) {
    fail(`${ARCH_PKG}/package.json "files" lists ${entry}, which is not on disk — npm would drop it silently`)
  }
}

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

/**
 * The shim may only go out once every platform package it pins is already on the registry.
 *
 * This is the multi-platform version of the ordering rule below. npm treats an
 * optionalDependency that fails to resolve as a non-event: the install succeeds, nothing
 * is printed loudly, and the user is left with a shim that reports a missing app — which
 * reads as "your install is broken", not as "your platform isn't out yet". The
 * single-platform script could not reach this state, so the check did not exist.
 */
function assertPinnedPlatformsPublished() {
  const main = JSON.parse(readFileSync(join(MAIN_PKG, 'package.json'), 'utf8')) as {
    optionalDependencies?: Record<string, string>
  }
  const missing = Object.keys(main.optionalDependencies ?? {}).filter((name) => {
    try {
      // Silence npm's own stderr: "not published yet" is the expected answer half the time,
      // and a raw E404 dump in the middle of a clean rehearsal reads as a crash. The
      // verdict is the message printed below, not npm's.
      execFileSync('npm', ['view', `${name}@${APP_VERSION}`, 'version'], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      return false
    } catch {
      return true
    }
  })
  if (missing.length === 0) return
  const note =
    `${missing.join(', ')} @${APP_VERSION} is not on the registry yet.\n` +
    '  Publish every platform package first (Linux comes from the publish-linux-npm workflow),\n' +
    '  then re-run without --platform-only to publish the shim last.'
  if (publish) fail(note)
  console.log(`\n\x1b[33m  경고: ${note}\x1b[0m`)
}

// ── 6. pack (그리고 원하면 publish) ────────────────────────────────────
// 아키텍처 패키지가 **먼저** 발행돼야 한다. 반대로 하면 메인 패키지를 깐 사람이
// 없는 optional dependency를 바라보는 순간이 생긴다.
for (const pkgDir of platformOnly ? [ARCH_PKG] : [ARCH_PKG, MAIN_PKG]) {
  const name = (JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { name: string }).name
  if (pkgDir === MAIN_PKG) assertPinnedPlatformsPublished()
  if (publish) {
    step(`발행: ${name}`)
    sh('npm', ['publish', '--access', 'public', '--tag', tag, ...(otp ? ['--otp', otp] : [])], pkgDir)
    if (alsoLatest && tag !== 'latest') {
      // 태그를 옮기는 것은 발행과 달리 **되돌릴 수 있다** (dist-tag는 언제든 다시 가리킨다)
      sh('npm', ['dist-tag', 'add', `${name}@${APP_VERSION}`, 'latest', ...(otp ? ['--otp', otp] : [])], pkgDir)
    }
  } else {
    step(`리허설(pack): ${name}`)
    sh('npm', ['pack', '--dry-run'], pkgDir)
  }
}

if (platformOnly) {
  console.log(
    publish
      ? `\n\x1b[32m${target.id} 발행 완료 — the centralu shim still has to go out separately\x1b[0m`
      : `\n리허설이 끝났다 (${target.id}만). 실제로 올리려면: \x1b[1mpnpm release:npm --publish --platform-only\x1b[0m`,
  )
} else {
  console.log(
    publish
      ? `\n\x1b[32m발행 완료 — npm i -g ${tag === 'latest' ? 'centralu' : `centralu@${tag}`}\x1b[0m`
      : `\n리허설이 끝났다. 실제로 올리려면: \x1b[1mpnpm release:npm --publish\x1b[0m`,
  )
}
