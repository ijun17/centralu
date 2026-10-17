/**
 * What differs between operating systems, for host code that is not a platform module itself.
 *
 * Code outside the platform modules does not ask which OS it is on (`local/platform-checks` in
 * eslint.config.js): it asks one of the questions below, named for what differs, and the answer for
 * each OS is written once, here. The other platform modules own a whole subject instead: finding and
 * starting tools (`env-path.ts`, `tool-launch.ts`), ending process trees (`dev-services/kill-tree.ts`),
 * shells (`dev-services/terminal.ts`) and Claude Code's Windows start (`adapters/claude/exe-link.ts`).
 *
 * Each takes the platform as a parameter, defaulting to this host's, so tests can ask about another.
 */

import { homedir } from 'node:os'
import { posix, win32, type PlatformPath } from 'node:path'
import { APP_NAME, APP_SLUG } from '@cc/protocol'

export type Platform = NodeJS.Platform

/** The platform this host runs on: what the injectable `platform` parameters default to. */
export const HOST_PLATFORM: Platform = process.platform

/**
 * `ps` and `lsof` are there to ask about another process: its start time, its working folder.
 * Windows has neither, and reuses pids quickly, so a pid alone says little there.
 */
export function hasPs(platform: Platform = HOST_PLATFORM): boolean {
  return platform !== 'win32'
}

/** Where Windows lives when `%SystemRoot%` cannot be used */
const DEFAULT_SYSTEM_ROOT = 'C:\\Windows'

/** A whole Windows path from a drive's root (`C:\…`): not relative, not drive-relative (`C:x`), not a share */
function driveAbsolute(p: string | undefined): p is string {
  return typeof p === 'string' && /^[A-Za-z]:[\\/]/.test(p)
}

/**
 * A Windows system program by its full path under `%SystemRoot%\System32` (taskkill, PowerShell, cmd), so it is
 * never looked up by name: Windows looks a bare or relative name up in the working directory first, and the host runs
 * in a project's folder, where a planted `taskkill.exe` would run.
 *
 * A `SystemRoot` that is not a whole path from a drive's root is not used: an empty one made `System32\taskkill.exe`
 * a path relative to the working directory (#428). `C:\Windows` is used instead.
 */
export function systemTool(segments: readonly string[], env: Record<string, string | undefined> = process.env): string {
  const root = driveAbsolute(env.SystemRoot) ? env.SystemRoot : DEFAULT_SYSTEM_ROOT
  return win32.join(root, 'System32', ...segments)
}

/** `%ComSpec%` when it is a whole path from a drive's root, else cmd.exe under `systemTool` (the same rule) */
export function commandInterpreter(env: Record<string, string | undefined> = process.env): string {
  return driveAbsolute(env.ComSpec) ? env.ComSpec : systemTool(['cmd.exe'], env)
}

/** `cp -c` clones a folder with APFS's clonefile: macOS only. */
export function clonesFiles(platform: Platform = HOST_PLATFORM): boolean {
  return platform === 'darwin'
}

/**
 * A running program's file cannot be replaced or deleted (Windows, #353). There, a program npm will
 * update is never run in place just to ask its version.
 */
export function locksRunningPrograms(platform: Platform = HOST_PLATFORM): boolean {
  return platform === 'win32'
}

/**
 * A pty runs on the ConPTY node-pty ships (`useConptyDll`, `conpty/` beside `conpty.node`) rather than the one in the
 * OS (Windows, #849): Windows' own left a `conhost.exe` per terminal tab and per command until the host exited.
 */
export function usesShippedConpty(platform: Platform = HOST_PLATFORM): boolean {
  return platform === 'win32'
}

/**
 * A folder being watched cannot be renamed or moved, and neither can any folder above it (Windows, #849): the watch
 * holds the folder open. There a project is watched by one recursive watch on its root instead of one per folder.
 */
export function locksWatchedFolders(platform: Platform = HOST_PLATFORM): boolean {
  return platform === 'win32'
}

/** A program's file name on `platform`: `codex.exe` on Windows, `codex` elsewhere. */
export function programFile(name: string, platform: Platform = HOST_PLATFORM): string {
  return platform === 'win32' ? `${name}.exe` : name
}

/**
 * The Rust target triple a CLI built for this machine carries, as Codex's npm package names its binaries (bin/codex.js,
 * codex-cli 0.160.0): musl on Linux and Android, MSVC on Windows. Null where it ships no build.
 */
export function rustTarget(platform: Platform = HOST_PLATFORM, arch: string = process.arch): string | null {
  const cpu = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : null
  if (!cpu) return null
  if (platform === 'darwin') return `${cpu}-apple-darwin`
  if (platform === 'linux' || platform === 'android') return `${cpu}-unknown-linux-musl`
  if (platform === 'win32') return `${cpu}-pc-windows-msvc`
  return null
}

/**
 * A file's mode bits say which accounts may read it (POSIX). Windows ignores them for that: who may read a file there is
 * its ACL, which a profile folder already gives to its owner alone (#838, `keepDataFolderPrivate`).
 */
export function modesGuardFiles(platform: Platform = HOST_PLATFORM): boolean {
  return platform !== 'win32'
}

/** File names that differ only by case are one file (Windows): comparing two spellings of a path folds case first. */
export function foldsPathCase(platform: Platform = HOST_PLATFORM): boolean {
  return platform === 'win32'
}

/** The path rules of `platform`: backslashes and drive letters on Windows, slashes elsewhere. */
export function pathsOf(platform: Platform = HOST_PLATFORM): PlatformPath {
  return platform === 'win32' ? win32 : posix
}

/**
 * Where `centralu install` would have put the app on this platform.
 *
 * These paths are the launcher's (`installedPaths` and `windowsInstall` in
 * `packaging/npm/centralu/bin/platform.mjs`), and they are re-derived rather than imported for the
 * same reason the version compare is: the launcher is a published npm package, not a workspace
 * dependency. They must stay in step — if they drift, the symptom is that updating leaves the
 * *old* app in place while npm holds the new one, and the person keeps launching the old one with
 * no sign that anything is wrong. Up to 0.1.0-beta.12 Windows fell through to the Linux path here,
 * so the copy in `%LOCALAPPDATA%\Programs` was never refreshed by an in-app update.
 *
 * Windows reads the same environment the launcher does, so the `centralu install` this decides on
 * writes where this looked.
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

/**
 * How to read the version the copy `centralu install` made carries (#645).
 *
 * macOS: the bundle's `CFBundleShortVersionString`, printed by `plutil`, which reads XML and binary
 * plists alike. It is the launcher's command (`bundleVersionCommand` in
 * `packaging/npm/centralu/bin/platform.mjs`, pinned to this by `updates.test.ts`), so the host and
 * `centralu install` never disagree about a copy. Windows: the `centralu-version.txt` the launcher
 * writes beside the copy (the exe's version resource drops the prerelease tag). Nothing on Linux:
 * its menu entry points back into the npm package, so there is no second copy to compare.
 */
export function installedCopyVersionSource(
  copy: string,
  platform: Platform = HOST_PLATFORM,
): { kind: 'command'; file: string; args: string[] } | { kind: 'file'; name: string } | null {
  if (platform === 'darwin') {
    return { kind: 'command', file: '/usr/bin/plutil', args: ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', posix.join(copy, 'Contents', 'Info.plist')] }
  }
  // A file name in the copy, joined where it is read (by that host's path rules)
  if (platform === 'win32') return { kind: 'file', name: 'centralu-version.txt' }
  return null
}

/**
 * Where free memory plus what the OS can reclaim at once is read (#686): the start gate for new agent sessions asks.
 * `os.freemem()` alone undercounts badly on macOS and Linux, where caches hold most of the "used" memory and give it
 * back on demand (a 24 GB Mac read 0.2 GB free with 9 GB inactive). macOS: `vm_stat`'s pages; Linux: `MemAvailable`
 * in `/proc/meminfo`, the kernel's own estimate; elsewhere (Windows), `os.freemem()`, which there already counts the
 * standby list.
 */
export function availableMemorySource(
  platform: Platform = HOST_PLATFORM,
): { kind: 'command'; file: string; args: string[]; parse: 'vm_stat' } | { kind: 'file'; path: string; parse: 'meminfo' } | { kind: 'freemem' } {
  if (platform === 'darwin') return { kind: 'command', file: '/usr/bin/vm_stat', args: [], parse: 'vm_stat' }
  if (platform === 'linux' || platform === 'android') return { kind: 'file', path: '/proc/meminfo', parse: 'meminfo' }
  return { kind: 'freemem' }
}

/**
 * Node's `cpSync` keeps a link as a link (#849). Not on Windows: there a folder is linked with a junction (pnpm without
 * Developer Mode, npm and yarn workspaces), and `cpSync` copies a junction as a real folder holding its target, and
 * walks into two junctions that point at each other until the process dies. A copy there walks the tree itself.
 */
export function cpKeepsLinks(platform: Platform = HOST_PLATFORM): boolean {
  return platform !== 'win32'
}

/**
 * Folder sizes are asked of `du` (#849). Not on Windows: it has none on PATH (Git for Windows keeps one in `usr\bin`,
 * which is not), and given a bare name it looks in the child's working folder first, so a `du.exe` in the project ran.
 * There the sizes are read from the file system.
 */
export function measuresWithDu(platform: Platform = HOST_PLATFORM): boolean {
  return platform !== 'win32'
}

/**
 * A file name has to pass Windows' rules to be one (#849): there `nul` or `aux.c` names a device and a trailing dot or
 * space is dropped when a program reads the name (Node, writing through `\\?\`, makes a file no other program can open),
 * and `notes.txt:payload` writes a hidden stream on `notes.txt` instead of a file of that name.
 */
export function hasWindowsFileNames(platform: Platform = HOST_PLATFORM): boolean {
  return platform === 'win32'
}

/**
 * A process's children outlive it unless it puts them in a job object that ends them (Windows, #1067): there the host
 * joins one at start (`lifecycle/work-job.ts`). macOS and Linux end a tree by its process groups instead.
 */
export function endsWorkWithJob(platform: Platform = HOST_PLATFORM): boolean {
  return platform === 'win32'
}

/**
 * How to tell whether this host runs with administrator rights (#702). Windows: the token's integrity level, as
 * `whoami /groups` lists it; High (`S-1-16-12288`) or System (`S-1-16-16384`) is an elevated token. Windows OpenSSH
 * gives an account in the Administrators group a full token for a network logon, with no UAC split, so a host the hub
 * started over ssh runs elevated where the same person at the desktop would not. The SIDs read the same in every
 * language. Elsewhere: whether it runs as root (uid 0).
 */
export function elevationSource(
  platform: Platform = HOST_PLATFORM,
  env: Record<string, string | undefined> = process.env,
): { kind: 'command'; file: string; args: string[] } | { kind: 'uid' } {
  if (platform === 'win32') return { kind: 'command', file: systemTool(['whoami.exe'], env), args: ['/groups', '/fo', 'csv', '/nh'] }
  return { kind: 'uid' }
}

/** Whether `whoami /groups` lists an elevated integrity level (`elevationSource`); null when it lists none at all */
export function elevatedFromGroups(stdout: string): boolean | null {
  const levels = [...stdout.matchAll(/S-1-16-(\d+)/g)].map((m) => Number(m[1]))
  if (levels.length === 0) return null
  return levels.some((l) => l >= 12288)
}
