import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CodexClient } from './client.js'
import { codexLaunch } from './native.js'

/**
 * Starting Codex's platform binary instead of npm's `node` wrapper (#568). The wrapper is a second process per
 * app-server that only forwards signals: about 43 MB of an idle app-server's 160 MB (#561, codex-cli 0.160).
 */

const NPM_ROOT = '/opt/homebrew/lib/node_modules/@openai/codex'
const NESTED = `${NPM_ROOT}/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`

/** A file system holding `files`, with `links` resolved by realpath */
function fakeDeps(over: { files?: Record<string, string>; links?: Record<string, string>; platform?: NodeJS.Platform; arch?: string; native?: boolean; node?: string; launch?: (p: string) => { command: string; args: string[] } } = {}) {
  const files = over.files ?? {}
  const links = over.links ?? {}
  return {
    platform: over.platform ?? 'darwin',
    arch: over.arch ?? 'arm64',
    exists: (p: string) => p in files,
    read: (p: string) => {
      if (!(p in files)) throw new Error(`ENOENT ${p}`)
      return files[p]!
    },
    realpath: (p: string) => {
      if (p in links) return links[p]!
      if (p in files) return p
      throw new Error(`ENOENT ${p}`)
    },
    launch: over.launch ?? ((p: string) => ({ command: p, args: [] })),
    node: over.node ?? '/usr/local/bin/node',
    native: over.native ?? true,
  }
}

const npmInstall = {
  files: {
    [`${NPM_ROOT}/package.json`]: JSON.stringify({ name: '@openai/codex', version: '0.160.0' }),
    [`${NPM_ROOT}/bin/codex.js`]: '#!/usr/bin/env node',
    [NESTED]: 'binary',
  },
  links: { '/opt/homebrew/bin/codex': `${NPM_ROOT}/bin/codex.js` },
}

describe('which program a Codex app-server starts from', () => {
  it('npm on macOS: the platform package nested in the package, not the wrapper the symlink points at', () => {
    const l = codexLaunch('/opt/homebrew/bin/codex', fakeDeps(npmInstall))
    expect(l).toMatchObject({ command: NESTED, args: [] })
  })

  it('sets what the wrapper sets, and drops another manager’s mark inherited from the host', () => {
    const env = codexLaunch('/opt/homebrew/bin/codex', fakeDeps(npmInstall)).env({ PATH: '/bin', CODEX_MANAGED_BY_BUN: '1' })
    expect(env).toEqual({ PATH: '/bin', CODEX_MANAGED_BY_NPM: '1', CODEX_MANAGED_PACKAGE_ROOT: NPM_ROOT })
  })

  it('pnpm: the platform package beside the package, and pnpm named as its manager', () => {
    const store = '/Users/a/Library/pnpm/global/5/node_modules/.pnpm/@openai+codex@0.160.0/node_modules'
    const root = `${store}/@openai/codex`
    const binary = `${store}/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`
    const deps = fakeDeps({
      files: {
        [`${root}/package.json`]: JSON.stringify({ name: '@openai/codex' }),
        [`${root}/bin/codex.js`]: '',
        [binary]: '',
        '/Users/a/Library/pnpm/global/5/node_modules/.modules.yaml': '',
      },
      links: { '/Users/a/Library/pnpm/codex': `${root}/bin/codex.js` },
    })
    const l = codexLaunch('/Users/a/Library/pnpm/codex', deps)
    expect(l.command).toBe(binary)
    expect(l.env({})).toMatchObject({ CODEX_MANAGED_BY_PNPM: '1', CODEX_MANAGED_PACKAGE_ROOT: root })
  })

  it('Windows: the script npm’s .cmd shim names leads to codex.exe', () => {
    const root = 'C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex'
    const exe = `${root}\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`
    const deps = fakeDeps({
      platform: 'win32',
      arch: 'x64',
      node: 'C:\\node\\node.exe',
      files: { [`${root}\\package.json`]: JSON.stringify({ name: '@openai/codex' }), [`${root}\\bin\\codex.js`]: '', [exe]: '' },
      launch: () => ({ command: 'C:\\node\\node.exe', args: [`${root}\\bin\\codex.js`] }),
    })
    expect(codexLaunch('C:\\Users\\a\\AppData\\Roaming\\npm\\codex.cmd', deps)).toMatchObject({ command: exe, args: [] })
    expect(win32.isAbsolute(exe)).toBe(true)
  })

  it('falls back to the wrapper when the platform package is missing', () => {
    const files: Record<string, string> = { ...npmInstall.files }
    delete files[NESTED]
    const l = codexLaunch('/opt/homebrew/bin/codex', fakeDeps({ ...npmInstall, files }))
    expect(l).toMatchObject({ command: '/opt/homebrew/bin/codex', args: [] })
    expect(l.env({ PATH: '/bin' })).toEqual({ PATH: '/bin' })
  })

  it('starts anything that is not npm’s package as found: a binary on PATH, a folder with another package', () => {
    const cask = codexLaunch('/opt/homebrew/bin/codex', fakeDeps({ files: { '/opt/homebrew/Caskroom/codex/0.160.0/codex': '' }, links: { '/opt/homebrew/bin/codex': '/opt/homebrew/Caskroom/codex/0.160.0/codex' } }))
    expect(cask.command).toBe('/opt/homebrew/bin/codex')
    const impostor = codexLaunch('/x/bin/codex', fakeDeps({ files: { '/x/lib/bin/codex.js': '', '/x/lib/package.json': JSON.stringify({ name: 'not-codex' }), '/x/lib/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex': '' }, links: { '/x/bin/codex': '/x/lib/bin/codex.js' } }))
    expect(impostor.command).toBe('/x/bin/codex')
    expect(codexLaunch('codex', fakeDeps()).command).toBe('codex')
  })

  it('CC_CODEX_NATIVE=0 starts the wrapper as before', () => {
    expect(codexLaunch('/opt/homebrew/bin/codex', fakeDeps({ ...npmInstall, native: false })).command).toBe('/opt/homebrew/bin/codex')
  })

  it('a platform the wrapper does not know keeps the wrapper', () => {
    expect(codexLaunch('/opt/homebrew/bin/codex', fakeDeps({ ...npmInstall, arch: 'ia32' })).command).toBe('/opt/homebrew/bin/codex')
    expect(posix.basename(NESTED)).toBe('codex')
  })
})

/*
 * The real thing, off Windows: an npm layout on disk whose wrapper and binary each leave a mark, started the way every
 * Codex client starts (`CodexClient`, which the session, usage, models, history, fork and delete all use).
 */
const TRIPLE: Record<string, string> = { 'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin', 'linux-x64': 'x86_64-unknown-linux-musl', 'linux-arm64': 'aarch64-unknown-linux-musl' }
const triple = TRIPLE[`${process.platform}-${process.arch}`]

describe.skipIf(!triple)('a Codex client on an npm install', () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('runs the platform binary, never the node wrapper, with the wrapper’s variables', async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'codex-native-')))
    const root = join(dir, 'lib', 'node_modules', '@openai', 'codex')
    const bin = join(root, 'node_modules', '@openai', `codex-${process.platform}-${process.arch}`, 'vendor', triple!, 'bin')
    mkdirSync(join(root, 'bin'), { recursive: true })
    mkdirSync(bin, { recursive: true })
    mkdirSync(join(dir, 'bin'))
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.160.0' }))
    const wrapper = join(root, 'bin', 'codex.js')
    writeFileSync(wrapper, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(join(dir, 'ran-wrapper'))}, '1')\nprocess.stdin.resume()\n`)
    chmodSync(wrapper, 0o755)
    // Leaves its arguments and the wrapper's variables, then runs until its stdin ends, as codex does
    writeFileSync(join(bin, 'codex'), `#!/bin/sh\necho "$* $CODEX_MANAGED_BY_NPM $CODEX_MANAGED_PACKAGE_ROOT" > ${JSON.stringify(join(dir, 'ran-native'))}\ncat > /dev/null\n`)
    chmodSync(join(bin, 'codex'), 0o755)
    symlinkSync(wrapper, join(dir, 'bin', 'codex'))

    const client = new CodexClient({ onNotification: () => {}, onServerRequest: () => {}, onExit: () => {} }, { command: join(dir, 'bin', 'codex'), cwd: dir })
    const mark = join(dir, 'ran-native')
    for (let i = 0; i < 200 && !existsSync(mark); i++) await new Promise((r) => setTimeout(r, 20))
    await client.dispose()
    expect(readFileSync(mark, 'utf8').trim()).toBe(`app-server 1 ${root}`)
    expect(existsSync(join(dir, 'ran-wrapper'))).toBe(false)
  })
})
