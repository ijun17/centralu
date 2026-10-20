import { errorMessage } from '@cc/protocol'
import { execFailure } from './exec-error.js'
import { lstatSync, mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { PROJECTS_DIR, folderNameError } from '@cc/protocol'
import { rpcError } from '../rpc-error.js'

/**
 * Making a project's folder (#515): an **empty** folder, named by the person or the orchestrator, by default in the
 * `Centralu` folder of the home of the machine the project lives on. No `git init`, no template: what goes in it is
 * the agent's first job.
 *
 * The host of that machine does it, with that machine's own path rules, so everything here takes the platform as a
 * parameter (tests check the Windows rules on any machine) and never reaches the real home unless the host wires
 * `projectsHome` in (main.ts): a test that forgets to inject a folder fails instead of writing in someone's home.
 */

export type Platform = NodeJS.Platform

/** The path module for a platform — `path.win32` on Windows, POSIX elsewhere */
function pathFor(platform: Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix
}

/**
 * The default parent of a new project on this machine: `~/Centralu` (`%USERPROFILE%\Centralu` on Windows), the same on
 * every machine and made on first use (owner decision on #515, 2026-10-12). Not the Desktop it was at first: on macOS
 * the Desktop is a protected folder, so the first look into it asked for access in Centralu's name, while a folder in
 * the home is not protected; it is a visible folder, found in Finder or Explorer; and it is apart from the app's own
 * data folder (`~/.centralu`), which an uninstall may remove. Nothing on disk is touched here.
 */
export function projectsHome(platform: Platform = process.platform, home = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  if (platform === 'win32') return path.win32.join(env.USERPROFILE || home, PROJECTS_DIR)
  return path.posix.join(home, PROJECTS_DIR)
}

export interface ProjectFolderTarget {
  name: string
  /** The folder the project goes in */
  parent: string
  /** The project's own folder, `parent` + `name` */
  path: string
  /** The parent is the default `~/Centralu`, which is made if missing */
  isDefault: boolean
}

/** A refusal worded for the person (or the model) that asked */
function refuse(message: string): never {
  throw rpcError(message)
}

/**
 * Where a project named `name` would be made, checked, without making anything: the name is one segment, the parent
 * is a full path to a folder (or the default `~/Centralu`, missing or not), and nothing of that name is there yet.
 * Refuses with one sentence; the sentence is what the dialog shows as the person types and what the orchestrator
 * reads back.
 */
export function projectFolderTarget(
  spec: { name: string; parent?: string | null },
  /** The default parent (`projectsHome`), used when no parent is given; null where the caller has none */
  home: string | null,
  platform: Platform = process.platform,
): ProjectFolderTarget {
  const p = pathFor(platform)
  const name = spec.name.trim()
  // The rule is shared with the dialog and the mock (protocol), so all three refuse the same names
  const nameError = folderNameError(name, platform === 'win32')
  if (nameError) refuse(nameError)
  const given = spec.parent?.trim()
  if (given && !p.isAbsolute(given)) refuse(`The location has to be a full path (${platform === 'win32' ? 'C:\\Users\\me\\code' : '/home/me/code'}).`)
  const base = given || home
  if (!base) refuse('There is no default location here — give a parent folder.')
  const parent = p.resolve(base)
  // Only the default parent is ever made: a parent the person typed has to be there already
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
 * Makes the folder `projectFolderTarget` checked. The default `~/Centralu` is made when missing; a parent the person
 * named is not (a typo would otherwise grow a tree). The folder itself is made alone, never recursively and never over
 * anything: a name taken between the check and now is refused the same way.
 */
export function makeProjectFolder(target: ProjectFolderTarget): void {
  if (target.isDefault) mkdirSync(target.parent, { recursive: true })
  try {
    mkdirSync(target.path)
  } catch (e) {
    const code = execFailure(e).code
    if (code === 'EEXIST') refuse(`Something named "${target.name}" is already in ${target.parent} — choose another name.`)
    if (code === 'ENOENT') refuse(`There is no folder at ${target.parent}.`)
    refuse(`Could not make ${target.path}: ${errorMessage(e)}`)
  }
}
