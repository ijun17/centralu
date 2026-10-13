import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_VERSION } from '@cc/protocol'

/**
 * `centralu install` and an installed copy it must not replace (#645): a maintainer's local build
 * newer than the package is kept unless `--force` is given.
 *
 * **Never the real /Applications or %LOCALAPPDATA%.** The copy lives in a temporary folder:
 * `CENTRALU_INSTALLED_COPY` on macOS, `LOCALAPPDATA` on Windows. And nothing is ever copied: the
 * platform package is not installed in this checkout, so past the keep check `install` stops at
 * "Could not find the app package" — which is what shows `--force` got past it.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI = join(ROOT, 'packaging/npm/centralu/bin/centralu.mjs')
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A copy carrying `version`, where this platform's launcher looks for it, and the env that points it there */
function copyAt(version: string): { env: NodeJS.ProcessEnv; versionFile: string } {
  const root = mkdtempSync(join(tmpdir(), 'cc-launcher-install-'))
  dirs.push(root)
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: root, USERPROFILE: root, SystemRoot: process.env.SystemRoot }
  if (process.platform === 'win32') {
    const dir = join(root, 'Local', 'Programs', 'Centralu')
    mkdirSync(dir, { recursive: true })
    const versionFile = join(dir, 'centralu-version.txt')
    writeFileSync(versionFile, `${version}\n`)
    return { env: { ...env, LOCALAPPDATA: join(root, 'Local'), APPDATA: join(root, 'Roaming') }, versionFile }
  }
  const bundle = join(root, 'Centralu.app')
  mkdirSync(join(bundle, 'Contents'), { recursive: true })
  const versionFile = join(bundle, 'Contents', 'Info.plist')
  writeFileSync(versionFile, [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0">',
    '<dict>',
    '\t<key>CFBundleShortVersionString</key>',
    `\t<string>${version}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n'))
  return { env: { ...env, CENTRALU_INSTALLED_COPY: bundle }, versionFile }
}

function install(env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync(process.execPath, [CLI, 'install', ...args], { encoding: 'utf8', env, timeout: 30_000 })
}

// Linux has no copy to keep: its install writes a menu entry pointing into the package
describe.runIf(process.platform === 'darwin' || process.platform === 'win32')('centralu install over a newer local build (#645)', () => {
  const local = `${APP_VERSION}.local.1`

  it('keeps it without --force, and touches nothing', () => {
    const { env, versionFile } = copyAt(local)
    const before = readFileSync(versionFile, 'utf8')
    const r = install(env)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain(`holds the local build ${local}`)
    expect(r.stdout).toContain('centralu install --force')
    expect(readFileSync(versionFile, 'utf8')).toBe(before)
  })

  it('goes past the keep check with --force', () => {
    const { env } = copyAt(local)
    const r = install(env, '--force')
    expect(r.stdout).not.toContain('left as it is')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('Could not find the app package')
  })

  it.each(['9999.0.0', 'garbage'])('does not keep a copy at %s (a release, even a higher one, or malformed)', (version) => {
    const { env } = copyAt(version)
    const r = install(env)
    expect(r.stdout).not.toContain('left as it is')
    expect(r.stderr).toContain('Could not find the app package')
  })
})
