/**
 * The version of a build, since git holds none (#1501): `scripts/app-version.mjs` resolves it (`CENTRALU_VERSION`, else
 * the newest release tag reachable from HEAD, else a refusal or, for development only, the placeholder), and
 * `scripts/stamp-version.mjs` writes it into the carriers and puts the placeholder back. Run against temporary git
 * repositories and copies of this repository's carriers, so nothing here touches the checkout.
 */
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { constants as osConstants, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { SLOW } from './test-timing.js'
// @ts-expect-error — plain JavaScript, read by bundle.mjs and the signing workflow under plain node
import { checkAppVersion, PLACEHOLDER, releaseTag, resolveAppVersion } from '../scripts/app-version.mjs'
// @ts-expect-error — as above
import { holdStamp, runSteps, stampedFiles, stampVersion, versionOnlyDirt } from '../scripts/stamp-version.mjs'
// @ts-expect-error — as above
import { verifyThenStamp, withoutVersion } from '../scripts/release-verify.mjs'
// @ts-expect-error — as above
import { buildId } from '../packages/agent-host/scripts/build-id.mjs'

const dirs: string[] = []
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-stamp-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** A git repository holding a copy of this repository's carriers, committed as they are (the placeholder) */
function carriers(): string {
  const root = temp()
  for (const path of stampedFiles() as string[]) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    cpSync(resolve(path), join(root, path))
  }
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'carriers')
  return root
}
const read = (root: string, path: string) => readFileSync(join(root, path), 'utf8')
const json = (root: string, path: string) => JSON.parse(read(root, path)) as { version: string; optionalDependencies?: Record<string, string> }

describe('which version a build carries (app-version.mjs)', () => {
  it('takes CENTRALU_VERSION, else the newest release tag reachable from HEAD, else refuses or, asked, the placeholder', () => {
    const root = carriers()
    // No tag: a packaging build refuses, a development entry point gets the placeholder
    expect(() => resolveAppVersion({ env: {}, cwd: root })).toThrow(/no version to build: CENTRALU_VERSION is not set and no release tag/)
    expect(resolveAppVersion({ env: {}, cwd: root, fallback: true })).toBe(PLACEHOLDER)
    git(root, 'tag', '-a', 'v0.2.0-beta.3', '-m', 'v0.2.0-beta.3')
    git(root, 'tag', 'nightly')
    expect(releaseTag(root)).toBe('0.2.0-beta.3')
    // A later commit is still cut from the release before it; a tag on another branch is not reachable
    git(root, 'commit', '-q', '--allow-empty', '-m', 'after')
    git(root, 'checkout', '-q', '-b', 'side')
    git(root, 'commit', '-q', '--allow-empty', '-m', 'side')
    git(root, 'tag', '-a', 'v0.2.0-beta.9', '-m', 'v0.2.0-beta.9')
    git(root, 'checkout', '-q', 'main')
    expect(resolveAppVersion({ env: {}, cwd: root })).toBe('0.2.0-beta.3')
    expect(resolveAppVersion({ env: { CENTRALU_VERSION: '0.2.0-beta.4' }, cwd: root })).toBe('0.2.0-beta.4')
    expect(resolveAppVersion({ env: { CENTRALU_VERSION: '' }, cwd: root })).toBe('0.2.0-beta.3')
    for (const bad of ['v0.2.0', '0.2.0+meta', '0.2', '01.2.3', '0.2.0-beta.01', 'latest']) {
      expect(() => resolveAppVersion({ env: { CENTRALU_VERSION: bad }, cwd: root }), bad).toThrow(/CENTRALU_VERSION is not a version/)
    }
  })

  it('checks a version as SemVer without build metadata, which the content check in Rust refuses', () => {
    for (const ok of ['0.2.0-beta.4', '1.0.0', '0.2.0-beta.20.local.3', '1.0.0-rc.1']) expect(checkAppVersion(ok), ok).toBe(ok)
    for (const bad of ['1.0.0+x', '1.0', ' 1.0.0', '1.0.0-', '1.0.0-beta..1', '9007199254740992.0.0', 1]) expect(() => checkAppVersion(bad), String(bad)).toThrow()
  })
})

describe('stamping the carriers (stamp-version.mjs)', () => {
  it('writes the version into every carrier and the shim pins, and puts back exactly what git holds', () => {
    const root = carriers()
    const before = Object.fromEntries((stampedFiles(root) as string[]).map((p) => [p, read(root, p)]))
    expect(Object.keys(before)).toEqual(expect.arrayContaining(['packages/protocol/src/version.generated.ts', 'apps/desktop/src-tauri/tauri.conf.json', 'packaging/npm/centralu/package.json', 'packaging/npm/host-win32-x64/package.json']))
    const changed = stampVersion(root, '0.2.0-beta.4') as string[]
    expect(changed.sort()).toEqual(Object.keys(before).sort())
    expect(read(root, 'packages/protocol/src/version.generated.ts')).toContain("export const APP_VERSION: string = '0.2.0-beta.4'")
    for (const path of Object.keys(before).filter((p) => p.endsWith('.json'))) expect(json(root, path).version, path).toBe('0.2.0-beta.4')
    // The shim pins each platform package exactly: the shell and its contents must be the same version
    expect(Object.values(json(root, 'packaging/npm/centralu/package.json').optionalDependencies ?? {})).toEqual(['0.2.0-beta.4', '0.2.0-beta.4', '0.2.0-beta.4', '0.2.0-beta.4'])
    // Only the version fields: everything else of each file is as committed
    for (const [path, text] of Object.entries(before)) expect(read(root, path).split('0.2.0-beta.4').join(PLACEHOLDER), path).toBe(text)
    // Stamping again over a stamped tree, then putting the placeholder back
    stampVersion(root, '0.2.0-beta.5')
    expect(json(root, 'apps/desktop/src-tauri/tauri.conf.json').version).toBe('0.2.0-beta.5')
    stampVersion(root, PLACEHOLDER)
    for (const [path, text] of Object.entries(before)) expect(read(root, path), path).toBe(text)
    expect(git(root, 'status', '--porcelain')).toBe('')
  })

  it('refuses a version that is not one, and a carrier without its version field, writing nothing', () => {
    const root = carriers()
    for (const bad of ['0.2.0+meta', 'v0.2.0', '0.2', '']) expect(() => stampVersion(root, bad), bad).toThrow(/not a version/)
    expect(git(root, 'status', '--porcelain')).toBe('')
    writeFileSync(join(root, 'packages/protocol/src/version.generated.ts'), "export const APP_VERSION = '0.0.0-dev'\n")
    git(root, 'commit', '-q', '-am', 'a carrier the stamper cannot read')
    expect(() => stampVersion(root, '0.2.0-beta.4')).toThrow(/version\.generated\.ts: no `export const APP_VERSION: string = '…'` line to stamp/)
    // Every file read and stamped before the first is written
    expect(git(root, 'status', '--porcelain')).toBe('')
  })

  it('runs the stamped steps with the version and the rest with the placeholder back, also when a step fails', async () => {
    const root = carriers()
    const seen = (name: string) => [process.execPath, ['-e', `require('fs').copyFileSync('packages/protocol/src/version.generated.ts', '${name}')`]]
    const count = () => ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP'].map((e) => process.listenerCount(e))
    const before = count()
    await runSteps(root, '0.2.0-beta.4', [seen('a'), seen('b')], { stamped: 1 })
    // #1501 re-check: every listener a run adds goes again, also after a failed step (below)
    expect(count()).toEqual(before)
    expect(read(root, 'a')).toContain("'0.2.0-beta.4'")
    expect(read(root, 'b')).toContain(`'${PLACEHOLDER}'`)
    await expect(runSteps(root, '0.2.0-beta.4', [[process.execPath, ['-e', 'process.exit(3)']], seen('c')], { stamped: 2 })).rejects.toThrow(/exited with 3/)
    expect(existsSync(join(root, 'c'))).toBe(false)
    expect(count()).toEqual(before)
    expect(git(root, 'status', '--porcelain').split('\n').sort()).toEqual(['?? a', '?? b'])
  })

  // #1501 review: Node's exit event skips a signal, and a blocking child held it off. POSIX signals: CI's Linux and macOS
  it.skipIf(process.platform === 'win32').each(['SIGINT', 'SIGTERM', 'SIGHUP'])(
    'on %s to the runner alone, stops the running step, puts the placeholder back and runs nothing after',
    async (signal) => {
      const root = carriers()
      const step = `require('fs').writeFileSync('started', String(process.pid)); setTimeout(() => {}, 60000)`
      const runner = `import { runSteps } from ${JSON.stringify(pathToFileURL(resolve('scripts/stamp-version.mjs')).href)}
await runSteps(process.cwd(), '0.2.0-beta.4', [[process.execPath, ['-e', ${JSON.stringify(step)}]], [process.execPath, ['-e', "require('fs').writeFileSync('after', '')"]]])`
      const child = spawn(process.execPath, ['--input-type=module', '-e', runner], { cwd: root, stdio: 'ignore' })
      const exited = new Promise<number | null>((done) => child.on('exit', (code) => done(code)))
      const deadline = Date.now() + 20_000
      while (!existsSync(join(root, 'started')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
      expect(read(root, 'packages/protocol/src/version.generated.ts')).toContain("'0.2.0-beta.4'")
      const stepPid = Number(read(root, 'started'))
      child.kill(signal as NodeJS.Signals)
      expect(await exited).toBe(128 + osConstants.signals[signal as NodeJS.Signals])
      expect(git(root, 'status', '--porcelain')).toBe('?? started')
      expect(existsSync(join(root, 'after'))).toBe(false)
      const gone = Date.now() + 10_000
      const alive = () => { try { process.kill(stepPid, 0); return true } catch { return false } }
      while (alive() && Date.now() < gone) await new Promise((r) => setTimeout(r, 50))
      expect(alive()).toBe(false)
    },
    30_000 * SLOW,
  )

  it('release-npm holds its stamp through holdStamp, after the clean-tree check and after verify, so a signal restores too', () => {
    const release = readFileSync(resolve('scripts/release-npm.mts'), 'utf8')
    const at = (s: string) => release.indexOf(s)
    expect(at('(holdStamp as')).toBeGreaterThan(at("fail('the working tree is not clean"))
    // Verify is inside verifyThenStamp, which stamps after it; nothing stamps before that call
    expect(at('verifyThenStamp({')).toBeGreaterThan(at("fail('the working tree is not clean"))
    expect(at('(holdStamp as')).toBeGreaterThan(at('verifyThenStamp({'))
    expect(release).not.toMatch(/sh\('pnpm', \[script\]\)/)
    // No restore of its own on the exit event alone, which a signal skips (#1501 review)
    expect(release).not.toMatch(/process\.on\('exit'/)
    expect(release).not.toMatch(/\bstampVersion\b/)
  })

  // beta.38 rehearsal: verify ran on a stamped tree and 17 guard tests failed on every Linux job
  it('verifies at the placeholder with no CENTRALU_VERSION, then stamps (release-verify.mjs)', () => {
    const root = carriers()
    const generated = 'packages/protocol/src/version.generated.ts'
    const seen: { what: string; stamped?: boolean; version?: string | undefined; other?: string | undefined }[] = []
    let restore: (() => void) | undefined
    try {
      verifyThenStamp({
        scripts: ['lint', 'verify'],
        skipVerify: false,
        cwd: root,
        env: { CENTRALU_VERSION: '0.2.0-beta.4', KEEP: 'yes', PATH: 'x' },
        exec: (cmd: string, args: string[], options: { env: NodeJS.ProcessEnv; cwd: string }) => {
          expect(cmd).toBe('pnpm')
          expect(options.cwd).toBe(root)
          // Read at the moment verify runs: a stamp held before this call would show here
          seen.push({ what: args[0] ?? '', stamped: read(root, generated).includes('0.2.0-beta.4'), version: options.env.CENTRALU_VERSION, other: options.env.KEEP })
        },
        // Held, not put back at once, so a stamp that comes first is still in the tree when verify runs
        stamp: () => {
          seen.push({ what: 'stamp' })
          restore = (holdStamp as (r: string, v: string) => () => void)(root, '0.2.0-beta.4')
        },
      })
      expect(seen).toEqual([
        { what: 'lint', stamped: false, version: undefined, other: 'yes' },
        { what: 'verify', stamped: false, version: undefined, other: 'yes' },
        { what: 'stamp' },
      ])
      expect(read(root, generated)).toContain("'0.2.0-beta.4'")
    } finally {
      restore?.()
    }
  })

  it('leaves CENTRALU_VERSION out of the verify environment whatever its case on Windows, and only there', () => {
    expect(withoutVersion({ CENTRALU_VERSION: 'a', Centralu_Version: 'b', centralu_version: 'c', KEEP: '1' }, 'win32')).toEqual({ KEEP: '1' })
    // POSIX names are case-sensitive: another case is another variable
    expect(withoutVersion({ CENTRALU_VERSION: 'a', Centralu_Version: 'b', KEEP: '1' }, 'linux')).toEqual({ Centralu_Version: 'b', KEEP: '1' })
    const seen: unknown[] = []
    verifyThenStamp({ scripts: ['verify'], skipVerify: false, platform: 'win32', env: { Centralu_Version: '1', Path: 'p' }, exec: (_c: string, _a: string[], o: { env: unknown }) => seen.push(o.env), stamp: () => {} })
    expect(seen).toEqual([{ Path: 'p' }])
  })

  it('release-npm starts no verify child of its own: only verifyThenStamp does, with the environment it strips', () => {
    const release = readFileSync(resolve('scripts/release-npm.mts'), 'utf8')
    const start = release.indexOf('verifyThenStamp({')
    const call = release.slice(start, release.indexOf('\n})', start))
    expect(call).not.toMatch(/\b(run|exec|env)\s*:/)
    expect(call).toContain('cwd: ROOT')
  })

  it('stamps after verify even when verify is skipped, and does not stamp when verify fails', () => {
    const calls: string[] = []
    verifyThenStamp({ scripts: ['verify'], skipVerify: true, exec: () => calls.push('run'), stamp: () => calls.push('stamp') })
    expect(calls).toEqual(['stamp'])
    expect(() =>
      verifyThenStamp({
        scripts: ['verify'],
        skipVerify: false,
        exec: () => {
          throw new Error('tests failed')
        },
        stamp: () => calls.push('stamp again'),
      }),
    ).toThrow('tests failed')
    expect(calls).toEqual(['stamp'])
  })

  it('does not count a stamped tree as a dirty build, but any other change, in a carrier or elsewhere', () => {
    const root = carriers()
    stampVersion(root, '0.2.0-beta.4')
    expect(git(root, 'status', '--porcelain')).not.toBe('')
    expect(versionOnlyDirt(root)).toEqual([])
    const conf = join(root, 'apps/desktop/src-tauri/tauri.conf.json')
    writeFileSync(conf, read(root, 'apps/desktop/src-tauri/tauri.conf.json').replace('"productName"', '"productName2"'))
    expect(versionOnlyDirt(root)).toEqual([' M apps/desktop/src-tauri/tauri.conf.json'])
    git(root, 'checkout', '--', 'apps/desktop/src-tauri/tauri.conf.json')
    writeFileSync(join(root, 'notes.txt'), 'x\n')
    expect(versionOnlyDirt(root)).toEqual(['?? notes.txt'])
  })

  it('names a stamped tree by its commit in the bundled host, and any other change -dirty (bundle.mjs)', () => {
    const root = carriers()
    const sha = git(root, 'rev-parse', '--short', 'HEAD')
    stampVersion(root, '0.2.0-beta.4')
    expect(buildId(root)).toBe(sha)
    writeFileSync(join(root, 'notes.txt'), 'x\n')
    expect(buildId(root)).toBe(`${sha}-dirty`)
    // bundle.mjs bakes that id into the host and its bundle record, from the repository root
    const bundle = readFileSync(resolve('packages/agent-host/scripts/bundle.mjs'), 'utf8')
    expect(bundle).toContain("import { buildId } from './build-id.mjs'")
    expect(bundle).toContain('const BUILD_ID = buildId(ROOT)')
    expect(bundle).toContain('__CC_BUILD__: JSON.stringify(BUILD_ID)')
    expect(bundle).toContain('commit: BUILD_ID,')
  })
})
