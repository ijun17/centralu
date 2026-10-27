import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { whichTool } from './env-path.js'
import { familyOf } from './os.js'
import {
  launchFor as rulesLaunchFor,
  nodeShimEntry as rulesNodeShimEntry,
  notOnPath as rulesNotOnPath,
  programFor,
  resolveCommand as rulesResolveCommand,
  type LaunchDeps,
  type ToolLaunch,
} from './os/rules.js'

export { shimTarget, type ToolLaunch } from './os/rules.js'

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
 *
 * The rules are `os/rules.ts`'s; this module gives them the real files and this Node.
 */

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

/** The rules' dependencies for `platform` (`os/rules.ts` holds the rules; the in-memory OS follows them too) */
const ruleDeps = (deps: Deps): LaunchDeps => ({ ...deps, family: familyOf(deps.platform) })

/** How to start a found tool (`launchFor` in `os/rules.ts`): a batch shim becomes what it starts on Windows */
export function launchFor(path: string, deps: Deps = realDeps()): ToolLaunch {
  return rulesLaunchFor(path, ruleDeps(deps))
}

/** The `.js` that Node's own `npm.cmd` or `npx.cmd` starts (`nodeShimEntry` in `os/rules.ts`) */
export function nodeShimEntry(text: string, dir: string, deps: Pick<Deps, 'exists' | 'runJs'>): string | null {
  return rulesNodeShimEntry(text, dir, deps)
}

/**
 * How to start `command` (a manifest's, a person's) from `cwd` (`resolveCommand` in `os/rules.ts`, #849): on Windows a
 * path is read from `cwd` and tried with PATHEXT, a bare name is found on PATH, and a batch shim becomes what it starts.
 */
export function resolveCommand(
  command: string,
  env: Record<string, string | undefined> = process.env,
  deps: Deps = realDeps(),
  cwd?: string,
): ToolLaunch {
  return rulesResolveCommand(command, env, ruleDeps(deps), cwd)
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
 *
 * **Never a `.cmd` or `.bat`** (#849): Node refuses to spawn one (EINVAL), so a `gh.cmd` or `git.cmd`
 * first on PATH made every call throw, `gitBranchPr` too, which is documented not to. Such a file is
 * taken as the `.exe` it starts (a package manager's shim), or else the first `.exe` on PATH.
 *
 * With neither, **never the bare name**: given one, Windows would look in the project first and run a
 * `git.exe` planted there, which is what the absolute path is for. The answer is then the `.exe`
 * beside that `.cmd`, which the lookup has just found is not there: the spawn reports it missing
 * (ENOENT, `gitBranchPr`'s 'unavailable'), and nothing is looked for anywhere else. It is not
 * remembered, so a git installed later is found.
 *
 * Nor when nothing is found at all (#838): `notOnPath`. The bare name was the answer then, so on a machine without git,
 * or without gh, the first status read or pull request look of a project with a `git.exe` or `gh.exe` at its root ran
 * that program, before the project was trusted.
 */
export function programPath(
  name: string,
  platform: NodeJS.Platform = process.platform,
  find: (name: string, pathExt?: string) => string | null = (n, pathExt) => whichTool(n, pathExt ? { ...process.env, PATHEXT: pathExt } : process.env),
  launch: (path: string) => ToolLaunch = (p) => launchFor(p),
): string {
  const family = familyOf(platform)
  if (family !== 'windows') return name
  const known = programs.get(name)
  if (known) return known
  // The rule is `programFor` (os/rules.ts); a path found is remembered, a miss is asked again next time
  const { path, found } = programFor(name, family, find, launch, process.env)
  if (found) programs.set(name, path)
  return path
}

/**
 * What is spawned on Windows for a program that is not on PATH: a path under `%SystemRoot%\System32` that only an
 * administrator can make, so the spawn reports the program missing (ENOENT, which every caller already reads as "not
 * installed") and Windows looks for it nowhere else. Given the bare name, Windows process creation looks in the child's
 * working folder before PATH, and the host runs git, gh and codex in a project's folder: a `git.exe`, `gh.exe` or
 * `codex.exe` committed there ran whenever the tool itself was not installed (#838, reproduced on Windows 11).
 */
export function notOnPath(name: string, env: Record<string, string | undefined> = process.env): string {
  return rulesNotOnPath(name, env)
}

/**
 * An agent CLI (`claude`, `codex`) to spawn: the path found on PATH; when there is none, the bare name off Windows (the
 * spawn searches PATH and nothing else there) and `notOnPath` on Windows, never the bare name.
 */
export function toolCommand(
  name: string,
  platform: NodeJS.Platform = process.platform,
  find: (name: string) => string | null = (n) => whichTool(n),
): string {
  return find(name) ?? (platform === 'win32' ? notOnPath(name) : name)
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
export function toolExecutable(
  name: string,
  deps: Deps = realDeps(),
  env: Record<string, string | undefined> = process.env,
): string | null {
  const found = whichTool(name, env, deps.platform, deps.exists)
  if (!found) return null
  const launch = launchFor(found, deps)
  return launch.command === deps.node && launch.args.length === 1 ? launch.args[0]! : launch.command
}
