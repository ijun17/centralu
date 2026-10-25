/**
 * The version of a build, since git holds none (#1501): `scripts/app-version.mjs` resolves it (`CENTRALU_VERSION`, else
 * the newest release tag reachable from HEAD, else a refusal or, for development only, the placeholder), and
 * `scripts/stamp-version.mjs` writes it into the carriers and puts the placeholder back. Run against temporary git
 * repositories and copies of this repository's carriers, so nothing here touches the checkout.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error — plain JavaScript, read by bundle.mjs and the signing workflow under plain node
import { checkAppVersion, PLACEHOLDER, releaseTag, resolveAppVersion } from '../scripts/app-version.mjs'
// @ts-expect-error — as above
import { stampedFiles, stampVersion, versionOnlyDirt } from '../scripts/stamp-version.mjs'

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
    for (const ok of ['0.1.0-beta.37', '1.0.0', '0.2.0-beta.20.local.3', '1.0.0-rc.1']) expect(checkAppVersion(ok), ok).toBe(ok)
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
})
