import { lstat, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * The `edits` preset's one grant (#1525): a file edit inside the session's folder raises no card. Both adapters ask
 * this before they raise a card for an edit, and only under `edits`. Everything else a card guards (a command, a
 * delete, a path outside the folder) is not decided here.
 *
 * Why this is not Claude's `acceptEdits` mode: that mode also approves `rm`, `rmdir`, `mv`, `cp`, `sed`, `mkdir` and
 * `touch` inside the working folder (Claude Code's documentation), which would let deletes and commands through. And
 * Codex has no mode that accepts patches and asks for commands.
 */

/**
 * Names that decide what runs or what is allowed, which an edit inside the folder could use to widen its own reach: git's
 * hooks and config, a tool's settings and rules, MCP servers, editor tasks, commit hooks, Centralu's own project files.
 * Any path segment with one of these names asks, however deep, and whatever the case (the folder may be on a
 * case-insensitive disk).
 */
const PROTECTED_NAMES: ReadonlySet<string> = new Set([
  '.git', '.gitconfig', '.gitmodules', '.githooks', '.husky', '.pre-commit-config.yaml',
  '.claude', '.claude.json', '.codex', '.mcp.json', '.vscode', '.idea', '.centralu',
  '.bashrc', '.bash_profile', '.profile', '.zshrc', '.zprofile', '.zshenv', '.envrc', '.ripgreprc',
  // Agent instructions folders, dev containers and package-manager config run code or fetch it from elsewhere
  '.agents', '.devcontainer', '.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmfile.cjs',
  // Hard links to the shared store of pnpm and the like make an edit in place reach other projects
  'node_modules',
])

/** Protected places named by two segments in a row, wherever they sit: CI workflows, cargo's config (`CLAUDE.md` and `AGENTS.md` stay editable) */
const PROTECTED_PAIRS: readonly (readonly [string, string])[] = [['.github', 'workflows'], ['.cargo', 'config'], ['.cargo', 'config.toml']]

/** The deepest part of `path` that exists, resolved through links, with the rest of the path put back after it */
async function realPathOf(path: string): Promise<string | null> {
  const tail: string[] = []
  let at = resolve(path)
  for (;;) {
    try {
      return join(await realpath(at), ...tail.reverse())
    } catch (e) {
      // Only a missing part is walked past (a file about to be made); anything else (a loop, no access) asks
      const code = typeof e === 'object' && e !== null && 'code' in e ? e.code : null
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null
      // Missing to `realpath` but present to `lstat`: a link whose target does not exist yet, and writing through it makes the target
      if (await lstat(at).then(() => true, () => false)) return null
      const up = dirname(at)
      if (up === at) return null
      tail.push(at.slice(up.length).replace(/^[\\/]+/, ''))
      at = up
    }
  }
}

/**
 * Whether every one of `targets` (absolute, or relative to `folder`) is a file inside `folder`: after links are
 * resolved (a link out of the folder is outside it), by path segment (`/proj-other` is not inside `/proj`), and none
 * under a protected name. No target, or one that cannot be resolved, is not an edit inside the folder.
 */
export async function insideFolder(folder: string, targets: readonly string[]): Promise<boolean> {
  if (targets.length === 0) return false
  // The folder itself must exist: a session's folder that is gone has nothing to be inside of
  const root = await realpath(folder).catch(() => null)
  if (root === null) return false
  // A broad folder (the home folder, or one holding it, or any disk's root) is not a project to grant edits in
  if (dirname(root) === root) return false
  const home = await realpath(homedir()).catch(() => null)
  if (home !== null) {
    const toHome = relative(root, home)
    if (toHome === '' || (!isAbsolute(toHome) && toHome !== '..' && !toHome.startsWith(`..${sep}`))) return false
  }
  for (const target of targets) {
    if (!target) return false
    const real = await realPathOf(resolve(folder, target))
    if (real === null) return false
    const inside = relative(root, real)
    // Empty: the folder itself. Absolute: another drive. `..`: outside
    if (inside === '' || isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`)) return false
    // Windows drops a trailing dot or space from a name, so `.git.` is `.git` there; and `:` there makes a stream of the
    // file (`.mcp.json::$DATA`) or the folder (`.claude::$INDEX_ALLOCATION`), so a segment with one asks
    const parts = inside.split(sep).map((part) => part.toLowerCase().replace(/[. ]+$/, ''))
    if (inside.split(sep).some((part) => part.includes(':')) || parts.some((part) => PROTECTED_NAMES.has(part))) return false
    if (parts.some((part, i) => PROTECTED_PAIRS.some(([a, b]) => part === a && parts[i + 1] === b))) return false
  }
  return true
}

/** The Claude tools that write a file, with the input field holding its path */
const CLAUDE_EDIT_PATH: Readonly<Record<string, string>> = { Edit: 'file_path', MultiEdit: 'file_path', Write: 'file_path', NotebookEdit: 'notebook_path' }

/** Whether this Claude tool call is a file edit inside `folder` (`Edit`, `MultiEdit`, `Write`, `NotebookEdit`) */
export async function claudeEditInside(folder: string, toolName: string, input: Record<string, unknown>): Promise<boolean> {
  const field = CLAUDE_EDIT_PATH[toolName]
  if (!field) return false
  const path = input[field]
  return typeof path === 'string' && (await insideFolder(folder, [path]))
}

/**
 * The preset as the process is launched under it: `edits` is `normal` (#1525), its one grant being answered by the
 * adapter on the host's side. So changing between the two replaces no process (`settingsDrifted`, the launch fingerprint)
 * and reaches the session at once (`SessionHandle.setPermissionPreset`).
 */
export const launchPreset = <P extends string>(preset: P): P | 'normal' => (preset === 'edits' ? 'normal' : preset)
