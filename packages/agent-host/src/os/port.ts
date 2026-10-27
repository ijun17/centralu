/**
 * The OS as the host is given it (#1599, docs/plans/os-layer.md §7.1): files, paths, processes, the environment and the
 * clock, as an interface with a real implementation (`real.ts`, the OS layer) and one in memory (`memory.ts`) that
 * follows Windows' or POSIX rules on any OS.
 *
 * Code behind it does not import `node:fs`, `node:child_process`, `node:os` or `node:path` (`local/os-imports`), and
 * does not ask which OS it is on: it asks `traits`. Its logic tests then run on `memoryOs({ as: 'windows' })` on
 * Linux, and leave the Windows job; a few tests on the real OS stay for what only the OS can answer.
 *
 * The shapes follow Node's own (`readFileSync`, `fs.promises.readFile`, a `ChildProcess`'s events), so moving a module
 * behind it is a change of where the call goes, not of what it means. What differs from Node is said where it is.
 * Types only: importing this runs nothing.
 */
import type Database from 'better-sqlite3'
import type { PlatformPath } from 'node:path'
import type { Duplex, Readable, Writable } from 'node:stream'
import type { OsTraits, ToolLaunch } from './rules.js'

export type { OsFamily, OsTraits, ToolLaunch } from './rules.js'

/** A path in the OS's own form (backslashes and a drive on Windows). The wire form is `protocol/paths.ts`'s. */
export type HostPath = string

export type Env = Record<string, string | undefined>

/**
 * A file system failure, as Node's: `code` is the errno name (`ENOENT`, `EEXIST`, `ENOTDIR`, `EISDIR`, `ENOTEMPTY`,
 * `EXDEV`, `EBUSY`, `EPERM`, `EACCES`, `EINVAL`, `ELOOP`), and callers match on it. Which code a refusal has differs by
 * OS (removing a folder with `unlink` is `EPERM` on Windows, `EISDIR` on Linux), and the in-memory OS gives each
 * family's.
 */
export type OsError = Error & { code: string; syscall?: string; path?: string; dest?: string }

/** What `stat` and `lstat` answer. `dev` and `ino` are always bigints (Node's `{ bigint: true }`), sizes and times numbers. */
export interface OsStats {
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
  readonly size: number
  readonly mode: number
  readonly uid: number
  readonly nlink: number
  readonly dev: bigint
  readonly ino: bigint
  readonly atimeMs: number
  readonly mtimeMs: number
  /** The modification time in nanoseconds, for a change stamp finer than milliseconds */
  readonly mtimeNs: bigint
  readonly ctimeMs: number
  readonly birthtimeMs: number
}

/**
 * An entry of a folder listing. A link here is whatever the folder says is one: on Windows any reparse point, a
 * junction included, which `lstat` may describe as a folder.
 */
export interface OsDirent {
  readonly name: string
  /** The folder it was listed in (with `recursive`, the subfolder) */
  readonly parentPath: string
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

/** `symlink`'s kind: Windows needs to know a folder from a file; `junction` is Windows' folder link that needs no right */
export type LinkKind = 'file' | 'dir' | 'junction'

export type MkdirOptions = { recursive?: boolean; mode?: number }
export type WriteOptions = { mode?: number; flag?: 'w' | 'wx' | 'a' | 'ax' }
export type RmOptions = { recursive?: boolean; force?: boolean; maxRetries?: number; retryDelay?: number }
/** `cp`: `verbatimSymlinks` keeps a link's target as written; on Windows a junction is still copied as its target (`traits.cpKeepsLinks`) */
export type CopyTreeOptions = { recursive?: boolean; verbatimSymlinks?: boolean; preserveTimestamps?: boolean; force?: boolean; errorOnExist?: boolean }
/** Open flags by name, or a number from `files.constants` (`O_RDONLY | O_NOFOLLOW`; on Windows `O_NOFOLLOW` and `O_NONBLOCK` are 0) */
export type OpenFlags = 'r' | 'r+' | 'w' | 'wx' | 'a' | 'ax' | number

export interface OsFileHandle {
  readonly fd: number
  stat(): Promise<OsStats>
  read(buffer: Uint8Array, offset: number, length: number, position: number | null): Promise<{ bytesRead: number }>
  write(data: string | Uint8Array): Promise<void>
  chmod(mode: number): Promise<void>
  close(): Promise<void>
}

/** A watch on a folder: `listener(event, name)`, `name` relative to the folder with the OS's separators, or null */
export interface OsWatcher {
  close(): void
  on(event: 'error', listener: (error: Error) => void): this
}
export type WatchListener = (event: 'rename' | 'change', name: string | null) => void

export interface OsFileConstants {
  readonly O_RDONLY: number
  readonly O_WRONLY: number
  readonly O_RDWR: number
  readonly O_CREAT: number
  readonly O_EXCL: number
  readonly O_TRUNC: number
  readonly O_APPEND: number
  /** 0 on Windows, which has no such flag: there a caller walks the links itself */
  readonly O_NOFOLLOW: number
  /** 0 on Windows */
  readonly O_NONBLOCK: number
  readonly COPYFILE_EXCL: number
}

/**
 * The files, synchronous, under Node's names. Where Node's behaviour differs by OS (a folder held open by a running
 * process, a file replaced while open, a junction), the real one is Node's and the in-memory one models the family's
 * as measured (docs/plans/os-layer.md §7.1).
 */
export interface OsFiles {
  readonly constants: OsFileConstants
  existsSync(path: HostPath): boolean
  statSync(path: HostPath): OsStats
  statSync(path: HostPath, options: { throwIfNoEntry: false }): OsStats | undefined
  lstatSync(path: HostPath): OsStats
  lstatSync(path: HostPath, options: { throwIfNoEntry: false }): OsStats | undefined
  readdirSync(path: HostPath, options?: { recursive?: boolean }): string[]
  readdirSync(path: HostPath, options: { withFileTypes: true; recursive?: boolean }): OsDirent[]
  readFileSync(path: HostPath): Buffer
  readFileSync(path: HostPath, encoding: 'utf8'): string
  writeFileSync(path: HostPath, data: string | Uint8Array, options?: WriteOptions): void
  appendFileSync(path: HostPath, data: string | Uint8Array, options?: { mode?: number }): void
  mkdirSync(path: HostPath, options?: MkdirOptions): void
  /** A new folder whose name is `prefix` and six random characters; answers its path */
  mkdtempSync(prefix: HostPath): HostPath
  renameSync(from: HostPath, to: HostPath): void
  copyFileSync(from: HostPath, to: HostPath, mode?: number): void
  cpSync(from: HostPath, to: HostPath, options?: CopyTreeOptions): void
  unlinkSync(path: HostPath): void
  rmdirSync(path: HostPath): void
  rmSync(path: HostPath, options?: RmOptions): void
  symlinkSync(target: string, path: HostPath, kind?: LinkKind): void
  readlinkSync(path: HostPath): string
  /** Through every link, spelled as given where no link was (Node's JS `realpathSync`) */
  realpathSync(path: HostPath): HostPath
  /** Through every link, spelled as the OS stores it: the case on disk, a short name long (`realpathSync.native`) */
  realpathNativeSync(path: HostPath): HostPath
  /** A hard link: `EEXIST` when `to` is taken, the way to claim a name once */
  linkSync(existing: HostPath, to: HostPath): void
  chmodSync(path: HostPath, mode: number): void
  utimesSync(path: HostPath, atime: number | Date, mtime: number | Date): void
  openSync(path: HostPath, flags: OpenFlags, mode?: number): number
  readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null): number
  writeSync(fd: number, data: string | Uint8Array): number
  fstatSync(fd: number): OsStats
  fchmodSync(fd: number, mode: number): void
  closeSync(fd: number): void
  /** A file read as a stream (a record file too large to read whole) */
  createReadStream(path: HostPath, options?: { encoding?: 'utf8'; start?: number; end?: number }): Readable
  /**
   * A watch on a folder. `recursive` watches below it too; on Windows that is the one watch a project gets, since a
   * watched folder's parents cannot be moved there (`traits.locksWatchedFolders`).
   */
  watch(path: HostPath, options: { recursive?: boolean }, listener: WatchListener): OsWatcher
  /** The same operations, not blocking the host, under `node:fs/promises`' names */
  readonly promises: OsFilesAsync
}

export interface OsFilesAsync {
  access(path: HostPath): Promise<void>
  stat(path: HostPath): Promise<OsStats>
  lstat(path: HostPath): Promise<OsStats>
  readdir(path: HostPath, options?: { recursive?: boolean }): Promise<string[]>
  readdir(path: HostPath, options: { withFileTypes: true; recursive?: boolean }): Promise<OsDirent[]>
  readFile(path: HostPath): Promise<Buffer>
  readFile(path: HostPath, encoding: 'utf8'): Promise<string>
  writeFile(path: HostPath, data: string | Uint8Array, options?: WriteOptions): Promise<void>
  appendFile(path: HostPath, data: string | Uint8Array, options?: { mode?: number }): Promise<void>
  mkdir(path: HostPath, options?: MkdirOptions): Promise<void>
  mkdtemp(prefix: HostPath): Promise<HostPath>
  rename(from: HostPath, to: HostPath): Promise<void>
  copyFile(from: HostPath, to: HostPath, mode?: number): Promise<void>
  cp(from: HostPath, to: HostPath, options?: CopyTreeOptions): Promise<void>
  unlink(path: HostPath): Promise<void>
  rmdir(path: HostPath): Promise<void>
  rm(path: HostPath, options?: RmOptions): Promise<void>
  symlink(target: string, path: HostPath, kind?: LinkKind): Promise<void>
  readlink(path: HostPath): Promise<string>
  /** As `realpathNativeSync` (Node's promise `realpath` is the native one) */
  realpath(path: HostPath): Promise<HostPath>
  link(existing: HostPath, to: HostPath): Promise<void>
  chmod(path: HostPath, mode: number): Promise<void>
  utimes(path: HostPath, atime: number | Date, mtime: number | Date): Promise<void>
  open(path: HostPath, flags: OpenFlags, mode?: number): Promise<OsFileHandle>
}

/**
 * The OS's path rules. `path` is Node's `win32` or `posix` for the OS (join, resolve, relative, dirname, basename,
 * parse, sep, delimiter); relative paths resolve from the host's working folder only through `env.cwd()`, which
 * `resolve` with no absolute part reads.
 */
export interface OsPaths {
  readonly path: PlatformPath
  /** The null device (`\\.\nul`, `/dev/null`): what git's `core.hooksPath` is set to so no hook runs */
  readonly devNull: HostPath
  /** Two spellings of one path, by name: case folded where the OS folds it (`traits.foldsPathCase`) */
  same(a: HostPath, b: HostPath): boolean
  /** `candidate` is `root` or inside it, by segment and the OS's case rule */
  inside(root: HostPath, candidate: HostPath): boolean
  /** A key to compare or index paths by (resolved, no trailing separator, case folded where the OS folds it) */
  key(path: HostPath): string
  fromFileUrl(url: string | URL): HostPath
  toFileUrl(path: HostPath): URL
}

/** How a child ended. A child the host stopped on Windows ends with code 1 and no signal (`taskkill /F`). */
export type OsExit = { code: number | null; signal: NodeJS.Signals | null }

/**
 * One of the child's standard streams: a pipe to the host, nothing, an extra duplex pipe (`'overlapped'`: the apps'
 * broker channel on fd 3), or a file the host opened (`openSync`), which the child writes into.
 */
/** `'inherit'`: the host's own (a child whose output is the host's log); in memory, discarded */
export type OsStdio = 'pipe' | 'ignore' | 'inherit' | 'overlapped' | number

export type StartOptions = {
  cwd?: HostPath
  /** The child's whole environment; default the host's (`env.all()`) */
  env?: Env
  /** One entry per fd from 0; default three pipes */
  stdio?: readonly OsStdio[]
  /**
   * Contained (the default): the root of a tree the host can end and sweep. On POSIX the child leads a process
   * group of its own (`detached`); on Windows it is started attached, and its leftovers are found by parent links
   * after it ends. Always without a window on Windows. `false` starts it in the host's group.
   */
  contained?: boolean
}

/**
 * A started child, as Node's `ChildProcess` describes one, so its callers keep their code: `'spawn'`, `'exit'` (code,
 * signal), `'close'` (after its output ended) and `'error'` (it could not be started: `ENOENT`, `EACCES`, or `EINVAL`
 * for a Windows batch file, which Node throws at once and this answers as an event like the others). `exited`
 * settles once with `'exit'`'s values, or with `{ code: null, signal: null }` and `error` when it never started.
 */
export interface OsChild {
  readonly pid: number | undefined
  /** When the host asked for it, taken before the start: no later than the process's own creation (the orphan sweep needs that) */
  readonly spawnedAt: number
  readonly stdin: Writable | null
  readonly stdout: Readable | null
  readonly stderr: Readable | null
  /** By fd; `stdio[3]` is the `'overlapped'` duplex when asked for */
  readonly stdio: ReadonlyArray<Readable | Writable | Duplex | null>
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  readonly killed: boolean
  readonly exited: Promise<OsExit & { error?: OsError }>
  /** One signal to this process alone (Node's `kill`); on Windows any signal ends it. `stop` ends a tree. */
  kill(signal?: NodeJS.Signals): boolean
  /** The host may end while this runs (Node's `unref`); in memory, nothing */
  unref(): void
  on(event: 'spawn', listener: () => void): this
  on(event: 'exit' | 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  on(event: 'error', listener: (error: OsError) => void): this
  once(event: 'spawn', listener: () => void): this
  once(event: 'exit' | 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  once(event: 'error', listener: (error: OsError) => void): this
  off(event: 'spawn', listener: () => void): this
  off(event: 'exit' | 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  off(event: 'error', listener: (error: OsError) => void): this
}

export type RunOptions = {
  cwd?: HostPath
  env?: Env
  /** Written to stdin, which is then closed */
  input?: string | Uint8Array
  /** Ended (its whole tree) after this long; the result says `ended: 'timeout'` */
  timeoutMs?: number
  /** Ended once stdout or stderr passes this many bytes; `ended: 'overflow'` */
  maxBuffer?: number
  /** Ended when this aborts; `ended: 'aborted'` */
  signal?: AbortSignal
  /** stdout goes to this file (made 0600) instead of the result */
  stdoutFile?: HostPath
}

export type RunResult = OsExit & {
  stdout: Buffer
  stderr: Buffer
  /** Why the host ended it, when it did */
  ended?: 'timeout' | 'overflow' | 'aborted'
}

export type RunSyncResult = OsExit & { stdout: string; stderr: string; error?: OsError }

export interface OsProcesses {
  /** Starts a child (see `StartOptions`); never throws: a child that could not start emits `'error'` */
  start(command: string, args: readonly string[], options?: StartOptions): OsChild
  /**
   * Runs a program to its end and answers its exit and output, a non-zero exit included; rejects only when it could
   * not be started (`ENOENT`, `EACCES`, `EINVAL`). On a timeout, an overflow or an abort the whole tree is ended
   * (`stop` with a 2 s grace).
   */
  run(command: string, args: readonly string[], options?: RunOptions): Promise<RunResult>
  /** The same, holding the host until it ends (the layer's own `taskkill` and `ps`, a lock's owner): keep these few */
  runSync(command: string, args: readonly string[], options?: Omit<RunOptions, 'signal' | 'stdoutFile'>): RunSyncResult
  /** A command line through the OS's shell (`cmd.exe /d /s /c`, `/bin/sh -c`): a person's own setup command, never built from parts */
  runShell(commandLine: string, options?: Omit<RunOptions, 'stdoutFile'>): Promise<RunResult>
  /**
   * Ends a child and everything it started: on POSIX TERM to every group in its tree, then KILL to what is left after
   * `graceMs`; on Windows at once (`taskkill /T /F`). Then sweeps what it left running (its group, or on Windows the
   * processes it started, by parent links and creation time). Answers how it ended.
   */
  stop(child: OsChild, graceMs: number): Promise<OsExit>
  /** Whether a process with this pid is alive (`process.kill(pid, 0)`; `EPERM` counts as alive) */
  alive(pid: number): boolean
  /**
   * One signal to a process the host did not start, by pid (`process.kill`: a stray from a host before, a lock's
   * owner): false when there is no such process; throws `EPERM`. On Windows any signal ends it.
   */
  signal(pid: number, signal: NodeJS.Signals): boolean
  /** The host's own pid */
  readonly pid: number
}

/**
 * Programs by name, the way the host finds and starts them (`env-path.ts`, `tool-launch.ts`). On Windows a name is
 * never started bare: given one, Windows looks in the child's working folder before PATH.
 */
export interface OsTools {
  /** A tool's path on PATH, with PATHEXT on Windows; null when it is not there */
  find(name: string): HostPath | null
  /** A program the host runs in a project's folder (`git`, `gh`): an absolute path on Windows, never a planted one */
  program(name: string): HostPath
  /** How to start `command` from `cwd`: a batch shim becomes the program it starts */
  resolve(command: string, options?: { cwd?: HostPath; env?: Env }): ToolLaunch
}

export interface OsEnv {
  /** A variable, in any case on Windows (`Path` is `PATH`) */
  get(name: string): string | undefined
  /** A copy of the whole environment, for a child; keys as the OS keeps them */
  all(): Env
  /** Sets one for this host and the children it starts after (the tool PATH at start, `ensureToolPath`) */
  set(name: string, value: string | undefined): void
  readonly home: HostPath
  /** Read when asked: `TMPDIR` (POSIX) or `TEMP` (Windows) as set now */
  readonly temp: HostPath
  /** The Node running the host */
  readonly execPath: HostPath
  readonly username: string
  /** The host's working folder, which a relative path is read from */
  cwd(): HostPath
}

export type Timer = { cancel(): void }

/**
 * Time, for the waits that are about the OS: a grace before a second shot, a retry while Windows holds a file, a poll
 * of a file. A real `setTimeout` does not keep the host alive (`unref`); a `sleep`, awaited, does. In memory, time moves
 * only when a test moves it.
 */
export interface OsClock {
  now(): number
  setTimeout(callback: () => void, ms: number): Timer
  sleep(ms: number, options?: { signal?: AbortSignal }): Promise<void>
}

export type SqliteOptions = { readonly?: boolean; fileMustExist?: boolean; timeout?: number }

/** SQLite (better-sqlite3) on the real OS; in memory, the engine a test gives, whose files are not in the in-memory tree */
export interface OsSqlite {
  /** `':memory:'` opens a database with no file */
  open(path: HostPath, options?: SqliteOptions): Database.Database
}

export interface Os {
  readonly files: OsFiles
  readonly paths: OsPaths
  readonly processes: OsProcesses
  readonly tools: OsTools
  readonly env: OsEnv
  readonly clock: OsClock
  readonly sqlite: OsSqlite
  /** What differs between OSes, by name (`os.ts`); asked instead of which OS this is */
  readonly traits: OsTraits
}
