import { execFile } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import { promisify } from 'node:util'
import { parseCliVersion } from '@cc/protocol'
import { whichTool } from './env-path.js'
import { launchFor, type ToolLaunch } from './tool-launch.js'

const exec = promisify(execFile)

/**
 * Which version of an agent CLI is installed on this machine (#297), found the way sessions find
 * the CLI they start: `whichTool`, then the program a shim starts (`launchFor`).
 *
 * In order:
 *
 *   1. **npm's `package.json`**, beside the file the command runs. npm and pnpm install both CLIs
 *      this way (`@anthropic-ai/claude-code`, `@openai/codex`), and reading a file costs no process.
 *      On Windows it is also the only safe way: since #353 Claude runs from a hard link under
 *      `<data>\tools\claude\…`, and running npm's `claude.exe` to ask would hold the very file an
 *      npm update has to replace.
 *   2. **The file's own name**, when it is a version: Claude Code's native installer keeps one file
 *      per version (`~/.local/share/claude/versions/2.1.289`) and links `claude` to the current one.
 *   3. **`<cli> --version`**, off Windows only: a Homebrew cask, a manual install. Measured
 *      2026-10-05: `2.1.289 (Claude Code)` and `codex-cli 0.160.0`, each well under a second.
 *
 * Null when the CLI is not installed or none of these says.
 */
export type CliVersionDeps = {
  platform: NodeJS.Platform
  which: (name: string) => string | null
  launch: (path: string) => ToolLaunch
  realpath: (path: string) => string
  read: (path: string) => string
  /** Runs a program and gives its stdout */
  run: (command: string, args: string[]) => Promise<string>
}

const realDeps = (): CliVersionDeps => ({
  platform: process.platform,
  which: (name) => whichTool(name),
  launch: (path) => launchFor(path),
  realpath: (path) => realpathSync(path),
  read: (path) => readFileSync(path, 'utf8'),
  run: async (command, args) => (await exec(command, args, { timeout: 5000 })).stdout,
})

/** How many folders up from the file to look for its `package.json`: `bin/claude.exe` is one, a nested `dist/bin/x.js` two */
const PACKAGE_DEPTH = 3

/**
 * The version in the `package.json` of the npm package named `packageName` that `file` belongs to,
 * or null. The name must match: a folder above a hand-installed binary can hold any package.
 */
export function npmPackageVersion(file: string, packageName: string, deps: Pick<CliVersionDeps, 'platform' | 'realpath' | 'read'>): string | null {
  const path = deps.platform === 'win32' ? win32 : posix
  let real = file
  try {
    // A symlink (`/opt/homebrew/bin/claude` → `…/@anthropic-ai/claude-code/bin/claude.exe`) is read where it points
    real = deps.realpath(file)
  } catch {
    // a file that cannot be resolved is looked at where it is
  }
  let dir = path.dirname(real)
  for (let i = 0; i < PACKAGE_DEPTH; i++) {
    try {
      const pkg = JSON.parse(deps.read(path.join(dir, 'package.json'))) as { name?: unknown; version?: unknown }
      if (pkg.name === packageName && typeof pkg.version === 'string' && pkg.version) return pkg.version
    } catch {
      // no package.json here, or not one we can read
    }
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return null
}

export async function installedCliVersion(name: string, packageName: string, deps: CliVersionDeps = realDeps()): Promise<string | null> {
  const found = deps.which(name)
  if (!found) return null
  const launch = deps.launch(found)
  // The file the command really runs: the script a Windows shim names, or the shim itself
  const file = launch.args[0] ?? launch.command
  const fromNpm = npmPackageVersion(file, packageName, deps)
  if (fromNpm) return fromNpm
  const path = deps.platform === 'win32' ? win32 : posix
  let real = file
  try {
    real = deps.realpath(file)
  } catch {
    // looked at where it is
  }
  const named = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.exec(path.basename(real).replace(/\.exe$/i, ''))
  if (named) return named[0]
  if (deps.platform === 'win32') return null
  try {
    return parseCliVersion(await deps.run(launch.command, [...launch.args, '--version']))
  } catch {
    return null
  }
}
