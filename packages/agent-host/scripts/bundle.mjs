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
const ptyPlatform = `${process.platform}-${process.arch}`
const ptyPrebuildSrc = join(ptySrc, 'prebuilds', ptyPlatform)
if (!existsSync(ptyPrebuildSrc)) {
  throw new Error(`이 플랫폼용 node-pty prebuild가 없습니다: ${ptyPlatform}`)
}
cpSync(ptyPrebuildSrc, join(ptyDest, 'prebuilds', ptyPlatform), { recursive: true })

/**
 * spawn-helper는 **실행 파일**이다. 압축을 풀거나 복사하는 과정에서 +x가 날아가면
 * 셸이 뜨지 않고 `posix_spawnp failed`만 남는다 (실제로 겪었고, 원인을 찾는 데 시간을 썼다).
 * 복사한 뒤 반드시 실행 권한을 다시 준다.
 */
const helper = join(ptyDest, 'prebuilds', ptyPlatform, 'spawn-helper')
if (existsSync(helper)) {
  chmodSync(helper, 0o755)
  // 빌드 시점에 확인한다 — 실행 권한이 없으면 배포 앱에서 터미널이 통째로 죽는다.
  // 이건 테스트로 잡기 어렵고(번들이 있어야 한다) 증상은 원인을 가리키지 않는다.
  const mode = statSync(helper).mode
  if (!(mode & 0o111)) {
    throw new Error(`spawn-helper에 실행 권한이 없습니다: ${helper} — 터미널이 뜨지 않습니다`)
  }
}

// 4) 산출물이 자기 완결적인지 표시 — host_command가 이 파일 존재로 prod를 판단한다
writeFileSync(
  join(OUT, 'bundle-info.json'),
  JSON.stringify(
    { builtAt: new Date().toISOString(), runtime: 'system-node', platform: process.platform, arch: process.arch },
    null,
    2,
  ) + '\n',
)

const size = readFileSync(join(OUT, 'main.mjs')).length
console.log(
  `[bundle] main.mjs ${(size / 1024).toFixed(0)}KB + better-sqlite3(${prebuild}) + node-pty(${ptyPlatform}) → ${OUT}`,
)
