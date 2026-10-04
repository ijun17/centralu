import { existsSync, readFileSync } from 'node:fs'
import { win32 } from 'node:path'
import { whichTool } from './env-path.js'

/**
 * How to start a tool `whichTool` found: a program and the arguments that go before the tool's
 * own (#14).
 *
 * On macOS and Linux this is the path itself. On Windows a tool installed with `npm i -g` (or
 * pnpm) is a `.cmd` batch file, and Node refuses to spawn a `.bat` or `.cmd` without
 * `shell: true` (EINVAL since the CVE-2024-27980 fix). A shell is not an option: the arguments
 * carry JSON and prompts, and cmd.exe would read `%`, `^`, `&` and quotes in them as its own. So
 * the batch file is read for the program it starts, and that is started instead: a `.js` entry
 * through this same Node, or an `.exe` directly. A native install (`claude.exe`) needs none of
 * this.
 */
export type ToolLaunch = { command: string; args: string[] }

type Deps = {
  platform: NodeJS.Platform
  read: (path: string) => string
  exists: (path: string) => boolean
  /** The Node that runs a `.js` entry: the host's own */
  node: string
}

const realDeps = (): Deps => ({
  platform: process.platform,
  read: (path) => readFileSync(path, 'utf8'),
  exists: existsSync,
  node: process.execPath,
})

export function launchFor(path: string, deps: Deps = realDeps()): ToolLaunch {
  const plain = { command: path, args: [] }
  if (deps.platform !== 'win32' || !/\.(cmd|bat)$/i.test(path)) return plain
  let text: string
  try {
    text = deps.read(path)
  } catch {
    return plain
  }
  const relative = shimTarget(text)
  if (!relative) return plain
  const target = win32.resolve(win32.dirname(path), relative)
  if (!deps.exists(target)) return plain
  if (/\.(c|m)?js$/i.test(target)) return { command: deps.node, args: [target] }
  if (/\.exe$/i.test(target)) return { command: target, args: [] }
  return plain
}

/**
 * The file a package manager's batch shim starts, relative to the shim's folder.
 *
 * Both shapes in use name it as a quoted path off the shim's own folder, next to an optional
 * `node.exe` in that folder (used when one sits beside the shim):
 *
 *   npm (cmd-shim):          "%_prog%"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*
 *   pnpm (@zkochan/cmd-shim): node  "%~dp0\..\@anthropic-ai\claude-code\cli.js" %*
 *
 * and for a package whose bin is an executable, npm writes `"%dp0%\node_modules\…\x.exe"   %*`.
 * The first quoted path that is not that `node.exe` is the target.
 */
export function shimTarget(text: string): string | null {
  for (const m of text.matchAll(/"%(?:~dp0|dp0%)\\?([^"%]+)"/gi)) {
    const rel = m[1]!.trim()
    if (!rel || /(^|\\)node\.exe$/i.test(rel)) continue
    return rel
  }
  return null
}

/**
 * A command as a manifest names it (`node`, `npx`, `uvx`, or a path), ready to spawn.
 *
 * Off Windows, unchanged: the spawn searches PATH as it always did. On Windows a bare name is
 * looked up with PATHEXT first, so `npx` becomes `npx.cmd` and then the program that starts, and
 * `node` becomes the absolute `node.exe` on PATH. The second matters too: given a bare name,
 * Windows process creation looks in the working directory before PATH, and an app's working
 * directory is its own folder.
 */
export function resolveCommand(
  command: string,
  env: Record<string, string | undefined> = process.env,
  deps: Deps = realDeps(),
): ToolLaunch {
  if (deps.platform !== 'win32') return { command, args: [] }
  if (/[\\/]/.test(command)) return launchFor(command, deps)
  const found = whichTool(command, env, 'win32', deps.exists)
  return found ? launchFor(found, deps) : { command, args: [] }
}

/**
 * A program the host runs by name in a project folder (`git`, `gh`), as a path to spawn.
 *
 * Off Windows, the name: the spawn searches PATH and nothing else. **On Windows, the absolute path
 * found on PATH**, because given a bare name Windows process creation looks in the child's
 * working directory before PATH (libuv's `search_path` does what cmd.exe does). Every git call runs
 * with the project as its working directory, so a `git.exe` committed at a repository's root would
 * have run on the first status read of a freshly added project (#14). A found path is remembered;
 * a miss is asked again next time, so a git installed while the app runs is picked up.
 */
export function programPath(
  name: string,
  platform: NodeJS.Platform = process.platform,
  find: (name: string) => string | null = (n) => whichTool(n),
): string {
  if (platform !== 'win32') return name
  const known = programs.get(name)
  if (known) return known
  const found = find(name)
  if (found) programs.set(name, found)
  return found ?? name
}

const programs = new Map<string, string>()

/** Forgets what programPath found (tests) */
export function __forgetPrograms(): void {
  programs.clear()
}

/**
 * The single path the Claude Agent SDK accepts as `pathToClaudeCodeExecutable`: the SDK runs a
 * `.js` through Node and anything else directly, so a shim becomes its entry or its executable.
 */
export function toolExecutable(name: string, deps: Deps = realDeps()): string | null {
  const found = whichTool(name)
  if (!found) return null
  const launch = launchFor(found, deps)
  return launch.command === deps.node && launch.args.length === 1 ? launch.args[0]! : launch.command
}
