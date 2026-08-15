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
 *   node_modules/better-sqlite3  — 네이티브 애드온 (필요한 파일만)
 */
import { build } from 'esbuild'
import { cpSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const OUT = join(ROOT, 'apps/desktop/src-tauri/resources/host')

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

// 1) JS 번들 — 네이티브 애드온은 묶을 수 없으므로 external
await build({
  entryPoints: [join(ROOT, 'packages/agent-host/src/main.ts')],
  outfile: join(OUT, 'main.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: ['better-sqlite3'],
  // 워크스페이스 별칭을 소스로 해석 (빌드 산출물 없이 바로 번들)
  alias: {
    '@cc/protocol': join(ROOT, 'packages/protocol/src/index.ts'),
  },
  banner: {
    // ESM 번들에서 CJS 의존(better-sqlite3)을 require로 불러올 수 있게 한다
    js: "import { createRequire as __cr } from 'node:module';const require = __cr(import.meta.url);",
  },
  logLevel: 'warning',
})

// 2) 스키마 동봉 — store.ts가 산출물 옆에서 먼저 찾는다
cpSync(join(ROOT, 'packages/protocol/src/schema/schema.sql'), join(OUT, 'schema.sql'))

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
console.log(`[bundle] main.mjs ${(size / 1024).toFixed(0)}KB + better-sqlite3(${prebuild}) → ${OUT}`)
