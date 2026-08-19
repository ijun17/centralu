/**
 * F-0: agent-host를 배포 가능한 형태로 묶는다.
 *
 * 방식 결정(F-0a): **시스템 Node 실행**.
 *   Node SEA는 better-sqlite3(네이티브 애드온) 때문에 `.node` 별도 동봉 + 주입 후 재서명이 필요해
 *   도그푸딩 대비 비용이 과하다. 배포 대상이 넓어지면 이 파일만 바꿔 SEA로 전환한다.
 *
 * 산출물 (apps/desktop/src-tauri/resources/host/):
 *   main.mjs                     — 번들된 host (better-sqlite3만 external)
 *   schema.sql                   — store가 산출물 옆에서 찾는다
 *   codex-orchestrator-bridge.mjs — codex가 node로 직접 띄운다 (번들 안 함)
 *   node_modules/better-sqlite3  — 네이티브 애드온 (필요한 파일만)
 */
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, rmSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const OUT = join(ROOT, 'apps/desktop/src-tauri/resources/host')

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

// 1) JS 번들 — 네이티브 애드온은 묶을 수 없으므로 external
/**
 * **어느 커밋의 빌드인지 산출물이 스스로 말하게 한다.**
 *
 * 도그푸딩에서 "지금 도는 앱이 어느 커밋이냐"에 답하려고 바이너리 mtime과 커밋 시각을
 * 맞춰 봐야 했다 — 추측이고, 다시 빌드하면 틀어진다. 기동 로그 첫 줄에 박아 둔다.
 * 깃이 없거나 실패해도 빌드는 계속된다 ('unknown'이 빌드 실패보다 낫다).
 */
function buildId() {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim()
    return dirty ? `${sha}-dirty` : sha
  } catch {
    return 'unknown'
  }
}

await build({
  entryPoints: [join(ROOT, 'packages/agent-host/src/main.ts')],
  outfile: join(OUT, 'main.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: ['better-sqlite3', 'node-pty'],
  // 워크스페이스 별칭을 소스로 해석 (빌드 산출물 없이 바로 번들)
  alias: {
    '@cc/protocol': join(ROOT, 'packages/protocol/src/index.ts'),
  },
  define: {
    __CC_BUILD__: JSON.stringify(buildId()),
  },
  banner: {
    // ESM 번들에서 CJS 의존(better-sqlite3)을 require로 불러올 수 있게 한다
    js: "import { createRequire as __cr } from 'node:module';const require = __cr(import.meta.url);",
  },
  logLevel: 'warning',
})

// 2) 스키마 동봉 — store.ts가 산출물 옆에서 먼저 찾는다
cpSync(join(ROOT, 'packages/protocol/src/schema/schema.sql'), join(OUT, 'schema.sql'))
/*
 * Codex 오케스트레이터의 stdio 다리.
 * codex가 `node <경로>`로 직접 띄우므로 번들하지 않고 **파일 그대로** 옆에 둔다.
 */
cpSync(
  join(ROOT, 'packages/agent-host/src/adapters/codex/orchestrator-bridge.mjs'),
  join(OUT, 'codex-orchestrator-bridge.mjs'),
)

// 3) 네이티브 애드온 — 이 플랫폼 prebuild만 골라 담는다 (26MB 전체 복사 회피)
const pkgJson = require.resolve('better-sqlite3/package.json')
const src = dirname(pkgJson)
const dest = join(OUT, 'node_modules/better-sqlite3')
mkdirSync(dest, { recursive: true })
for (const entry of ['package.json', 'lib']) {
  cpSync(join(src, entry), join(dest, entry), { recursive: true })
}
const prebuild = `${process.platform}-${process.arch}.node`
const prebuildSrc = join(src, 'prebuilds', prebuild)
if (!existsSync(prebuildSrc)) {
  throw new Error(`이 플랫폼용 prebuild가 없습니다: ${prebuild} — 소스 빌드가 필요합니다`)
}
mkdirSync(join(dest, 'prebuilds'), { recursive: true })
cpSync(prebuildSrc, join(dest, 'prebuilds', prebuild))

// bindings 탐색이 build/Release 경로도 보므로 함께 둔다 (로더 구현에 따라 달라지는 것 방어)
mkdirSync(join(dest, 'build/Release'), { recursive: true })
cpSync(prebuildSrc, join(dest, 'build/Release/better_sqlite3.node'))

// 3-2) 터미널용 PTY — 역시 네이티브 애드온이라 함께 담는다.
//      node-pty는 N-API 방식이라 Node 버전이 달라도 같은 prebuild가 동작한다.
const ptyPkg = require.resolve('node-pty/package.json')
const ptySrc = dirname(ptyPkg)
const ptyDest = join(OUT, 'node_modules/node-pty')
mkdirSync(ptyDest, { recursive: true })
for (const entry of ['package.json', 'lib']) {
  cpSync(join(ptySrc, entry), join(ptyDest, entry), { recursive: true })
}
/**
 * Where node-pty's native files actually are — which is not the same place on every OS.
 *
 * node-pty 1.1.0 publishes prebuilds for darwin and win32 only. On Linux its install
 * script (`node scripts/prebuild.js || node-gyp rebuild`) finds no matching prebuild,
 * falls through to a source build, and the result lands in `build/Release` instead.
 * This script used to only know about `prebuilds/`, so the Linux build died here —
 * before Tauri bundled anything, because this runs as `beforeBuildCommand` (#14).
 *
 * We check in the opposite order from node-pty's own loader (`lib/utils.js` tries
 * `build/Release` first, `prebuilds/<platform>-<arch>` second), on purpose: a prebuild
 * is what the package intends to ship, and a stale `build/Release` left over from an
 * earlier experiment should not quietly win over it. Only one of the two exists on a
 * clean checkout, so the difference only shows up on a machine that has both — which
 * is exactly the machine where guessing wrong is hardest to notice.
 *
 * A source build is safe to ship because node-pty builds against node-addon-api
 * (N-API), so the binary is ABI-stable across Node versions — the user's system Node
 * does not have to match the machine that built it. glibc still has to be old enough,
 * which is why CI pins the oldest supported runner rather than `ubuntu-latest`.
 */
const ptyPlatform = `${process.platform}-${process.arch}`
const ptyNativeDir = [join('prebuilds', ptyPlatform), join('build', 'Release')].find((rel) =>
  existsSync(join(ptySrc, rel, 'pty.node')),
)
if (!ptyNativeDir) {
  throw new Error(
    `node-pty 네이티브 모듈을 찾지 못했습니다 (${ptyPlatform}).\n` +
      `찾아본 곳: prebuilds/${ptyPlatform}/pty.node, build/Release/pty.node\n` +
      '소스 빌드가 돌지 않았을 수 있습니다 — pnpm-workspace.yaml의 allowBuilds에 node-pty가 있는지 확인하세요.',
  )
}
mkdirSync(join(ptyDest, ptyNativeDir), { recursive: true })
// 파일을 하나씩 고른다. `build/Release`는 node-gyp의 중간 산출물(obj.target 등)까지
// 안고 있어서, 통째로 복사하면 번들에 수십 MB의 오브젝트 파일이 딸려 들어간다.
for (const file of ['pty.node', 'spawn-helper']) {
  const from = join(ptySrc, ptyNativeDir, file)
  if (existsSync(from)) cpSync(from, join(ptyDest, ptyNativeDir, file))
}

/**
 * spawn-helper는 **실행 파일**이다. 압축을 풀거나 복사하는 과정에서 +x가 날아가면
 * 셸이 뜨지 않고 `posix_spawnp failed`만 남는다 (실제로 겪었고, 원인을 찾는 데 시간을 썼다).
 * 복사한 뒤 반드시 실행 권한을 다시 준다.
 *
 * This has to follow whichever directory won above: node-pty resolves the helper as
 * `<the dir the module loaded from>/spawn-helper` (lib/unixTerminal.js), so guarding
 * the prebuilds path while shipping a source build would leave the real helper
 * unchecked — and a source build is exactly where the bit is most likely to be missing.
 */
const helper = join(ptyDest, ptyNativeDir, 'spawn-helper')
if (existsSync(helper)) {
  chmodSync(helper, 0o755)
  // 빌드 시점에 확인한다 — 실행 권한이 없으면 배포 앱에서 터미널이 통째로 죽는다.
  // 이건 테스트로 잡기 어렵고(번들이 있어야 한다) 증상은 원인을 가리키지 않는다.
  const mode = statSync(helper).mode
  if (!(mode & 0o111)) {
    throw new Error(`spawn-helper에 실행 권한이 없습니다: ${helper} — 터미널이 뜨지 않습니다`)
  }
}

/*
 * 4) Mark the output as self-contained — host_command treats this file's existence as "prod".
 *
 * `commit` is here as well as in the startup log. The log answers "which commit is the
 * running app?" only while a host is running; this answers it for a bundle sitting on disk,
 * which is the case that actually came up — a `.app` had to be identified without launching
 * it, and the fallback was matching binary mtimes against commit times. That is a guess.
 */
writeFileSync(
  join(OUT, 'bundle-info.json'),
  JSON.stringify(
    {
      commit: buildId(),
      builtAt: new Date().toISOString(),
      runtime: 'system-node',
      platform: process.platform,
      arch: process.arch,
    },
    null,
    2,
  ) + '\n',
)

const size = readFileSync(join(OUT, 'main.mjs')).length
console.log(
  // node-pty prints the directory, not the platform: "prebuilds/darwin-arm64" and
  // "build/Release" are the visible difference between a shipped binary and one this
  // machine compiled, and that is worth seeing in a release log.
  `[bundle] main.mjs ${(size / 1024).toFixed(0)}KB + better-sqlite3(${prebuild}) + node-pty(${ptyNativeDir}) → ${OUT}`,
)
