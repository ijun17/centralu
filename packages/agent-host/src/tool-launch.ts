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
 * How to start a tool `whichTool` found: a program and the arguments before the tool's own (#14). On Windows a tool from `npm i
 * -g` or pnpm is a `.cmd` batch file, which Node refuses to spawn without `shell: true` (EINVAL since CVE-2024-27980); a shell
 * is no option, as cmd.exe would read `%`, `^`, `&` and quotes in the JSON and prompts the arguments carry. So the batch file
 * is read for the program it starts: a `.js` entry through this Node, or an `.exe`. A native install (`claude.exe`) needs none
 * of this; `npm.cmd` and `npx.cmd` are batch files of another shape (`nodeShimEntry`). The rules are `os/rules.ts`'s; this
 * module gives them the real files and this Node
 */

type Deps = {
  platform: NodeJS.Platform
  read: (path: string) => string
  exists: (path: string) => boolean
  node: string
  runJs?: (script: string) => string | null
}

/**
 * A script run, its answer remembered per script for `ttlMs`; a miss (null) is asked again. The one script that is run this way
 * asks npm's shim for the global prefix, and each ask starts a Node process the host waits for on its event loop (#2487); the
 * prefix changes only when the person moves it, so a few minutes of memory is no stale answer anyone would see
 */
export function rememberedRunJs(run: (script: string) => string | null, ttlMs: number, now: () => number = Date.now): (script: string) => string | null {
  const seen = new Map<string, { at: number; out: string }>()
  return (script) => {
    const hit = seen.get(script)
    if (hit && now() - hit.at < ttlMs) return hit.out
    const out = run(script)
    if (out !== null) seen.set(script, { at: now(), out })
    return out
  }
}

const runNodeScript = rememberedRunJs((script) => {
  try {
    return execFileSync(process.execPath, [script], { encoding: 'utf8', timeout: 10_000, windowsHide: true })
  } catch {
    return null
  }
}, 5 * 60_000)

const realDeps = (): Deps => ({
  platform: process.platform,
  read: (path) => readFileSync(path, 'utf8'),
  exists: existsSync,
  node: process.execPath,
  runJs: runNodeScript,
})

const ruleDeps = (deps: Deps): LaunchDeps => ({ ...deps, family: familyOf(deps.platform) })

export function launchFor(path: string, deps: Deps = realDeps()): ToolLaunch {
  return rulesLaunchFor(path, ruleDeps(deps))
}

export function nodeShimEntry(text: string, dir: string, deps: Pick<Deps, 'exists' | 'runJs'>): string | null {
  return rulesNodeShimEntry(text, dir, deps)
}

/**
 * How to start `command` (a manifest's, a person's) from `cwd` (`resolveCommand` in `os/rules.ts`, #849): on Windows a path is
 * read from `cwd` and tried with PATHEXT, a bare name is found on PATH, a batch shim becomes what it starts
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
 * A program the host runs by name in a project folder (`git`, `gh`), as a path to spawn. Off Windows the name. On Windows the
 * absolute path found on PATH, as a bare name makes process creation look in the child's working directory before PATH (libuv's
 * `search_path`, as cmd.exe does): a `git.exe` committed at a repository's root would have run on the first status read of a
 * new project (#14). A found path is remembered, a miss asked again so a git installed while the app runs is found. Never a
 * `.cmd` or `.bat` (#849): Node refuses to spawn one (EINVAL), so a `gh.cmd` first on PATH made every call throw; it is taken
 * as the `.exe` it starts (a package manager's shim) or else the first `.exe` on PATH. With neither, never the bare name, which
 * would run a `git.exe` planted in the project: the answer is the `.exe` beside that `.cmd`, which is not there, so the spawn
 * reports it missing (ENOENT, `gitBranchPr`'s 'unavailable') and is not remembered. Nor when nothing is found (#838):
 * `notOnPath`; the bare name as the answer ran a project's own `git.exe` or `gh.exe` on a machine without them, before the
 * project was trusted
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
  const { path, found } = programFor(name, family, find, launch, process.env)
  if (found) programs.set(name, path)
  return path
}

export function notOnPath(name: string, env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): string {
  return rulesNotOnPath(name, env, familyOf(platform))
}

export function toolCommand(
  name: string,
  platform: NodeJS.Platform = process.platform,
  find: (name: string) => string | null = (n) => whichTool(n),
): string {
  return find(name) ?? notOnPath(name, process.env, platform)
}

export function toolLaunch(name: string): ToolLaunch {
  return launchFor(toolCommand(name))
}

const programs = new Map<string, string>()

export function __forgetPrograms(): void {
  programs.clear()
}

/**
 * The one path the Claude Agent SDK accepts as `pathToClaudeCodeExecutable`: it runs a `.js` through Node and anything else
 * directly, so a shim becomes its entry or executable
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
