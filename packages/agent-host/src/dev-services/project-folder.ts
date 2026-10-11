import { execFile } from 'node:child_process'
import { lstatSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { folderNameError } from '@cc/protocol'

/**
 * Making a project's folder (#515): an **empty** folder, named by the person or the orchestrator, by default on the
 * Desktop of the machine the project lives on. No `git init`, no template: what goes in it is the agent's first job.
 *
 * The host of that machine does it, with that machine's own path rules, so everything here takes the platform as a
 * parameter (tests check the Windows rules on any machine) and never reaches the real Desktop unless the host wires
 * `desktopDir` in (main.ts): a test that forgets to inject a folder fails instead of writing on someone's Desktop.
 */

export type Platform = NodeJS.Platform

/** The path module for a platform — `path.win32` on Windows, POSIX elsewhere */
function pathFor(platform: Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix
}

/** Runs a program and gives its stdout, or rejects. Injected in tests */
export type RunFile = (file: string, args: string[]) => Promise<string>

const runFile: RunFile = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 15_000, windowsHide: true, encoding: 'utf8' }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
  })

/**
 * Asks Windows for the Desktop known folder (`[Environment]::GetFolderPath('Desktop')`), which a person may have
 * moved: redirected to OneDrive, or under a localized name (`바탕 화면`). Never a hard-coded `%USERPROFILE%\Desktop`
 * unless Windows cannot be asked.
 *
 * Two things make this work under ssh, where the remote host often runs (`cmd.exe` as the shell, measured on a
 * Windows 11 PC, 2026-10-12): the script goes as `-EncodedCommand`, so no shell quoting stands between us and
 * PowerShell, and the answer comes back as base64 of its UTF-8 bytes, since the console's code page there is the
 * system's (CP949 on a Korean Windows) and a Korean path printed as text would arrive mangled. `DoNotVerify` gives
 * the path even when the folder is missing; the caller makes it.
 */
export async function windowsDesktop(run: RunFile = runFile, env: NodeJS.ProcessEnv = process.env, home = homedir()): Promise<string> {
  const script =
    "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([Environment]::GetFolderPath('Desktop', 'DoNotVerify')))"
  const shell = env.SystemRoot ? path.win32.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe'
  try {
    const out = await run(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')])
    const desktop = Buffer.from(out.trim(), 'base64').toString('utf8')
    if (desktop && path.win32.isAbsolute(desktop)) return desktop
  } catch (e) {
    console.error(`[projects] could not ask Windows for the Desktop folder: ${(e as Error).message}`)
  }
  return path.win32.join(env.USERPROFILE || home, 'Desktop')
}

/**
 * The Desktop on Linux (WSL included): the XDG user directory when one is set (`~/.config/user-dirs.dirs`, which a
 * desktop in another language fills with its own name), else `~/Desktop`. WSL and a server have no such file, so they
 * get `~/Desktop`, made on first use.
 */
export function linuxDesktop(home = homedir(), env: NodeJS.ProcessEnv = process.env, read: (file: string) => string = (f) => readFileSync(f, 'utf8')): string {
  const fallback = path.posix.join(home, 'Desktop')
  let text: string
  try {
    text = read(path.posix.join(env.XDG_CONFIG_HOME || path.posix.join(home, '.config'), 'user-dirs.dirs'))
  } catch {
    return fallback
  }
  const m = /^\s*XDG_DESKTOP_DIR\s*=\s*"([^"]*)"/m.exec(text)
  if (!m) return fallback
  const dir = m[1]!.replace(/^\$HOME(?=\/|$)/, home)
  // XDG sets the Desktop to the home itself to say "none"; a project scattered loose in the home is not that
  if (!path.posix.isAbsolute(dir) || path.posix.resolve(dir) === path.posix.resolve(home)) return fallback
  return dir
}

/** The default parent of a new project on this machine: its Desktop (#515). Nothing on disk is touched */
export async function desktopDir(platform: Platform = process.platform): Promise<string> {
  if (platform === 'win32') return windowsDesktop()
  if (platform === 'linux') return linuxDesktop()
  return path.posix.join(homedir(), 'Desktop')
}

export interface ProjectFolderTarget {
  name: string
  /** The folder the project goes in */
  parent: string
  /** The project's own folder, `parent` + `name` */
  path: string
  /** The parent is the default Desktop, which may be made if missing (a WSL or a server without one) */
  isDefault: boolean
}

/** A refusal worded for the person (or the model) that asked */
function refuse(message: string): never {
  throw Object.assign(new Error(message), { code: 'internal' })
}

/**
 * Where a project named `name` would be made, checked, without making anything: the name is one segment, the parent
 * is a full path to a folder (or the Desktop, missing or not), and nothing of that name is there yet. Refuses with
 * one sentence; the sentence is what the dialog shows as the person types and what the orchestrator reads back.
 */
export function projectFolderTarget(
  spec: { name: string; parent?: string | null },
  /** The Desktop, used when no parent is given; null where the caller has none */
  desktop: string | null,
  platform: Platform = process.platform,
): ProjectFolderTarget {
  const p = pathFor(platform)
  const name = spec.name.trim()
  // The rule is shared with the dialog and the mock (protocol), so all three refuse the same names
  const nameError = folderNameError(name, platform === 'win32')
  if (nameError) refuse(nameError)
  const given = spec.parent?.trim()
  if (given && !p.isAbsolute(given)) refuse(`The location has to be a full path (${platform === 'win32' ? 'C:\\Users\\me\\code' : '/home/me/code'}).`)
  if (!given && !desktop) refuse('There is no default location here — give a parent folder.')
  const parent = p.resolve(given || desktop!)
  // Only the Desktop is ever made: a parent the person typed has to be there already
  const isDefault = !given
  if (!isDefault) {
    let dir = false
    try {
      dir = statSync(parent).isDirectory()
    } catch {
      refuse(`There is no folder at ${parent}.`)
    }
    if (!dir) refuse(`${parent} is a file, not a folder.`)
  }
  const target = p.join(parent, name)
  // lstat, not exists: a broken link of that name is still a name taken
  let taken = false
  try {
    lstatSync(target)
    taken = true
  } catch {
    // Nothing there
  }
  if (taken) refuse(`Something named "${name}" is already in ${parent} — choose another name.`)
  return { name, parent, path: target, isDefault }
}

/**
 * Makes the folder `projectFolderTarget` checked. The Desktop is made when missing; a parent the person named is not
 * (a typo would otherwise grow a tree). The folder itself is made alone, never recursively and never over anything:
 * a name taken between the check and now is refused the same way.
 */
export function makeProjectFolder(target: ProjectFolderTarget): void {
  if (target.isDefault) mkdirSync(target.parent, { recursive: true })
  try {
    mkdirSync(target.path)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'EEXIST') refuse(`Something named "${target.name}" is already in ${target.parent} — choose another name.`)
    if (code === 'ENOENT') refuse(`There is no folder at ${target.parent}.`)
    refuse(`Could not make ${target.path}: ${(e as Error).message}`)
  }
}
