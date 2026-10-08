import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  asideCopies,
  busyMessage,
  earlyExitMessage,
  executableIn,
  installedPaths,
  isBusyError,
  launchPlan,
  npmCommand,
  parseRegPv,
  regExe,
  shortcutCommand,
  targetFor,
  TARGETS,
  WEBVIEW2_DOWNLOAD,
  WEBVIEW2_KEYS,
  webview2MissingMessage,
  webview2Status,
  windowsInstall,
  // @ts-expect-error — plain .mjs shipped inside the npm shim, no types on purpose
} from '../packaging/npm/centralu/bin/platform.mjs'

/**
 * The launcher's Windows path (#14, W3), asked from whatever machine runs the suite.
 *
 * Nobody on this project can run the launcher on Windows before the package ships, and the
 * launcher already on someone's machine cannot be corrected later. So every Windows decision
 * is a function of the platform in `platform.mjs`, and this file asks it what Windows would
 * do — with Windows paths that have spaces in them, because `C:\Users\Jane Doe` is ordinary.
 */

const HOME = 'C:\\Users\\Jane Doe'
const ENV = {
  LOCALAPPDATA: 'C:\\Users\\Jane Doe\\AppData\\Local',
  APPDATA: 'C:\\Users\\Jane Doe\\AppData\\Roaming',
  SystemRoot: 'C:\\WINDOWS',
}
const PKG_APP = 'C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\node_modules\\centralu\\node_modules\\@centralu\\win32-x64\\Centralu'

describe('which package the launcher looks for', () => {
  it('finds the Windows x64 package, and the exe inside its folder', () => {
    expect(targetFor('win32', 'x64')).toEqual({ pkg: '@centralu/win32-x64', artifact: 'Centralu' })
    expect(executableIn('win32', PKG_APP)).toBe(`${PKG_APP}\\centralu.exe`)
  })

  it('has nothing for ARM64 Windows, so the launcher says "not supported" instead of "reinstall"', () => {
    expect(targetFor('win32', 'arm64')).toBeNull()
  })

  it('leaves macOS and Linux artifacts as the thing that is started', () => {
    expect(executableIn('linux', '/x/Centralu.AppImage')).toBe('/x/Centralu.AppImage')
    expect(executableIn('darwin', '/x/Centralu.app')).toBe('/x/Centralu.app')
  })

  it('names exactly the platform packages the shim pins', () => {
    // A target the shim never installs reports "your install is broken"; a pinned package
    // the launcher does not know reports "not supported" on a machine that has it.
    const shim = JSON.parse(readFileSync(new URL('../packaging/npm/centralu/package.json', import.meta.url), 'utf8')) as {
      optionalDependencies: Record<string, string>
    }
    const pkgs = Object.values(TARGETS as Record<string, { pkg: string }>).map((t) => t.pkg)
    expect(pkgs.sort()).toEqual(Object.keys(shim.optionalDependencies).sort())
  })
})

describe('starting the app on Windows', () => {
  const plan = launchPlan('win32', PKG_APP, ['--flag', 'a value with spaces'], HOME)

  it('starts centralu.exe itself, with the arguments untouched', () => {
    expect(plan.command).toBe(`${PKG_APP}\\centralu.exe`)
    // One argument stays one argument: no shell, so nothing re-splits or needs quoting.
    expect(plan.args).toEqual(['--flag', 'a value with spaces'])
    expect(plan.options.shell).toBeUndefined()
  })

  it('detaches, so the app outlives the launcher and its console', () => {
    // Not detached, libuv's job object would kill the app when this launcher exits.
    expect(plan.options.detached).toBe(true)
    expect(plan.options.stdio).toBe('ignore')
    expect(plan.attached).toBe(false)
  })

  it('does not ask Windows to hide the window', () => {
    // windowsHide starts the process with SW_HIDE, which a GUI program applies to its window.
    expect(plan.options.windowsHide).toBe(false)
  })

  it('runs from the home folder, not the folder it was started in', () => {
    expect(plan.options.cwd).toBe(HOME)
  })

  it('keeps macOS on `open` and Linux attached to the terminal', () => {
    expect(launchPlan('darwin', '/Applications/Centralu.app', [], '/Users/me')).toMatchObject({
      command: 'open',
      args: ['-a', '/Applications/Centralu.app'],
      attached: true,
    })
    const linux = launchPlan('linux', '/x/Centralu.AppImage', ['a'], '/home/me')
    expect(linux).toMatchObject({ command: '/x/Centralu.AppImage', args: ['a'], attached: true })
    expect(linux.options).toEqual({ stdio: 'inherit' })
  })
})

describe('`centralu install` on Windows', () => {
  it('copies into the per-user Programs folder and puts a shortcut in the Start menu', () => {
    const w = windowsInstall(ENV, HOME)
    expect(w.dir).toBe('C:\\Users\\Jane Doe\\AppData\\Local\\Programs\\Centralu')
    expect(w.exe).toBe('C:\\Users\\Jane Doe\\AppData\\Local\\Programs\\Centralu\\centralu.exe')
    expect(w.shortcut).toBe('C:\\Users\\Jane Doe\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Centralu.lnk')
    expect(w.versionFile).toBe('C:\\Users\\Jane Doe\\AppData\\Local\\Programs\\Centralu\\centralu-version.txt')
  })

  it('falls back to the profile folder when LOCALAPPDATA / APPDATA are not set', () => {
    const w = windowsInstall({}, HOME)
    expect(w.dir).toBe('C:\\Users\\Jane Doe\\AppData\\Local\\Programs\\Centralu')
    expect(w.shortcut.startsWith('C:\\Users\\Jane Doe\\AppData\\Roaming\\')).toBe(true)
  })

  it('uninstall removes the copy and the shortcut, and nothing else', () => {
    const w = windowsInstall(ENV, HOME)
    expect(installedPaths('win32', ENV, HOME)).toEqual([w.dir, w.shortcut])
    expect(installedPaths('darwin', {}, '/Users/me')).toEqual(['/Applications/Centralu.app'])
    expect(installedPaths('linux', {}, '/home/me')).toEqual(['/home/me/.local/share/applications/centralu.desktop'])
  })

  it('sweeps only the copies an earlier install renamed aside, nothing else in the shared Programs folder', () => {
    expect(
      asideCopies(['Centralu', 'Centralu.new', 'Centralu.old-1791443525027', 'centralu.OLD-17', 'Centralu.old-x', 'Microsoft VS Code', 'Centralu.old-']),
    ).toEqual(['Centralu.old-1791443525027', 'centralu.OLD-17'])
  })

  it('passes the shortcut paths to PowerShell through the environment, never the script text', () => {
    const shortcut = "C:\\Users\\O'Brien Kim\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Centralu.lnk"
    const target = "C:\\Users\\O'Brien Kim\\AppData\\Local\\Programs\\Centralu\\centralu.exe"
    const sc = shortcutCommand(ENV, { shortcut, target, workdir: "C:\\Users\\O'Brien Kim" })
    expect(sc.command).toBe('C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    const script = sc.args.at(-1) as string
    expect(script).not.toContain("O'Brien")
    expect(script).toContain('$env:CENTRALU_SHORTCUT')
    expect(sc.env).toMatchObject({ CENTRALU_SHORTCUT: shortcut, CENTRALU_TARGET: target })
    expect(sc.args).toContain('-NoProfile')
  })
})

describe('`centralu update` on Windows', () => {
  it('runs npm through the shell, since npm is npm.cmd there', () => {
    expect(npmCommand('win32', ['i', '-g', 'centralu@0.1.0-beta.8']).options.shell).toBe(true)
    expect(npmCommand('darwin', ['i', '-g', 'centralu@0.1.0-beta.8']).options.shell).toBeUndefined()
  })

  it('refuses an argument the shell would interpret', () => {
    // The version comes from the registry's response; through a shell it must be a plain token.
    expect(() => npmCommand('win32', ['i', '-g', 'centralu@1.0.0 & calc'])).toThrow(/unexpected argument/)
  })

  it('names a running app as the reason Windows will not replace files', () => {
    expect(busyMessage('C:\\x')).toMatch(/still running/)
    expect(isBusyError({ code: 'EBUSY' })).toBe(true)
    expect(isBusyError({ code: 'EPERM' })).toBe(true)
    expect(isBusyError({ code: 'ENOENT' })).toBe(false)
  })
})

describe('WebView2 detection', () => {
  const present = [
    '',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    '    pv    REG_SZ    129.0.2792.65',
    '',
  ].join('\r\n')

  it('reads the version out of `reg query` output', () => {
    expect(parseRegPv(present)).toBe('129.0.2792.65')
    // An uninstall can leave the key with 0.0.0.0 behind; Microsoft counts that as absent.
    expect(parseRegPv(present.replace('129.0.2792.65', '0.0.0.0'))).toBeNull()
    expect(parseRegPv('    pv    REG_SZ    \r\n')).toBeNull()
    expect(parseRegPv('')).toBeNull()
  })

  it('looks in the machine-wide (32- and 64-bit views) and per-user hives', () => {
    expect(WEBVIEW2_KEYS.map((k: string) => k.slice(0, 4))).toEqual(['HKLM', 'HKLM', 'HKCU'])
    expect(regExe(ENV)).toBe('C:\\WINDOWS\\System32\\reg.exe')
  })

  it('is present when any hive has it', () => {
    const query = (k: string) => (k.startsWith('HKCU') ? present : null)
    expect(webview2Status(ENV, query)).toEqual({ state: 'present', version: '129.0.2792.65' })
  })

  it('is missing only when every hive was read and none has it', () => {
    expect(webview2Status(ENV, () => null)).toEqual({ state: 'missing' })
  })

  it('is unknown, not missing, when reg could not run — the app then starts anyway', () => {
    expect(webview2Status(ENV, () => undefined)).toEqual({ state: 'unknown' })
    expect(webview2Status(ENV, (k: string) => (k.startsWith('HKCU') ? undefined : null))).toEqual({ state: 'unknown' })
  })

  it('trusts a fixed-version runtime the person pointed WebView2 at', () => {
    expect(webview2Status({ WEBVIEW2_BROWSER_EXECUTABLE_FOLDER: 'D:\\wv2' }, () => null).state).toBe('present')
  })

  it('tells the person where to get it, instead of failing silently', () => {
    expect(webview2MissingMessage()).toContain(WEBVIEW2_DOWNLOAD)
    const early = earlyExitMessage(3221226505, HOME)
    expect(early).toContain('3221226505')
    expect(early).toContain(WEBVIEW2_DOWNLOAD)
    expect(early).toContain('C:\\Users\\Jane Doe\\.centralu\\host.log')
  })
})
