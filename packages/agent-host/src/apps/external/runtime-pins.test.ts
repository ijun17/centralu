import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * The version check in the runtime build script (M4 C-1, `scripts/build-app-runtime.mjs --check`) —
 * does it look at **the version that actually gets bundled**?
 *
 * If the place the check reads the version from differs from the place esbuild actually pulls the
 * code from, the check ends up validating an accident of installation. pnpm links what it installs
 * next to the package, and separately hoists it, hidden, into
 * `node_modules/.pnpm/node_modules`. vitest, started by pnpm, carries that folder in NODE_PATH, and
 * the child process the check spawns inherits it. When another workspace package installed core
 * 2.0.0, the check read that version and app-template.test.ts broke — while what actually gets
 * bundled is the 2.1.0 next to server (m4-docs, 2026-09-25).
 */

const SCRIPT = fileURLToPath(new URL('../../../scripts/build-app-runtime.mjs', import.meta.url))
/** The real esbuild — the copy of the script inside the fake install also imports this one */
const ESBUILD = realpathSync(fileURLToPath(new URL('../../../node_modules/esbuild', import.meta.url)))

let root = ''
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-runtime-pins-')))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('the version check reads from the install side, not the hoisted side', () => {
  it('is not thrown off by a different version hoisted into NODE_PATH — a real install, a real build', () => {
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
   * What follows sets up a copy of the script inside a pnpm-shaped fake install — the script finds
   * agent-host in its own location. Since there is a version mismatch somewhere, this stops at the
   * check and never reaches the build (the fake install has no source for the runtime).
   */
  const PINNED = { core: '@modelcontextprotocol/core', server: '@modelcontextprotocol/server', client: '@modelcontextprotocol/client', ext: '@modelcontextprotocol/ext-apps' }

  /** One package: `.pnpm/<name>@<version>/node_modules/<name>` */
  function pkg(name: string, version: string, deps: Record<string, string> = {}, peers: Record<string, string> = {}): string {
    const dir = join(root, 'node_modules', '.pnpm', `${name.replace('/', '+')}@${version}`, 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, license: 'MIT', dependencies: deps, peerDependencies: peers }))
    return dir
  }
  /** Links `target` as `name` into `into` (a node_modules folder) */
  function link(into: string, name: string, target: string): void {
    mkdirSync(dirname(join(into, name)), { recursive: true })
    symlinkSync(target, join(into, name))
  }
  /** The node_modules folder that holds that package — where pnpm links what it installs */
  const beside = (dir: string) => dir.slice(0, dir.lastIndexOf(`${sep}node_modules${sep}`) + `${sep}node_modules`.length)

  /** The same shape as the real install — only `coreBesideServer` is swapped out. Returns the path to the script copy */
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
    // Where pnpm hides its hoisted packages — the ancestor folder of every package in the fake install
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

  it('catches a version mismatch at one install location — even when another location (beside ext-apps) has the right version', () => {
    const r = check(install('2.0.0'))
    expect(r.status).toBe(1)
    expect(r.stderr.trim()).toBe(`${HEAD}\n  @modelcontextprotocol/core: installed 2.0.0 beside @modelcontextprotocol/server, pinned 2.1.0`)
  })

  it('stops if a listed dependency is not next to the package and exists only in the hoisted location — even with the right version, that location is an accident of installation', () => {
    const r = check(install(null, '2.1.0'))
    expect(r.status).toBe(1)
    expect(r.stderr.trim()).toBe(`${HEAD}\n  @modelcontextprotocol/core: @modelcontextprotocol/server depends on it, but it is not installed beside @modelcontextprotocol/server`)
  })
})
