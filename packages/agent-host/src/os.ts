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
