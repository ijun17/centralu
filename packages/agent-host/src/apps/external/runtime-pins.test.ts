import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * 런타임 빌드 스크립트의 판 검사 (M4 C-1, `scripts/build-app-runtime.mjs --check`) — **묶이는 그것**을 보는가.
 *
 * 검사가 판을 읽는 자리와 esbuild가 코드를 가져오는 자리가 다르면, 검사는 설치의 우연을 판정한다. pnpm은 들인 것을
 * 패키지 옆에 링크하고, 그와 별도로 `node_modules/.pnpm/node_modules`에 숨겨 끌어올린다. pnpm이 띄운 vitest는 그
 * 폴더를 NODE_PATH에 싣고, 검사를 부르는 자식이 그것을 물려받는다. 다른 워크스페이스 패키지가 core 2.0.0을 들이자
 * 검사가 그것을 읽고 app-template.test.ts가 멈췄다 — 묶이는 것은 server 옆의 2.1.0인데(m4-docs, 2026-09-25).
 */

const SCRIPT = fileURLToPath(new URL('../../../scripts/build-app-runtime.mjs', import.meta.url))
/** 진짜 esbuild — 가짜 설치 안의 스크립트 사본도 이것을 import한다 */
const ESBUILD = realpathSync(fileURLToPath(new URL('../../../node_modules/esbuild', import.meta.url)))

let root = ''
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-runtime-pins-')))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('판 검사는 들이는 쪽의 자리에서 읽는다', () => {
  it('NODE_PATH에 끌어올린 다른 판이 있어도 흔들리지 않는다 — 진짜 설치, 진짜 빌드', () => {
    const hoisted = join(root, 'hoisted')
    const others = { '@modelcontextprotocol/core': '2.0.0', '@modelcontextprotocol/server': '2.0.0', '@modelcontextprotocol/client': '2.0.0', '@modelcontextprotocol/ext-apps': '1.0.0', zod: '3.25.0', esbuild: '0.19.0' }
    for (const [name, version] of Object.entries(others)) {
      mkdirSync(join(hoisted, name), { recursive: true })
      writeFileSync(join(hoisted, name, 'package.json'), JSON.stringify({ name, version, license: 'MIT' }))
    }
    const out = execFileSync(process.execPath, [SCRIPT, '--check'], {
      encoding: 'utf8',
      env: { ...process.env, NODE_PATH: [hoisted, process.env.NODE_PATH].filter(Boolean).join(delimiter) },
    })
    expect(out).toContain('up to date')
  })

  /*
   * 아래는 pnpm 모양의 가짜 설치에 스크립트 사본을 세운다 — 스크립트는 제 자리에서 agent-host를 찾는다. 판이 틀린 곳이
   * 있으므로 검사에서 멈추고, 빌드까지 가지 않는다(가짜 설치에는 런타임의 소스가 없다).
   */
  const PINNED = { core: '@modelcontextprotocol/core', server: '@modelcontextprotocol/server', client: '@modelcontextprotocol/client', ext: '@modelcontextprotocol/ext-apps' }

  /** 패키지 하나: `.pnpm/<이름>@<판>/node_modules/<이름>` */
  function pkg(name: string, version: string, deps: Record<string, string> = {}, peers: Record<string, string> = {}): string {
    const dir = join(root, 'node_modules', '.pnpm', `${name.replace('/', '+')}@${version}`, 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, license: 'MIT', dependencies: deps, peerDependencies: peers }))
    return dir
  }
  /** `into`(node_modules 폴더)에 `target`을 `name`으로 링크한다 */
  function link(into: string, name: string, target: string): void {
    mkdirSync(dirname(join(into, name)), { recursive: true })
    symlinkSync(target, join(into, name))
  }
  /** 그 패키지를 담은 node_modules — pnpm이 들인 것을 링크하는 자리 */
  const beside = (dir: string) => dir.slice(0, dir.lastIndexOf(`${sep}node_modules${sep}`) + `${sep}node_modules`.length)

  /** 지금 설치와 같은 모양 — `coreBesideServer`만 바꿔 끼운다. 스크립트 사본의 경로를 돌려준다 */
  function install(coreBesideServer: string | null, coreHoisted?: string): string {
    const zod = pkg('zod', '4.4.3')
    const core = pkg(PINNED.core, '2.1.0', { zod: '^4.2.0' })
    const server = pkg(PINNED.server, '2.1.0', { zod: '^4.2.0', [PINNED.core]: '2.1.0' })
    const client = pkg(PINNED.client, '2.1.0', { zod: '^4.2.0', [PINNED.core]: '2.1.0' })
    const ext = pkg(PINNED.ext, '2.0.0', {}, { [PINNED.client]: '^2.0.0', [PINNED.core]: '^2.0.0', [PINNED.server]: '^2.0.0', zod: '^4.2.0' })
    for (const d of [core, server, client, ext]) link(beside(d), 'zod', zod)
    link(beside(client), PINNED.core, core)
    link(beside(ext), PINNED.core, core)
    link(beside(ext), PINNED.client, client)
    link(beside(ext), PINNED.server, server)
    if (coreBesideServer) {
      const other = coreBesideServer === '2.1.0' ? core : pkg(PINNED.core, coreBesideServer, { zod: '^4.2.0' })
      if (other !== core) link(beside(other), 'zod', zod)
      link(beside(server), PINNED.core, other)
    }
    // pnpm이 숨겨 끌어올린 자리 — 가짜 설치 안의 모든 패키지의 조상 폴더다
    if (coreHoisted) link(join(root, 'node_modules', '.pnpm', 'node_modules'), PINNED.core, pkg(PINNED.core, coreHoisted, { zod: '^4.2.0' }))

    const host = join(root, 'packages', 'agent-host')
    mkdirSync(join(host, 'scripts'), { recursive: true })
    copyFileSync(SCRIPT, join(host, 'scripts', 'build-app-runtime.mjs'))
    writeFileSync(
      join(host, 'package.json'),
      JSON.stringify({ name: '@cc/agent-host', dependencies: { [PINNED.server]: '^2.1.0', [PINNED.client]: '^2.1.0', zod: '^4.4.3' }, devDependencies: { [PINNED.ext]: '2.0.0', esbuild: '^0.28.2' } }),
    )
    for (const [name, dir] of [[PINNED.server, server], [PINNED.client, client], [PINNED.ext, ext], ['zod', zod], ['esbuild', ESBUILD]] as const) {
      link(join(host, 'node_modules'), name, dir)
    }
    return join(host, 'scripts', 'build-app-runtime.mjs')
  }

  const check = (script: string) => spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' })
  const HEAD = '[app-runtime] installed versions differ from PINS — update PINS on purpose, not by accident:'

  it('들이는 쪽 한 곳의 판이 틀려도 잡는다 — 다른 쪽(ext-apps 옆)의 판이 맞아도', () => {
    const r = check(install('2.0.0'))
    expect(r.status).toBe(1)
    expect(r.stderr.trim()).toBe(`${HEAD}\n  @modelcontextprotocol/core: installed 2.0.0 beside @modelcontextprotocol/server, pinned 2.1.0`)
  })

  it('들인다고 적었는데 옆에 없고 끌어올린 자리에만 있으면 멈춘다 — 판이 맞아도, 그 자리는 설치의 우연이다', () => {
    const r = check(install(null, '2.1.0'))
    expect(r.status).toBe(1)
    expect(r.stderr.trim()).toBe(`${HEAD}\n  @modelcontextprotocol/core: @modelcontextprotocol/server depends on it, but it is not installed beside @modelcontextprotocol/server`)
  })
})
