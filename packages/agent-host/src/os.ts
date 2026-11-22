/**
 * What differs between operating systems, as questions named for it, each OS's answer written once, for host code that is not a platform
 * module (docs/architecture.md "Which OS this is is asked in platform modules only" names the others and the subject each owns).
 * Each takes the platform, defaulting to this host's, so tests can ask about another.
 */

import { homedir } from 'node:os'
import { posix, win32, type PlatformPath } from 'node:path'
import { APP_NAME, APP_SLUG, type HostLogon } from '@cc/protocol'
import { commandInterpreter as rulesCommandInterpreter, pathRules, systemTool as rulesSystemTool, traitsOf, type OsFamily, type OsTraits } from './os/rules.js'

export type Platform = NodeJS.Platform

export const HOST_PLATFORM: Platform = process.platform

/** The family of OS `platform` is, whose rules `os/rules.ts` holds (#1599): the one place the platform becomes the family */
export function familyOf(platform: Platform = HOST_PLATFORM): OsFamily {
  return platform === 'win32' ? 'windows' : 'posix'
}

export function traitsFor(platform: Platform = HOST_PLATFORM): OsTraits {
  return { ...traitsOf(familyOf(platform)), clonesFiles: clonesFiles(platform) }
}

/** `ps` and `lsof` ask about another process (start time, working folder); Windows has neither and reuses pids quickly, so a pid alone says little there */
export function hasPs(platform: Platform = HOST_PLATFORM): boolean {
  return traitsOf(familyOf(platform)).hasPs
}

/** A Windows system program by its full path under `%SystemRoot%System32` (taskkill, PowerShell, cmd), never looked up by name (`os/rules.ts`, #428) */
export function systemTool(segments: readonly string[], env: Record<string, string | undefined> = process.env): string {
  return rulesSystemTool(segments, env)
}

export function commandInterpreter(env: Record<string, string | undefined> = process.env): string {
  return rulesCommandInterpreter(env)
}

export function powershell(env: Record<string, string | undefined> = process.env): string {
  return systemTool(['WindowsPowerShell', 'v1.0', 'powershell.exe'], env)
}

export function clonesFiles(platform: Platform = HOST_PLATFORM): boolean {
  return platform === 'darwin'
}

/**
 * A CLI's own installer lays it out as a folder of versions, each with its own Node, started through a batch file and a
 * PowerShell script (Windows; Cursor's `agent`, measured 2026.10.22); elsewhere a link into the newest
 */
export function installsCliAsVersionFolders(platform: Platform = HOST_PLATFORM): boolean {
  return platform === 'win32'
}

/** A pty runs on the ConPTY node-pty ships (`useConptyDll`; Windows, #849): the OS's left a `conhost.exe` per terminal tab and command until the host exited */
export function usesShippedConpty(platform: Platform = HOST_PLATFORM): boolean {
  return platform === 'win32'
}

/**
 * The folder an app's settings for every user of the machine live in, which the person's own cannot override: `%ProgramData%`
 * on Windows, `/Library/Application Support` on macOS, `/etc` elsewhere (OpenCode's managed config, 1.19.4)
 */
export function systemSettingsFolder(app: string, env: Readonly<Record<string, string | undefined>> = process.env, platform: Platform = HOST_PLATFORM): string {
  if (platform === 'win32') return win32.join(env.ProgramData || 'C:\\ProgramData', app)
  return platform === 'darwin' ? `/Library/Application Support/${app}` : `/etc/${app}`
}

/** Where a CLI on Cursor's credential store keeps its sign-in: a Keychain item, read with `program`, then a JSON file */
export type CursorSignInStore = { keychain: { program: string; service: string; account: string } | null; file: string }

/**
 * Cursor's store as its bundle chooses it (`cli-credentials`, read in 2026.10.22 and named by `cursor-agent/usage-contract.ts`):
 * the login Keychain on macOS, read with `security` as the CLI does, before `~/.<domain>/auth.json`; elsewhere only the file,
 * under `%APPDATA%\<Domain>` on Windows (the domain title-cased) and the XDG config folder on Linux
 */
export function cursorSignInStore(domain: string, env: Readonly<Record<string, string | undefined>> = process.env, home: string = homedir(), platform: Platform = HOST_PLATFORM): CursorSignInStore {
  if (platform === 'win32') {
    const folder = domain.charAt(0).toUpperCase() + domain.slice(1).toLowerCase()
    return { keychain: null, file: win32.join(env.APPDATA || win32.join(home, 'AppData', 'Roaming'), folder, 'auth.json') }
  }
  if (platform === 'darwin') {
    return { keychain: { program: '/usr/bin/security', service: `${domain}-access-token`, account: `${domain}-user` }, file: posix.join(home, `.${domain}`, 'auth.json') }
  }
  return { keychain: null, file: posix.join(env.XDG_CONFIG_HOME || posix.join(home, '.config'), domain, 'auth.json') }
}

/** OpenCode matches a permission's name and pattern in any case on Windows only (1.19.4's `Wildcard.match`: flags `si` there, `s` elsewhere; #1565) */
export function openCodeMatchesAnyCase(platform: Platform = HOST_PLATFORM): boolean {
  return platform === 'win32'
}

export function programFile(name: string, platform: Platform = HOST_PLATFORM): string {
  return platform === 'win32' ? `${name}.exe` : name
}

/**
 * This machine as npm platform packages name it (`<os>-<arch>`, as `@centralu/darwin-arm64`). Re-derived from the launcher's
 * `targetFor` (`packaging/npm/centralu/bin/platform.mjs`), not imported; `updates.test.ts` holds the two to one answer
 */
export function npmMachine(platform: Platform = HOST_PLATFORM, arch: string = process.arch): string {
  return `${platform}-${arch}`
}

/**
 * The Rust target triple a CLI built for this machine carries, as Codex's npm package names its binaries (bin/codex.js,
 * codex-cli 0.160.0): musl on Linux and Android, MSVC on Windows; null where it ships no build
 */
export function rustTarget(platform: Platform = HOST_PLATFORM, arch: string = process.arch): string | null {
  const cpu = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : null
  if (!cpu) return null
  if (platform === 'darwin') return `${cpu}-apple-darwin`
  if (platform === 'linux' || platform === 'android') return `${cpu}-unknown-linux-musl`
  if (platform === 'win32') return `${cpu}-pc-windows-msvc`
  return null
}

export function pathsOf(platform: Platform = HOST_PLATFORM): PlatformPath {
  return pathRules(familyOf(platform))
}

/**
 * Where `centralu install` would have put the app on this platform. Re-derived from the launcher (`installedPaths`,
 * `windowsInstall` in `packaging/npm/centralu/bin/platform.mjs`), not imported, as it is a published package; if they drift, an
 * in-app update leaves the old app in place while npm holds the new one, with no sign. Windows reads the environment the
 * launcher does, so the install writes where this looked
 */
export function installedCopyPath(
  platform: Platform = HOST_PLATFORM,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  if (platform === 'darwin') return `/Applications/${APP_NAME}.app`
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local')
    return win32.join(local, 'Programs', APP_NAME)
  }
  return posix.join(home, '.local/share/applications', `${APP_SLUG}.desktop`)
}

/** Whether replacing the installed copy in the background may raise an OS prompt, never raised unasked (#1736): on macOS, changing a signed
 * bundle in /Applications can ask for App Management */
export function copySwapMayPrompt(platform: Platform = HOST_PLATFORM): boolean {
  return platform === 'darwin'
}

/**
 * How to read the version of the copy `centralu install` made (#645). macOS: the bundle's `CFBundleShortVersionString` via `/usr/bin/plutil`
 * (the launcher's `bundleVersionCommand`, pinned by `updates.test.ts`). Windows: the `centralu-version.txt` the launcher writes beside the copy
 * (the exe's version resource drops the prerelease tag). Linux: the menu entry points into the npm package (`Exec=` names the AppImage in
 * `@centralu/linux-<arch>`), so the version is the `package.json` beside the AppImage (#1736)
 */
export function installedCopyVersionSource(
  copy: string,
  platform: Platform = HOST_PLATFORM,
): { kind: 'plutil'; args: string[] } | { kind: 'file'; name: string } | { kind: 'menu-entry' } | null {
  if (platform === 'darwin') {
    return { kind: 'plutil', args: ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', posix.join(copy, 'Contents', 'Info.plist')] }
  }
  if (platform === 'win32') return { kind: 'file', name: 'centralu-version.txt' }
  if (platform === 'linux') return { kind: 'menu-entry' }
  return null
}

/**
 * Where free memory plus what the OS can reclaim at once is read (#686), for the start gate of new agent sessions. `os.freemem()` alone
 * undercounts on macOS and Linux, where caches hold most of the "used" memory (a 24 GB Mac read 0.2 GB free with 9 GB inactive). macOS: `vm_stat`'s
 * pages; Linux: `MemAvailable` in `/proc/meminfo`; Windows: `os.freemem()`, which counts the standby list
 */
export function availableMemorySource(
  platform: Platform = HOST_PLATFORM,
): { kind: 'command'; file: string; args: string[]; parse: 'vm_stat' } | { kind: 'file'; path: string; parse: 'meminfo' } | { kind: 'freemem' } {
  if (platform === 'darwin') return { kind: 'command', file: '/usr/bin/vm_stat', args: [], parse: 'vm_stat' }
  if (platform === 'linux' || platform === 'android') return { kind: 'file', path: '/proc/meminfo', parse: 'meminfo' }
  return { kind: 'freemem' }
}

/** A process's children outlive it unless a job object ends them (Windows, #1067; the host joins one, `lifecycle/work-job.ts`); elsewhere process groups do */
export function endsWorkWithJob(platform: Platform = HOST_PLATFORM): boolean {
  return platform === 'win32'
}

/**
 * How to tell whether this host runs with administrator rights (#702). Windows: the token's integrity level in `whoami /groups`, High
 * (`S-1-16-12288`) or System (`S-1-16-16384`); OpenSSH gives an Administrators account a full token for a network logon, so a host the hub
 * started over ssh runs elevated where the same person at the desktop would not. The SIDs read the same in every language. Elsewhere: uid 0
 */
export function elevationSource(
  platform: Platform = HOST_PLATFORM,
  env: Record<string, string | undefined> = process.env,
): { kind: 'command'; file: string; args: string[] } | { kind: 'uid' } {
  if (platform === 'win32') return { kind: 'command', file: systemTool(['whoami.exe'], env), args: ['/groups', '/fo', 'csv', '/nh'] }
  return { kind: 'uid' }
}

export function elevatedFromGroups(stdout: string): boolean | null {
  const levels = [...stdout.matchAll(/S-1-16-(\d+)/g)].map((m) => Number(m[1]))
  if (levels.length === 0) return null
  return levels.some((l) => l >= 12288)
}

/**
 * Which kind of Windows logon a process runs in (#1224, `HostLogon`), from the well-known group its token carries:
 * `interactive` (S-1-5-4), `network` (S-1-5-2: Windows OpenSSH's key login), `batch` (S-1-5-3) or `service` (S-1-5-6). It
 * decides whether the user's Credential Manager vault opens: a key login has no password, so DPAPI cannot unlock the master key
 * (measured on a linked Windows 11 PC, 2026-10-19: `cmdkey /list` printed `* NONE *` from the host's children while
 * `%LOCALAPPDATA%\Microsoft\Credentials` held 46 files, and Git Credential Manager could not read or save a sign-in)
 */
export function logonFromGroups(stdout: string): HostLogon | null {
  const sids = new Set([...stdout.matchAll(/"(S-1-5-[2346])"/g)].map((m) => m[1]))
  if (sids.has('S-1-5-4')) return 'interactive'
  if (sids.has('S-1-5-2')) return 'network'
  if (sids.has('S-1-5-3')) return 'batch'
  if (sids.has('S-1-5-6')) return 'service'
  return null
}

/**
 * How to ask whether the system is ending now (#1397, `askSystemStopping`): on Linux systemd says `stopping` for the system's
 * manager at a shutdown or restart and for the user's at the sign-out that ends it. macOS and Windows tell a process with a
 * window (`NSWorkspaceWillPowerOffNotification`, `WM_QUERYENDSESSION`), which the host is not. Each is a command and arguments;
 * `null` where there is none
 */
export function systemStoppingQueries(platform: Platform = HOST_PLATFORM): readonly (readonly string[])[] | null {
  if (platform !== 'linux') return null
  return [
    ['systemctl', 'is-system-running'],
    ['systemctl', '--user', 'is-system-running'],
  ]
}
