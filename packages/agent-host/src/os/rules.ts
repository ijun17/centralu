import { posix, win32 } from 'node:path'
import type { PlatformPath } from 'node:path'

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
  /**
   * A tree's links to folders keep their meaning in a copy of it: false on Windows, where pnpm and workspaces link
   * folders by junction, whose target is always a whole path, so the `Os`'s copy keeps them leading into the source
   * unless it is given `links` (`retarget`), as a copy that must stand alone is; a worktree on Windows is copied by
   * dev-services `copyTreeWindows`, by the same rule
   */
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
 * Characters JavaScript's `toUpperCase` maps to one other character but NTFS's case table does not, as code point
 * ranges: measured on Windows 11 (NTFS, 2026-10-27) by making a file under each and asking for it under its upper
 * case. Among them the micro sign, the dotless i (`ı` and `I` are two files), the long s, final sigma, Georgian
 * Mkhedruli and Cherokee small letters: NTFS's table predates their upper cases. A volume keeps the table it was
 * formatted with, so an old volume may differ further; the host only needs the folding to agree with itself and to
 * err towards two names, which these do.
 */
const NTFS_KEEPS_CASE: ReadonlyArray<readonly [number, number]> = [
  [0xb5, 0xb5],
  [0x131, 0x131],
  [0x17f, 0x17f],
  [0x19b, 0x19b],
  [0x1c5, 0x1c5],
  [0x1c8, 0x1c8],
  [0x1cb, 0x1cb],
  [0x1f2, 0x1f2],
  [0x23f, 0x240],
  [0x252, 0x252],
  [0x25c, 0x25c],
  [0x261, 0x261],
  [0x264, 0x266],
  [0x26a, 0x26a],
  [0x26c, 0x26c],
  [0x282, 0x282],
  [0x287, 0x287],
  [0x29d, 0x29e],
  [0x345, 0x345],
  [0x3c2, 0x3c2],
  [0x3d0, 0x3d1],
  [0x3d5, 0x3d6],
  [0x3f0, 0x3f1],
  [0x3f3, 0x3f3],
  [0x3f5, 0x3f5],
  [0x525, 0x52f],
  [0x10d0, 0x10ff],
  [0x13f8, 0x13fd],
  [0x1c80, 0x1c8a],
  [0x1d8e, 0x1d8e],
  [0x1e9b, 0x1e9b],
  [0x1fbe, 0x1fbe],
  [0x2c5f, 0x2c5f],
  [0x2cec, 0x2cf3],
  [0x2d27, 0x2d2d],
  [0xa661, 0xa661],
  [0xa699, 0xa69b],
  [0xa791, 0xa7f6],
  [0xab53, 0xab53],
  [0xab70, 0xabbf],
]

const keepsCase = (code: number) => NTFS_KEEPS_CASE.some(([lo, hi]) => code >= lo && code <= hi)

/**
 * A name in the one case the family compares names in: on Windows each character in its upper case where NTFS has
 * one (NTFS compares names through its upcase table, so `Name.TXT` and `name.txt` are one file, and so are `é` and
 * `É`, while the Kelvin sign and `k`, or `ß` and `SS`, are two), unchanged elsewhere. One character never becomes two.
 * Upper, not lower: the folded names also sort as NTFS lists a folder (`_` after `Z`).
 */
export function foldCase(name: string, family: OsFamily): string {
  if (!traitsOf(family).foldsPathCase) return name
  let out = ''
  for (const c of name) {
    const code = c.codePointAt(0) ?? 0
    const upper = code > 0xffff || keepsCase(code) ? c : c.toUpperCase()
    out += upper.length === c.length ? upper : c
  }
  return out
}

/**
 * The family's path functions resolving relative paths from `cwd` (the `Os`'s own working folder, `env.cwd()`), not
 * from the working folder of the process this code runs in: what the in-memory OS answers for `paths.path`.
 */
export function pathRulesFrom(family: OsFamily, cwd: () => string): PlatformPath {
  const p = pathRules(family)
  const resolve = (...segments: string[]) => p.resolve(cwd(), ...segments)
  const rules: PlatformPath = {
    ...p,
    resolve,
    relative: (from, to) => p.relative(resolve(from), resolve(to)),
    toNamespacedPath: (path) =>
      family === 'windows' && path !== '' ? p.toNamespacedPath(resolve(path)) : path,
  }
  return Object.assign(rules, { [family === 'windows' ? 'win32' : 'posix']: rules })
}

/**
 * A resolved Windows path without its `\\?\` prefix: `\\?\C:\x` names the file `C:\x` does, and `\\?\UNC\s\sh` the
 * share `\\s\sh` (the prefix only tells Win32 to leave the rest alone). Another `\\?\` form (a volume GUID) is kept.
 * Dots and spaces that end a name are not dropped: Node opens every path in its `\\?\` form, so `y.` is a name of its
 * own to it (measured: `readFileSync` of `d\y.\f` and of `d\y\f` read two files).
 */
function withoutVerbatimPrefix(full: string): string {
  const prefix = /^\\\\\?\\/.exec(full)
  if (!prefix) return full
  const unc = /^\\\\\?\\UNC\\/i.exec(full)
  if (unc) return win32.resolve(`\\\\${full.slice(unc[0].length)}`)
  const plain = full.slice(prefix[0].length)
  return /^[A-Za-z]:(\\|$)/.test(plain) ? win32.resolve(plain.length === 2 ? `${plain}\\` : plain) : full
}

/**
 * The form two spellings of one path share: resolved (relative to `cwd`, default this process's working folder),
 * without a trailing separator, and on Windows in one case (`foldCase`) with one kind of separator, the `\\?\` form
 * as the plain one. Not the real spelling (that is
 * `realpathSync.native`'s): a key to compare and to index by.
 */
export function pathKey(path: string, family: OsFamily, cwd?: string): string {
  const p = pathRules(family)
  let full = cwd === undefined ? p.resolve(path) : p.resolve(cwd, path)
  if (family === 'windows') full = withoutVerbatimPrefix(full)
  const root = p.parse(full).root
  while (full.length > root.length && (full.endsWith(p.sep) || full.endsWith('/'))) full = full.slice(0, -1)
  return foldCase(full, family)
}

/** The same file system entry by name (not through links): `samePath('C:\\A\\', 'c:/a', 'windows')` */
export function samePath(a: string, b: string, family: OsFamily, cwd?: string): boolean {
  return pathKey(a, family, cwd) === pathKey(b, family, cwd)
}

/**
 * Whether `candidate` is `root` or lies inside it, by segment: `/a/wt-old` is not inside `/a/wt`, `..cache` is a
 * name, another drive or share is outside. On Windows case does not count, by `foldCase`. Both are taken as written:
 * canonicalize them first where a link or a short name could make one path look like two.
 */
export function isInside(root: string, candidate: string, family: OsFamily, cwd?: string): boolean {
  const sep = pathRules(family).sep
  const r = pathKey(root, family, cwd)
  const c = pathKey(candidate, family, cwd)
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep)
}

/**
 * Where a link copied from the tree `links.from` leads in its copy at `links.to`: a whole `target` inside `from` leads
 * to the same place inside `to`; any other answers null (kept as written, or left out, by the caller). The one rule for
 * the `Os`'s copy (`copy.ts`, its `links` option) and the worktree copy on Windows (dev-services `copyTreeWindows`). By
 * name, as `isInside`: canonicalize both where a link or a short name could make one path look like two.
 */
export function retarget(
  target: string,
  links: { from: string; to: string },
  family: OsFamily,
): string | null {
  if (!isInside(links.from, target, family)) return null
  const p = pathRules(family)
  // `relative` reads a `\\?\` form as another root: both plain
  const plain = (path: string) => (family === 'windows' ? withoutVerbatimPrefix(p.resolve(path)) : path)
  const rest = p.relative(plain(links.from), plain(target))
  return rest === '' ? p.resolve(links.to) : p.join(links.to, rest)
}

type Env = Readonly<Record<string, string | undefined>>

/**
 * An environment variable. Windows reads names in any case, and a copy of its environment (`{ ...process.env }`, an
 * app's environment) is a plain object that keeps the spelling Windows stored, which is usually `Path`; an exact
 * match wins.
 */
export function envValue(env: Env, name: string, family: OsFamily): string | undefined {
  if (env[name] !== undefined || family !== 'windows') return env[name]
  const folded = foldCase(name, family)
  const key = Object.keys(env).find((k) => foldCase(k, family) === folded)
  return key === undefined ? undefined : env[key]
}

/**
 * Signals by family. On Windows Node knows a few names (`os.constants.signals`), and of those only TERM, KILL, INT and
 * QUIT end a process (at once: Windows has no signal a program can trap). Measured on Windows 11 with Node 22: another
 * name Node knows there throws `ENOSYS` from `process.kill` and leaves the process running, while `ChildProcess.kill`
 * ends it reporting SIGKILL; a name Node does not know there (`SIGUSR1`) throws `ERR_UNKNOWN_SIGNAL` from both. The
 * `Os` takes the one rule for both calls: a signal it cannot deliver throws, and never ends anything by accident.
 * Linux's names are delivered; a program may trap all but KILL and STOP, and those in `IGNORED_BY_DEFAULT` end nothing.
 */
const WINDOWS_SIGNAL_NAMES: readonly string[] = [
  'SIGHUP',
  'SIGINT',
  'SIGQUIT',
  'SIGILL',
  'SIGABRT',
  'SIGFPE',
  'SIGKILL',
  'SIGSEGV',
  'SIGTERM',
  'SIGBREAK',
  'SIGWINCH',
]
const WINDOWS_ENDING = new Set<string>(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGQUIT'])
const LINUX_SIGNALS = new Set<string>([
  'SIGHUP',
  'SIGINT',
  'SIGQUIT',
  'SIGILL',
  'SIGTRAP',
  'SIGABRT',
  'SIGIOT',
  'SIGBUS',
  'SIGFPE',
  'SIGKILL',
  'SIGUSR1',
  'SIGSEGV',
  'SIGUSR2',
  'SIGPIPE',
  'SIGALRM',
  'SIGTERM',
  'SIGCHLD',
  'SIGSTKFLT',
  'SIGCONT',
  'SIGSTOP',
  'SIGTSTP',
  'SIGTTIN',
  'SIGTTOU',
  'SIGURG',
  'SIGXCPU',
  'SIGXFSZ',
  'SIGVTALRM',
  'SIGPROF',
  'SIGWINCH',
  'SIGIO',
  'SIGPOLL',
  'SIGPWR',
  'SIGSYS',
])
/** Signals whose default action on Linux is to do nothing (STOP, TSTP, TTIN and TTOU pause a process; not modelled) */
export const IGNORED_BY_DEFAULT: ReadonlySet<string> = new Set(['SIGCHLD', 'SIGCONT', 'SIGURG', 'SIGWINCH'])

/**
 * Why `signal` cannot be sent on the family, as the code of the error the send throws, or null when it is delivered:
 * `ERR_UNKNOWN_SIGNAL` for a name the family's Node does not know, `ENOSYS` (Windows) for one it knows but cannot send.
 * On Windows a delivered signal ends the process.
 */
export function signalRefusal(signal: string, family: OsFamily): 'ERR_UNKNOWN_SIGNAL' | 'ENOSYS' | null {
  if (family === 'windows') {
    if (!WINDOWS_SIGNAL_NAMES.includes(signal)) return 'ERR_UNKNOWN_SIGNAL'
    return WINDOWS_ENDING.has(signal) ? null : 'ENOSYS'
  }
  return LINUX_SIGNALS.has(signal) ? null : 'ERR_UNKNOWN_SIGNAL'
}

/** The error a send `signalRefusal` refuses throws, shaped as Node's own */
export function signalError(signal: string, code: 'ERR_UNKNOWN_SIGNAL' | 'ENOSYS'): Error & { code: string } {
  if (code === 'ERR_UNKNOWN_SIGNAL')
    return Object.assign(new TypeError(`Unknown signal: ${signal}`), { code })
  return Object.assign(new Error('kill ENOSYS'), { code, errno: -4054, syscall: 'kill' })
}

/** How finely a file system keeps a time `utimes` is given */
export type TimePrecision = 'microsecond' | 'nanosecond'

/**
 * What decides how finely a time set with `utimes` is kept is libuv (Node's file layer), not the OS alone: Windows
 * is cut to microseconds on every Node measured (22, 24, 26); POSIX (Linux and macOS alike) is cut to microseconds
 * until libuv 1.52.0 (Node 22.23 ships 1.51.0, Node 24.22 ships 1.52.1), which keeps nanoseconds ("unix: support
 * nanosecond resolution in uv__fs_to_timespec"; measured on macOS with Node 22.23.4, 24.22.2 and 26.12.1). `uv`
 * defaults to the running Node's.
 */
export function timePrecision(family: OsFamily, uv: string = process.versions.uv): TimePrecision {
  if (family === 'windows') return 'microsecond'
  const [major = 0, minor = 0] = uv.split('.').map(Number)
  return major > 1 || (major === 1 && minor >= 52) ? 'nanosecond' : 'microsecond'
}

/**
 * How `rmSync` is made, which decides what it answers to a folder a process works in on Windows (measured on Windows
 * with Node 22.23.4, 23.11.1, 24.22.1 and 26.12.1): `js` (Node 22) walks the tree in JavaScript and gives the system's
 * `EBUSY`; `native` (Node 23 and later; nodejs/node#53617, commit 7168295e7a, "fs: move rmSync implementation to c++")
 * removes it with C++'s `std::filesystem` and gives `EPERM` for the same refusal. `rmdirSync`, `rename` and the promise
 * `rm` give `EBUSY` on every Node. `nodeVersion` defaults to the running Node's.
 */
export function rmSyncImplementation(nodeVersion: string = process.versions.node): 'js' | 'native' {
  return Number(nodeVersion.split('.')[0]) >= 23 ? 'native' : 'js'
}

/**
 * A file time as the family stores what `utimes` is given (seconds, or a `Date`), in nanoseconds, cut from the seconds
 * as libuv does (see `timePrecision`): to whole microseconds from the fraction on POSIX (so a `Date`'s milliseconds
 * come out a nanosecond short), from the whole value on Windows (so they come out exact); or, where nanoseconds are
 * kept, as the double gives them.
 */
export function storedTimeNs(
  time: number | Date,
  family: OsFamily,
  precision: TimePrecision = timePrecision(family),
): bigint {
  const seconds = time instanceof Date ? time.getTime() / 1000 : time
  if (family === 'windows') return BigInt(Math.trunc(seconds * 1e6)) * 1000n
  const whole = Math.trunc(seconds)
  let ns = Math.trunc((seconds - whole) * 1e9)
  if (precision === 'microsecond') ns -= ns % 1000
  return BigInt(whole) * 1_000_000_000n + BigInt(ns)
}

/** A folder entry as a listing describes it, for `listRecursive` */
export type ListedEntry = { readonly name: string; isDirectory(): boolean; isSymbolicLink(): boolean }

/**
 * A folder's recursive listing as the `Os` gives it, from `list` (one folder's entries, in the OS's order): breadth
 * first, as Node's own `readdir({ recursive })` (`a, b, a/x, a/x/f`), each name relative to `root`. It never enters a
 * link: Node does not on POSIX, but on Windows it enters a junction, and a junction to a folder above it made Node's
 * listing stop at some depth without saying so. With the rule here a listing is the same on every OS and ends.
 */
export function listRecursive<E extends ListedEntry>(
  root: string,
  list: (dir: string) => E[],
  join: (...parts: string[]) => string,
): Array<Listed<E>> {
  const walk = recursiveListing<E>(root, join)
  for (let step = walk.next(); ;) {
    if (step.done) return step.value
    step = walk.next(list(step.value))
  }
}

export type Listed<E> = { rel: string; dir: string; entry: E }

/**
 * `listRecursive`'s walk, for a caller that lists a folder asynchronously: it yields each folder to list and is
 * given back its entries, and returns the listing.
 */
export function* recursiveListing<E extends ListedEntry>(
  root: string,
  join: (...parts: string[]) => string,
): Generator<string, Array<Listed<E>>, E[]> {
  const out: Array<Listed<E>> = []
  const queue: Array<{ dir: string; rel: string }> = [{ dir: root, rel: '' }]
  for (let next = queue.shift(); next; next = queue.shift()) {
    const entries: E[] = yield next.dir
    for (const entry of entries) {
      const rel = next.rel === '' ? entry.name : join(next.rel, entry.name)
      out.push({ rel, dir: next.dir, entry })
      if (entry.isDirectory() && !entry.isSymbolicLink()) queue.push({ dir: join(next.dir, entry.name), rel })
    }
  }
  return out
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
    found =
      started.args.length === 0 && /\.(exe|com)$/i.test(started.command)
        ? started.command
        : find(name, '.COM;.EXE')
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
 * The files a start of `path` tries, in order, as libuv's search does: on Windows a name with an extension as written
 * and then with `.com` and `.exe` after it, a name without one only with `.com` and `.exe` (a file `node` with no
 * extension does not start, measured: ENOENT); elsewhere the path itself.
 */
export function programCandidates(path: string, family: OsFamily): string[] {
  if (family !== 'windows') return [path]
  const withExt = /\.[^\\/.]+$/.test(win32.basename(path))
  return [...(withExt ? [path] : []), `${path}.com`, `${path}.exe`]
}

/**
 * A tool's path on PATH (the job of `which`), or null. `exists` says whether a name is there.
 *
 * **Windows** finds a command by trying each PATHEXT extension in each folder, never by its bare name: `npm i -g`
 * writes `claude` (a sh script, for Git Bash), `claude.cmd` and `claude.ps1` side by side, and only the `.cmd` is
 * something Windows can start (#14). Extensions are lowercased: NTFS ignores case, and `claude.cmd` is the name npm
 * wrote. Only absolute entries are searched (a relative one is read from the working folder, which may be a cloned
 * repository), and an entry is read without its quotes (`"C:\Program Files\Git\cmd"`), as Windows reads it.
 */
export function findOnPath(
  name: string,
  env: Env,
  family: OsFamily,
  exists: (path: string) => boolean,
): string | null {
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
    const rel = (m[1] ?? '').trim()
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
export function nodeShimEntry(
  text: string,
  dir: string,
  deps: Pick<LaunchDeps, 'exists' | 'runJs'>,
): string | null {
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
  if (u.protocol !== 'file:')
    throw Object.assign(new TypeError('The URL must be of scheme file'), { code: 'ERR_INVALID_URL_SCHEME' })
  const host = u.hostname === 'localhost' ? '' : u.hostname
  if (/%2f/i.test(u.pathname) || (family === 'windows' && /%5c/i.test(u.pathname))) {
    throw Object.assign(new TypeError('File URL path must not include encoded \\ or / characters'), {
      code: 'ERR_INVALID_FILE_URL_PATH',
    })
  }
  const pathname = decodeURIComponent(u.pathname)
  if (family !== 'windows') {
    if (host !== '')
      throw Object.assign(new TypeError(`File URL host must be "localhost" or empty on ${family}`), {
        code: 'ERR_INVALID_FILE_URL_HOST',
      })
    return pathname
  }
  const backslashed = pathname.replaceAll('/', '\\')
  if (host !== '') return `\\\\${u.hostname}${backslashed}`
  const letter = (backslashed.codePointAt(1) ?? 0) | 0x20
  if (!(letter >= 0x61 && letter <= 0x7a) || backslashed[2] !== ':') {
    throw Object.assign(new TypeError('File URL path must be absolute'), {
      code: 'ERR_INVALID_FILE_URL_PATH',
    })
  }
  return backslashed.slice(1)
}

/** A path's `file:` URL by the family's rules (Node's `pathToFileURL` with `{ windows }`), resolved first */
export function pathToFileUrl(path: string, family: OsFamily): URL {
  const p = pathRules(family)
  // `\\?\UNC\server\share` names the share `\\server\share` does, as Node reads it (only in this case)
  if (family === 'windows' && path.startsWith('\\\\?\\UNC\\'))
    return pathToFileUrl(`\\\\${path.slice('\\\\?\\UNC\\'.length)}`, family)
  if (family === 'windows' && path.startsWith('\\\\')) {
    const [host = '', ...rest] = path.slice(2).split(/[\\/]/)
    const url = new URL('file://')
    url.hostname = host
    url.pathname = rest.map(encodePathSegment).join(URL_SEP)
    return url
  }
  let resolved = p.resolve(path)
  if ((path.endsWith(p.sep) || path.endsWith('/')) && !resolved.endsWith(p.sep)) resolved += p.sep
  const segments = (family === 'windows' ? resolved.replaceAll(win32.sep, URL_SEP) : resolved).split(URL_SEP)
  const encoded = segments.map(encodePathSegment).join(URL_SEP)
  return new URL(`file://${family === 'windows' ? '/' : ''}${encoded}`)
}

/** A URL's path separator, the same on every OS */
const URL_SEP = posix.sep

/** A path segment as a URL writes it: what `new URL` would read as syntax is escaped */
function encodePathSegment(segment: string): string {
  return segment.replace(
    /[%\\\n\r\t#?]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  )
}
