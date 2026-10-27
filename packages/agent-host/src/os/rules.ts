import { posix, win32, type PlatformPath } from 'node:path'

/**
 * The OS layer's rules for a family of operating systems, as pure functions (#1599, docs/plans/os-layer.md §7.1).
 *
 * Each rule answers for the family it is given, never for the OS this code runs on: nothing here reads the OS, so
 * the in-memory OS (`memory.ts`) follows Windows' rules on Linux with the very definitions the real one uses
 * (`real.ts`, and the layer modules `os.ts`, `env-path.ts`, `tool-launch.ts`, `kill-tree.ts` that it is built from).
 * Only the layer maps the running OS to its family (`familyOf` in `os.ts`); code outside it asks `Os.traits` and
 * the `Os` it was given, not the family.
 *
 * `posix` is the rules of Linux. macOS differs in a few (its default volume ignores case, `clonesFiles`); the real
 * `Os` answers those for macOS, the in-memory one does not model them.
 */
export type OsFamily = 'windows' | 'posix'

/** Node's path functions for the family: backslashes, drive letters and shares for Windows; slashes elsewhere */
export function pathRules(family: OsFamily): PlatformPath {
  return family === 'windows' ? win32 : posix
}

/**
 * The questions named for what differs (docs/architecture.md §2), answered once for each family. `os.ts`'s
 * functions of the same names read this table for the running OS; the in-memory OS reads it for the family it
 * models. `clonesFiles` is macOS's alone (APFS), so false for both here; the real `Os` answers it for macOS.
 */
export type OsTraits = {
  /** File names that differ only by case are one file: compare paths after folding case (`pathKey`) */
  readonly foldsPathCase: boolean
  /** A child started in a group of its own can be signalled as one (`detached`), and swept by it once it ends */
  readonly hasProcessGroups: boolean
  /** A running program's file cannot be deleted, so a program an update will replace is not run in place */
  readonly locksRunningPrograms: boolean
  /** A watched folder's parents cannot be moved: a project is watched by one recursive watch on its root */
  readonly locksWatchedFolders: boolean
  /** Copying a folder (`cp` with `verbatimSymlinks`) keeps a link as a link; on Windows a junction is copied as its target */
  readonly cpKeepsLinks: boolean
  /** A folder can be cloned with `cp -c` (APFS clonefile) */
  readonly clonesFiles: boolean
  /** Folder sizes come from `du` */
  readonly measuresWithDu: boolean
  /** `ps` and `lsof` can be asked about another process */
  readonly hasPs: boolean
  /** A file's mode bits decide which accounts may read it */
  readonly modesGuardFiles: boolean
  /** A file name has to pass Windows' rules (`nul`, `aux.c`, a trailing dot, `name:stream`) */
  readonly hasWindowsFileNames: boolean
}

const TRAITS: Record<OsFamily, OsTraits> = {
  windows: {
    foldsPathCase: true,
    hasProcessGroups: false,
    locksRunningPrograms: true,
    locksWatchedFolders: true,
    cpKeepsLinks: false,
    clonesFiles: false,
    measuresWithDu: false,
    hasPs: false,
    modesGuardFiles: false,
    hasWindowsFileNames: true,
  },
  posix: {
    foldsPathCase: false,
    hasProcessGroups: true,
    locksRunningPrograms: false,
    locksWatchedFolders: false,
    cpKeepsLinks: true,
    clonesFiles: false,
    measuresWithDu: true,
    hasPs: true,
    modesGuardFiles: true,
    hasWindowsFileNames: false,
  },
}

export function traitsOf(family: OsFamily): OsTraits {
  return TRAITS[family]
}

/**
 * The form two spellings of one path share: resolved, without a trailing separator, and on Windows in one case with
 * one kind of separator. Not the real spelling (that is `realpathSync.native`'s): a key to compare and to index by.
 */
export function pathKey(path: string, family: OsFamily): string {
  const p = pathRules(family)
  let full = p.resolve(path)
  const root = p.parse(full).root
  while (full.length > root.length && (full.endsWith(p.sep) || full.endsWith('/'))) full = full.slice(0, -1)
  return traitsOf(family).foldsPathCase ? full.toLowerCase() : full
}

/** The same file system entry by name (not through links): `samePath('C:\\A\\', 'c:/a', 'windows')` */
export function samePath(a: string, b: string, family: OsFamily): boolean {
  return pathKey(a, family) === pathKey(b, family)
}

/**
 * Whether `candidate` is `root` or lies inside it, by segment: `/a/wt-old` is not inside `/a/wt`, `..cache` is a
 * name, another drive or share is outside. On Windows case does not count (`relative` folds it). Both are taken as
 * written: canonicalize them first where a link or a short name could make one path look like two.
 */
export function isInside(root: string, candidate: string, family: OsFamily): boolean {
  const p = pathRules(family)
  const rel = p.relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel))
}

type Env = Readonly<Record<string, string | undefined>>

/**
 * An environment variable. Windows reads names in any case, and a copy of its environment (`{ ...process.env }`, an
 * app's environment) is a plain object that keeps the spelling Windows stored, which is usually `Path`; an exact
 * match wins.
 */
export function envValue(env: Env, name: string, family: OsFamily): string | undefined {
  if (env[name] !== undefined || family !== 'windows') return env[name]
  const upper = name.toUpperCase()
  const key = Object.keys(env).find((k) => k.toUpperCase() === upper)
  return key === undefined ? undefined : env[key]
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
 * in a project's folder, where a planted `taskkill.exe` would run. A `SystemRoot` that is not a whole path from a
 * drive's root is not used (an empty one made `System32\taskkill.exe` relative to the working directory, #428).
 */
export function systemTool(segments: readonly string[], env: Env): string {
  const root = envValue(env, 'SystemRoot', 'windows')
  return win32.join(driveAbsolute(root) ? root : DEFAULT_SYSTEM_ROOT, 'System32', ...segments)
}

/** `%ComSpec%` when it is a whole path from a drive's root, else cmd.exe under `systemTool` (the same rule) */
export function commandInterpreter(env: Env): string {
  const comSpec = envValue(env, 'ComSpec', 'windows')
  return driveAbsolute(comSpec) ? comSpec : systemTool(['cmd.exe'], env)
}

/**
 * What is started on Windows for a program that is not on PATH: a path under `%SystemRoot%\System32` that only an
 * administrator can make, so the start reports the program missing (ENOENT, which every caller reads as "not
 * installed") and Windows looks for it nowhere else. Given the bare name, Windows looks in the child's working folder
 * before PATH: a `git.exe` committed in a project ran whenever git itself was not installed (#838).
 */
export function notOnPath(name: string, env: Env): string {
  return systemTool(['centralu-not-on-path', `${name}.exe`], env)
}

/**
 * A program the host runs by name in a project's folder (`git`, `gh`), as the path to start (`programPath` in
 * tool-launch.ts, which remembers what it found). Elsewhere than Windows, the name: the start searches PATH and nothing
 * else. On Windows the absolute path found on PATH, never a batch file (Node refuses to start one): a `.cmd` is taken
 * as the `.exe` it starts, or else the first `.exe` on PATH, or else the `.exe` beside it (missing, so the start says
 * so); with nothing found, `notOnPath`. Never the bare name, which Windows would look up in the project first.
 */
export function programFor(
  name: string,
  family: OsFamily,
  find: (name: string, pathExt?: string) => string | null,
  launch: (path: string) => ToolLaunch,
  env: Env,
): { path: string; found: boolean } {
  if (family !== 'windows') return { path: name, found: false }
  let found = find(name)
  if (found && /\.(cmd|bat)$/i.test(found)) {
    const batch = found
    const started = launch(batch)
    found = started.args.length === 0 && /\.(exe|com)$/i.test(started.command) ? started.command : find(name, '.COM;.EXE')
    if (!found) return { path: win32.join(win32.dirname(batch), `${name}.exe`), found: false }
  }
  return found ? { path: found, found: true } : { path: notOnPath(name, env), found: false }
}

/** The separator of a PATH list */
export function pathListSeparator(family: OsFamily): string {
  return pathRules(family).delimiter
}

/** What Windows assumes when PATHEXT is not set */
export const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

/**
 * A tool's path on PATH (the job of `which`), or null. `exists` says whether a name is there.
 *
 * **Windows** finds a command by trying each PATHEXT extension in each folder, never by its bare name: `npm i -g`
 * writes `claude` (a sh script, for Git Bash), `claude.cmd` and `claude.ps1` side by side, and only the `.cmd` is
 * something Windows can start (#14). Extensions are lowercased: NTFS ignores case, and `claude.cmd` is the name npm
 * wrote. Only absolute entries are searched (a relative one is read from the working folder, which may be a cloned
 * repository), and an entry is read without its quotes (`"C:\Program Files\Git\cmd"`), as Windows reads it.
 */
export function findOnPath(name: string, env: Env, family: OsFamily, exists: (path: string) => boolean): string | null {
  if (family === 'windows') {
    const exts = /\.[^\\/.]+$/.test(name)
      ? ['']
      : (envValue(env, 'PATHEXT', family) || DEFAULT_PATHEXT)
          .split(';')
          .filter(Boolean)
          .map((e) => e.toLowerCase())
    for (const entry of (envValue(env, 'PATH', family) ?? '').split(';')) {
      const dir = entry.replaceAll('"', '')
      if (!dir || !win32.isAbsolute(dir)) continue
      for (const ext of exts) {
        const candidate = win32.join(dir, name + ext)
        if (exists(candidate)) return candidate
      }
    }
    return null
  }
  for (const dir of (env.PATH ?? '').split(posix.delimiter)) {
    if (!dir) continue
    const candidate = posix.join(dir, name)
    if (exists(candidate)) return candidate
  }
  return null
}

/** How to start a found tool: a program and the arguments that go before the tool's own */
export type ToolLaunch = { command: string; args: string[] }

export type LaunchDeps = {
  family: OsFamily
  read: (path: string) => string
  exists: (path: string) => boolean
  /** The Node that runs a `.js` entry: the host's own */
  node: string
  /** Run a `.js` with that Node and return its stdout, or null when it fails (npm's prefix lookup) */
  runJs?: (script: string) => string | null
}

/**
 * A batch shim may start another one (#849): Yarn v1's global bin is one line whose target is npm's cmd-shim. Followed
 * up to this many shims deep, so a loop of shims ends.
 */
const MAX_SHIM_DEPTH = 3

/**
 * How to start a tool `findOnPath` found (#14). Elsewhere than Windows, the path itself. On Windows a tool installed
 * with `npm i -g` (or pnpm) is a `.cmd` batch file, and Node refuses to start a `.bat` or `.cmd` without a shell
 * (EINVAL since the CVE-2024-27980 fix). A shell is no option: the arguments carry JSON and prompts, which cmd.exe
 * would read as its own. So the batch file is read for the program it starts, and that is started instead: a `.js`
 * entry through this same Node, an `.exe` directly. `npm.cmd` and `npx.cmd` are batch files of another shape
 * (`nodeShimEntry`), read the same way.
 */
export function launchFor(path: string, deps: LaunchDeps, depth = 0): ToolLaunch {
  const plain = { command: path, args: [] }
  if (deps.family !== 'windows' || !/\.(cmd|bat)$/i.test(path)) return plain
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
  if (/\.(cmd|bat)$/i.test(target) && depth + 1 < MAX_SHIM_DEPTH) {
    const inner = launchFor(target, deps, depth + 1)
    if (inner.command !== target) return inner
  }
  return plain
}

/**
 * The file a package manager's batch shim starts, relative to the shim's folder.
 *
 * Both shapes in use name it as a quoted path off the shim's own folder, next to an optional `node.exe` in that
 * folder (used when one sits beside the shim):
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
 * Those two are not cmd-shim output. They set variables and start the last of them, so the quoted paths `shimTarget`
 * looks for are not there (read on Windows 11 with Node 24.21, 2026-10-08):
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
 * The middle part is followed too: after `npm i -g npm`, the npm in the global prefix is the one the shim runs, and it
 * is the one the person's own terminal runs. A prefix that cannot be asked for falls back to the npm beside Node, which
 * is what the shim does as well.
 */
export function nodeShimEntry(text: string, dir: string, deps: Pick<LaunchDeps, 'exists' | 'runJs'>): string | null {
  const started = /^\s*"%NODE_EXE%"\s+"%(\w+)%"\s+%\*\s*$/m.exec(text)?.[1]
  if (!started) return null
  const set = (name: string) => new RegExp(`^\\s*SET\\s+"${name}=%~dp0\\\\?([^"%]+)"`, 'im').exec(text)?.[1]?.trim() ?? null
  const relative = set(started)
  if (!relative) return null
  const base = win32.resolve(dir, relative)
  const prefixJs = set('NPM_PREFIX_JS')
  if (!prefixJs || !deps.runJs) return base
  const prefix = deps.runJs(win32.resolve(dir, prefixJs))?.trim().split(/\r?\n/).pop()?.trim()
  if (!prefix) return base
  const global = win32.join(prefix, 'node_modules', 'npm', 'bin', win32.basename(base))
  return deps.exists(global) ? global : base
}

/**
 * A command as Windows would start it, from the folder `cwd` it will run in (#849): a path (`bin/server`,
 * `.\run.cmd`) is read from `cwd` and, without an extension, tried with PATHEXT as cmd.exe does; a bare name is found
 * on PATH; a batch shim becomes what it starts. Elsewhere, the command as given (the start searches PATH itself).
 */
export function resolveCommand(command: string, env: Env, deps: LaunchDeps, cwd?: string): ToolLaunch {
  if (deps.family !== 'windows') return { command, args: [] }
  if (/[\\/]/.test(command)) {
    const path = cwd === undefined ? command : win32.resolve(cwd, command)
    return launchFor(withPathExt(path, env, deps) ?? path, deps)
  }
  const found = findOnPath(command, env, 'windows', deps.exists)
  return found ? launchFor(found, deps) : { command, args: [] }
}

/** A Windows path without an extension, with the first PATHEXT extension that exists; null when it has one or none fits */
function withPathExt(path: string, env: Env, deps: Pick<LaunchDeps, 'exists'>): string | null {
  if (/\.[^\\/.]+$/.test(win32.basename(path))) return null
  const pathExt = envValue(env, 'PATHEXT', 'windows') || DEFAULT_PATHEXT
  for (const ext of pathExt.split(';').filter(Boolean)) {
    const candidate = path + ext.toLowerCase()
    if (deps.exists(candidate)) return candidate
  }
  return null
}

/**
 * A `file:` URL's path by the family's rules (Node's `fileURLToPath` with `{ windows }`): `file:///C:/a%20b` is
 * `C:\a b` on Windows, and a host other than `localhost` is a share (`\\host\share`); elsewhere a host is refused.
 */
export function fileUrlToPath(url: string | URL, family: OsFamily): string {
  const u = typeof url === 'string' ? new URL(url) : url
  if (u.protocol !== 'file:') throw Object.assign(new TypeError('The URL must be of scheme file'), { code: 'ERR_INVALID_URL_SCHEME' })
  const host = u.hostname === 'localhost' ? '' : u.hostname
  if (/%2f/i.test(u.pathname) || (family === 'windows' && /%5c/i.test(u.pathname))) {
    throw Object.assign(new TypeError('File URL path must not include encoded \\ or / characters'), { code: 'ERR_INVALID_FILE_URL_PATH' })
  }
  const pathname = decodeURIComponent(u.pathname)
  if (family !== 'windows') {
    if (host !== '') throw Object.assign(new TypeError(`File URL host must be "localhost" or empty on ${family}`), { code: 'ERR_INVALID_FILE_URL_HOST' })
    return pathname
  }
  const backslashed = pathname.replaceAll('/', '\\')
  if (host !== '') return `\\\\${u.hostname}${backslashed}`
  const letter = backslashed.codePointAt(1)! | 0x20
  if (!(letter >= 0x61 && letter <= 0x7a) || backslashed[2] !== ':') {
    throw Object.assign(new TypeError('File URL path must be absolute'), { code: 'ERR_INVALID_FILE_URL_PATH' })
  }
  return backslashed.slice(1)
}

/** A path's `file:` URL by the family's rules (Node's `pathToFileURL` with `{ windows }`), resolved first */
export function pathToFileUrl(path: string, family: OsFamily): URL {
  const p = pathRules(family)
  if (family === 'windows' && path.startsWith('\\\\')) {
    const [host = '', ...rest] = path.slice(2).split(/[\\/]/)
    const url = new URL('file://')
    url.hostname = host
    url.pathname = rest.map(encodePathSegment).join('/')
    return url
  }
  let resolved = p.resolve(path)
  if ((path.endsWith(p.sep) || path.endsWith('/')) && !resolved.endsWith(p.sep)) resolved += p.sep
  const segments = (family === 'windows' ? resolved.replaceAll('\\', '/') : resolved).split('/')
  const encoded = segments.map(encodePathSegment).join('/')
  return new URL(`file://${family === 'windows' ? '/' : ''}${encoded}`)
}

/** A path segment as a URL writes it: what `new URL` would read as syntax is escaped */
function encodePathSegment(segment: string): string {
  return segment.replace(/[%\\\n\r\t#?]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
}
