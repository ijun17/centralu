import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { APP_VERSION, type UpdateStatus } from '@cc/protocol'
import { resolveCommand } from './tool-launch.js'
import { UpdateService, commandFor, failureDetail, installedCopyPath, runCommand, type LatestResult } from './updates.js'
// @ts-expect-error — plain .mjs shipped inside the npm shim, no types on purpose
import { installedPaths } from '../../../packaging/npm/centralu/bin/platform.mjs'

/**
 * Checking for and installing app updates (issue #43).
 *
 * **None of these tests reach out to the registry or run `npm i -g`.** Both pass only through
 * injected seams, and that is the guarantee that this file cannot alter this machine.
 */
function make(
  opts: {
    registry?: string | null
    run?: (file: string, args: string[]) => Promise<void>
    autoApply?: boolean
    installedCopy?: string | null
  } = {},
) {
  const published: UpdateStatus[] = []
  const calls: [string, string[]][] = []
  const saved: boolean[] = []
  let registry = opts.registry ?? null
  let fetches = 0
  const svc = new UpdateService((s) => published.push(s), {
    fetchLatest: async (): Promise<LatestResult> => {
      fetches++
      return registry === null ? { ok: false, reason: 'Could not reach the registry' } : { ok: true, version: registry }
    },
    run: async (file, args) => {
      calls.push([file, args])
      await (opts.run?.(file, args) ?? Promise.resolve())
    },
    installedCopy: () => opts.installedCopy ?? null,
    readAutoApply: () => opts.autoApply ?? false,
    writeAutoApply: (enabled) => saved.push(enabled),
  })
  return {
    svc,
    published,
    calls,
    saved,
    get fetches() {
      return fetches
    },
    offer: (v: string | null) => {
      registry = v
    },
  }
}

/** Waits until state settles into shape — installation finishes after this returns */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0))
}

describe('UpdateService', () => {
  /**
   * What is currently running is answered by a **build constant.**
   *
   * Not the workspace root's package.json — that one is private and is a version nobody installs,
   * so being wrong there causes nothing to happen. `APP_VERSION` guards that it matches the
   * published packages, checked by `tooling/brand.test.ts`.
   */
  it('the current version is the value the build carries', () => {
    expect(make().svc.current().current).toBe(APP_VERSION)
  })

  it('reports it when the registry has something newer (does not install it)', async () => {
    const h = make({ registry: '9999.0.0' })
    const s = await h.svc.check(true)
    expect(s.latest).toBe('9999.0.0')
    expect(s.newer).toBe(true)
    // Nothing happens just from finding out
    expect(s.phase).toBe('idle')
    expect(h.calls).toEqual([])
  })

  it('compares prereleases against each other too — #42 must not resurface here', async () => {
    const h = make({ registry: '0.1.0-beta.99' })
    expect((await h.svc.check(true)).newer).toBe(true)
  })

  /**
   * Failing to reach the registry is **not the same as "up to date."**
   *
   * And it does not erase what was found last time. Erasing it would mean a single network
   * hiccup makes the check undo its own earlier finding, and the screen would look as if nothing
   * had ever happened.
   */
  it('does not throw when the registry cannot be reached, and does not erase the previously known answer', async () => {
    const h = make({ registry: '9999.0.0' })
    await h.svc.check(true)
    h.offer(null)
    const s = await h.svc.check(true)
    expect(s.latest).toBe('9999.0.0')
    expect(s.newer).toBe(true)
    expect(s.error).toMatch(/registry/i)
  })

  /**
   * When turned off, **nothing is asked anywhere.**
   *
   * The screen calls `check(false)` every time the app opens. Without a guard there, this setting
   * would only block the periodic requests while still letting the once-at-startup call through —
   * a promise only half kept.
   */
  it('an automatic call does not reach the registry when auto-check is turned off', async () => {
    const h = make({ registry: '9999.0.0' })
    await h.svc.setAuto(false)
    const before = h.fetches
    await h.svc.check(false)
    expect(h.fetches).toBe(before)
    // A person clicking it still goes through
    await h.svc.check(true)
    expect(h.fetches).toBe(before + 1)
  })

  /**
   * Installation **names the exact version.**
   *
   * Calling `centralu update` looks like one line, but the judgment of what to install is made by
   * the runner already installed on the user's machine, and that copy's own comparison can be
   * wrong (#42) — answering "already up to date" while doing nothing is exactly the symptom of
   * that defect. Passing the version that was found by name skips that judgment entirely.
   */
  it("names the exact version found and installs it (does not go through the runner's own judgment)", async () => {
    const h = make({ registry: '9999.0.0' })
    await h.svc.check(true)
    expect(h.svc.apply().phase).toBe('updating')
    await settle()
    expect(h.calls[0]).toEqual(['npm', ['i', '-g', 'centralu@9999.0.0']])
    expect(h.svc.current().phase).toBe('restart_required')
  })

  it('records the reason when installation fails (does not silently revert)', async () => {
    const h = make({
      registry: '9999.0.0',
      run: async () => {
        throw new Error('EACCES: permission denied')
      },
    })
    await h.svc.check(true)
    h.svc.apply()
    await settle()
    expect(h.svc.current().phase).toBe('failed')
    expect(h.svc.current().error).toMatch(/EACCES/)
  })

  it('refreshes the installed copy after npm, through the launcher that npm just installed', async () => {
    const h = make({ registry: '9999.0.0', installedCopy: 'C:\\Users\\me\\AppData\\Local\\Programs\\Centralu' })
    await h.svc.check(true)
    h.svc.apply()
    await settle()
    expect(h.calls).toEqual([
      ['npm', ['i', '-g', 'centralu@9999.0.0']],
      ['centralu', ['install']],
    ])
    expect(h.svc.current().phase).toBe('restart_required')
  })

  it('when only the copy failed, says npm worked, names the copy and the command that finishes it', async () => {
    const copy = 'C:\\Users\\me\\AppData\\Local\\Programs\\Centralu'
    const h = make({
      registry: '9999.0.0',
      installedCopy: copy,
      run: async (file) => {
        if (file === 'centralu') throw new Error('Windows would not replace it — Centralu is probably still running.')
      },
    })
    await h.svc.check(true)
    h.svc.apply()
    await settle()
    const s = h.svc.current()
    expect(s.phase).toBe('failed')
    expect(s.error).toContain('npm installed 9999.0.0')
    expect(s.error).toContain(copy)
    expect(s.error).toContain('still running')
    expect(s.error).toContain('"centralu install"')
  })

  it('says so when called with nothing to update (instead of doing nothing silently)', async () => {
    const h = make({ registry: null })
    const s = h.svc.apply()
    expect(s.phase).toBe('failed')
    expect(h.calls).toEqual([])
  })

  /**
   * A periodic check after installation finishes must not erase "please restart."
   *
   * The disk has the new version while the running process is still the old one, so a check six
   * hours later would find the exact version just installed as "new" all over again — telling
   * someone to update when they already have.
   */
  it('a check does not overwrite the state while a restart is pending', async () => {
    const h = make({ registry: '9999.0.0' })
    await h.svc.check(true)
    h.svc.apply()
    await settle()
    expect((await h.svc.check(true)).phase).toBe('restart_required')
  })

  /**
   * "Apply updates automatically when idle" (#352): off by default, and with it on a newer version
   * found by any check is installed without a click. Applying it stays the window's, once idle.
   */
  describe('automatic apply', () => {
    it('is off by default, and a newer version found is only reported', async () => {
      const h = make({ registry: '9999.0.0' })
      expect(h.svc.current().autoApply).toBe(false)
      await h.svc.check(true)
      await settle()
      expect(h.calls).toEqual([])
      expect(h.svc.current().phase).toBe('idle')
    })

    it('installs a newer version as soon as a check finds it', async () => {
      const h = make({ registry: '9999.0.0', autoApply: true })
      expect((await h.svc.check(true)).phase).toBe('updating')
      await settle()
      expect(h.calls[0]).toEqual(['npm', ['i', '-g', 'centralu@9999.0.0']])
      expect(h.svc.current().phase).toBe('restart_required')
    })

    it('does nothing when the registry has nothing newer', async () => {
      const h = make({ registry: '0.0.1', autoApply: true })
      await h.svc.check(true)
      await settle()
      expect(h.calls).toEqual([])
    })

    it('turning it on installs what is already known, and is saved', async () => {
      const h = make({ registry: '9999.0.0' })
      await h.svc.check(true)
      expect(h.svc.setAutoApply(true).phase).toBe('updating')
      expect(h.saved).toEqual([true])
      await settle()
      expect(h.svc.current()).toMatchObject({ autoApply: true, phase: 'restart_required' })
    })

    it('does not install twice: a check after the install leaves the restart pending', async () => {
      const h = make({ registry: '9999.0.0', autoApply: true })
      await h.svc.check(true)
      await settle()
      await h.svc.check(true)
      await settle()
      expect(h.calls.filter(([f]) => f === 'npm')).toHaveLength(1)
      expect(h.svc.current().phase).toBe('restart_required')
    })

    it('turning it off saves that and installs nothing', async () => {
      const h = make({ registry: '9999.0.0', autoApply: true })
      h.svc.setAutoApply(false)
      expect(h.saved).toEqual([false])
      await h.svc.check(true)
      await settle()
      expect(h.calls).toEqual([])
    })
  })
})

/** Node's own `npm.cmd`, as Node 24.21's Windows installer writes it (read 2026-10-08) */
const NODE_NPM_CMD = [
  ":: Created by npm, please don't edit manually.",
  '@ECHO OFF',
  '',
  'SETLOCAL',
  '',
  'SET "NODE_EXE=%~dp0\\node.exe"',
  'IF NOT EXIST "%NODE_EXE%" (',
  '  SET "NODE_EXE=node"',
  ')',
  '',
  'SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"',
  'SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"',
  `FOR /F "delims=" %%F IN ('CALL "%NODE_EXE%" "%NPM_PREFIX_JS%"') DO (`,
  '  SET "NPM_PREFIX_NPM_CLI_JS=%%F\\node_modules\\npm\\bin\\npm-cli.js"',
  ')',
  'IF EXIST "%NPM_PREFIX_NPM_CLI_JS%" (',
  '  SET "NPM_CLI_JS=%NPM_PREFIX_NPM_CLI_JS%"',
  ')',
  '',
  '"%NODE_EXE%" "%NPM_CLI_JS%" %*',
  '',
].join('\r\n')

/** npm's cmd-shim for the launcher, as `npm i -g centralu` wrote it (Windows 11, 2026-10-08) */
const CENTRALU_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\\node_modules\\centralu\\bin\\centralu.mjs" %*',
  '',
].join('\r\n')

/**
 * Windows (#14), where the in-app update failed with "spawn npm ENOENT" up to 0.1.0-beta.12:
 * `npm` and `centralu` are batch files there, which `execFile` without a shell cannot start, and
 * the copy `centralu install` makes was never looked for, so it was never refreshed.
 */
describe('updating on Windows', () => {
  const nodeDir = 'C:\\Program Files\\nodejs'
  const npmDir = 'C:\\Users\\Jane Doe\\AppData\\Roaming\\npm'
  const npmCli = `${nodeDir}\\node_modules\\npm\\bin\\npm-cli.js`
  const launcher = `${npmDir}\\node_modules\\centralu\\bin\\centralu.mjs`
  const NODE = `${nodeDir}\\node.exe`
  const files: Record<string, string> = {
    [`${nodeDir}\\npm.cmd`]: NODE_NPM_CMD,
    [npmCli]: '',
    [`${npmDir}\\centralu.cmd`]: CENTRALU_SHIM,
    [launcher]: '',
  }
  const env = { Path: `C:\\WINDOWS\\system32;${nodeDir}\\;${npmDir}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' }
  const resolve = (file: string) =>
    resolveCommand(file, env, {
      platform: 'win32',
      read: (p) => files[p] ?? '',
      exists: (p) => p in files,
      node: NODE,
      runJs: () => null,
    })

  it('npm runs as Node and npm-cli.js, never as a bare name or a .cmd', () => {
    expect(commandFor('npm', ['i', '-g', 'centralu@0.1.0-beta.13'], resolve)).toEqual({
      file: NODE,
      args: [npmCli, 'i', '-g', 'centralu@0.1.0-beta.13'],
    })
  })

  it('centralu install runs the launcher npm just installed, through Node', () => {
    expect(commandFor('centralu', ['install'], resolve)).toEqual({ file: NODE, args: [launcher, 'install'] })
  })

  it('the installed copy is the one in %LOCALAPPDATA%\\Programs', () => {
    const home = 'C:\\Users\\Jane Doe'
    const expected = win32.join(home, 'AppData', 'Local', 'Programs', 'Centralu')
    expect(installedCopyPath('win32', { LOCALAPPDATA: `${home}\\AppData\\Local` }, home)).toBe(expected)
    // The launcher's own fallback when LOCALAPPDATA is not set
    expect(installedCopyPath('win32', {}, home)).toBe(expected)
  })

  it("is the path the launcher's install writes and its update refreshes, on every platform", () => {
    const cases: [NodeJS.Platform, Record<string, string>, string][] = [
      ['win32', { LOCALAPPDATA: 'D:\\Profiles\\jane\\Local' }, 'C:\\Users\\jane'],
      ['darwin', {}, '/Users/jane'],
      ['linux', {}, '/home/jane'],
    ]
    for (const [platform, e, home] of cases) {
      expect(installedCopyPath(platform, e, home)).toBe((installedPaths(platform, e, home) as string[])[0])
    }
  })
})

describe('what a failed command says', () => {
  it('npm: its last line, not the pointer to its log', () => {
    const stderr = [
      'npm error code EACCES',
      "npm error EACCES: permission denied, mkdir '/usr/lib/node_modules/centralu'",
      'npm error A complete log of this run can be found in: C:\\Users\\me\\AppData\\Local\\npm-cache\\_logs\\x.log',
      '',
    ].join('\r\n')
    expect(failureDetail('npm', stderr)).toBe("npm error EACCES: permission denied, mkdir '/usr/lib/node_modules/centralu'")
  })

  it('the launcher: its first line, which says why, not the advice meant for a terminal', () => {
    const stderr =
      'Windows would not replace C:\\x — Centralu is probably still running.\nQuit it (close the window and choose Quit), then run the command again.\n'
    expect(failureDetail('centralu', stderr)).toBe('Windows would not replace C:\\x — Centralu is probably still running.')
  })
})

/**
 * The real thing, on the Windows CI job: Node's own `npm.cmd` and npm's `centralu.cmd` on disk,
 * started by `runCommand` with nothing but PATH to go on. Before the fix this failed as the app
 * did, "spawn npm ENOENT".
 */
describe.runIf(process.platform === 'win32')('runCommand with real batch files (Windows)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'centralu-update-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const nodeDir = join(dir, 'nodejs')
  const prefix = join(dir, 'prefix')
  const argsFile = (name: string) => join(dir, `${name}.args.json`)
  const recorder = (name: string) =>
    `require('node:fs').writeFileSync(${JSON.stringify(argsFile(name))}, JSON.stringify(process.argv.slice(2)))\n`
  mkdirSync(join(nodeDir, 'node_modules', 'npm', 'bin'), { recursive: true })
  mkdirSync(join(prefix, 'node_modules', 'centralu', 'bin'), { recursive: true })
  writeFileSync(join(nodeDir, 'npm.cmd'), NODE_NPM_CMD)
  writeFileSync(join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), recorder('npm'))
  writeFileSync(join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-prefix.js'), `console.log(${JSON.stringify(prefix)})\n`)
  writeFileSync(join(prefix, 'centralu.cmd'), CENTRALU_SHIM)
  // The launcher is an ES module; createRequire keeps the recorder one line
  writeFileSync(
    join(prefix, 'node_modules', 'centralu', 'bin', 'centralu.mjs'),
    `import { createRequire } from 'node:module'\nconst require = createRequire(import.meta.url)\n${recorder('centralu')}`,
  )
  const systemDir = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
  const env = { ...process.env, PATH: [systemDir, nodeDir, prefix].join(';') }
  const resolve = (file: string) => resolveCommand(file, env)

  it('npm i -g reaches npm-cli.js with its arguments as given', async () => {
    await runCommand('npm', ['i', '-g', 'centralu@0.1.0-beta.13'], resolve)
    expect(JSON.parse(readFileSync(argsFile('npm'), 'utf8'))).toEqual(['i', '-g', 'centralu@0.1.0-beta.13'])
  })

  it('centralu install reaches the launcher', async () => {
    await runCommand('centralu', ['install'], resolve)
    expect(JSON.parse(readFileSync(argsFile('centralu'), 'utf8'))).toEqual(['install'])
  })
})
