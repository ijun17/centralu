import { execFileSync } from 'node:child_process'
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
 * this. `npm.cmd` and `npx.cmd` themselves are batch files too, of a different shape
 * (`nodeShimEntry`), and are read the same way.
 */
export type ToolLaunch = { command: string; args: string[] }

type Deps = {
  platform: NodeJS.Platform
  read: (path: string) => string
  exists: (path: string) => boolean
  /** The Node that runs a `.js` entry: the host's own */
  node: string
  /** Run a `.js` with that Node and return its stdout, or null when it fails (npm's prefix lookup) */
  runJs?: (script: string) => string | null
}

const realDeps = (): Deps => ({
  platform: process.platform,
  read: (path) => readFileSync(path, 'utf8'),
  exists: existsSync,
  node: process.execPath,
  runJs: (script) => {
    try {
      return execFileSync(process.execPath, [script], { encoding: 'utf8', timeout: 10_000, windowsHide: true })
    } catch {
      return null
    }
  },
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
  const dir = win32.dirname(path)
  const relative = shimTarget(text)
  const target = relative ? win32.resolve(dir, relative) : nodeShimEntry(text, dir, deps)
  if (!target || !deps.exists(target)) return plain
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
 * The `.js` that the `npm.cmd` or `npx.cmd` shipped with Node starts, or null for any other file.
 *
 * Those two are not cmd-shim output. They set variables and start the last of them, so the quoted
 * paths `shimTarget` looks for are not there (read on Windows 11 with Node 24.21, 2026-10-08):
 *
 *   SET "NODE_EXE=%~dp0\node.exe"
 *   SET "NPM_PREFIX_JS=%~dp0\node_modules\npm\bin\npm-prefix.js"
 *   SET "NPM_CLI_JS=%~dp0\node_modules\npm\bin\npm-cli.js"
 *   FOR /F "delims=" %%F IN ('CALL "%NODE_EXE%" "%NPM_PREFIX_JS%"') DO (
 *     SET "NPM_PREFIX_NPM_CLI_JS=%%F\node_modules\npm\bin\npm-cli.js"
 *   )
 *   IF EXIST "%NPM_PREFIX_NPM_CLI_JS%" ( SET "NPM_CLI_JS=%NPM_PREFIX_NPM_CLI_JS%" )
 *   "%NODE_EXE%" "%NPM_CLI_JS%" %*
 *
 * The middle part is followed too: after `npm i -g npm`, the npm in the global prefix is the one
 * the shim runs, and it is the one the person's own terminal runs. A prefix that cannot be asked
 * for falls back to the npm beside Node, which is what the shim does as well.
 */
export function nodeShimEntry(text: string, dir: string, deps: Pick<Deps, 'exists' | 'runJs'>): string | null {
  const started = /^\s*"%NODE_EXE%"\s+"%(\w+)%"\s+%\*\s*$/m.exec(text)?.[1]
  if (!started) return null
  const set = (name: string) =>
    new RegExp(`^\\s*SET\\s+"${name}=%~dp0\\\\?([^"%]+)"`, 'im').exec(text)?.[1]?.trim() ?? null
  const relative = set(started)
  if (!relative) return null
  const base = win32.resolve(dir, relative)
  const prefixJs = set('NPM_PREFIX_JS')
  if (!prefixJs || !deps.runJs) return base
  const prefix = deps.runJs(win32.resolve(dir, prefixJs))?.trim().split(/\r?\n/).pop()?.trim()
  if (!prefix || !win32.isAbsolute(prefix)) return base
  const inPrefix = win32.join(prefix, 'node_modules', 'npm', 'bin', win32.basename(base))
  return deps.exists(inPrefix) ? inPrefix : base
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
