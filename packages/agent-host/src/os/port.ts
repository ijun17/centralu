/**
 * The OS as the host is given it (#1599, docs/plans/os-layer.md §7.1): files, paths, processes, environment and clock as an
 * interface with a real implementation (`real.ts`) and an in-memory one (`memory.ts`) that follows Windows' or POSIX rules on
 * any OS. Code behind it imports no `node:fs`/`child_process`/`os`/`path` (`local/os-imports`) and asks `traits`, not which OS
 * it is. Shapes follow Node's; differences are said where they are
 */
import type Database from 'better-sqlite3'
import type { PlatformPath } from 'node:path'
import type { Duplex, Readable, Writable } from 'node:stream'
import type { OsTraits, ToolLaunch } from './rules.js'

type HostPath = string

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
export type RmOptions = { recursive?: boolean; force?: boolean }
/**
 * `cp`, Node's options: `verbatimSymlinks` keeps a relative link's target as written (without it the copy's link is
 * made whole from the source's folder); `preserveTimestamps` gives a copied file its source's times; an existing file is
 * replaced unless `force` is false, which keeps it or, with `errorOnExist`, throws `ERR_FS_CP_EEXIST`.
 *
 * `links`, the `Os`'s own: the tree this is a copy of and the place the copy will stand once it is in place (which can
 * be another name than the copy's target: copied beside and renamed in). A link whose whole target is inside `from`
 * is made leading to the same place inside `to` (`retarget`), so the copy stands alone; any other keeps its target.
 * Without it every link keeps its target, as Node's `cp` does (which never retargets: without `verbatimSymlinks` it
 * makes a relative target whole into the source, and keeps a whole one as written).
 */
export type CopyTreeOptions = {
  recursive?: boolean
  verbatimSymlinks?: boolean
  preserveTimestamps?: boolean
  force?: boolean
  errorOnExist?: boolean
  links?: { from: string; to: string }
  /**
   * `promises.cp` only, the `Os`'s own: a step that reads a name (a stat, a listing, a link; not a file's copy) that has not
   * answered within this many milliseconds fails the copy with `ETIMEDOUT`, naming it. The step itself goes on in libuv's pool
   * until the OS gives up, so the copy does not hold a caller that cannot wait for a link into a share that does not answer
   * (#1707)
   */
  stepMs?: number
}
/** Open flags by name, or a number from `files.constants` (`O_RDONLY | O_NOFOLLOW`; on Windows `O_NOFOLLOW` and `O_NONBLOCK` are 0) */
export type OpenFlags = 'r' | 'r+' | 'w' | 'wx' | 'a' | 'ax' | number

export interface OsFileHandle {
  readonly fd: number
  stat(): Promise<OsStats>
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ): Promise<{ bytesRead: number }>
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
  readonly O_NOFOLLOW: number
  readonly O_NONBLOCK: number
  readonly COPYFILE_EXCL: number
}

/**
 * The files, synchronous, under Node's names; where Node differs by OS (a folder held open, a file replaced while open, a
 * junction) the in-memory one models the family's as measured (docs/plans/os-layer.md §7.1)
 */
export interface OsFiles {
  readonly constants: OsFileConstants
  existsSync(path: HostPath): boolean
  statSync(path: HostPath): OsStats
  statSync(path: HostPath, options: { throwIfNoEntry: false }): OsStats | undefined
  lstatSync(path: HostPath): OsStats
  lstatSync(path: HostPath, options: { throwIfNoEntry: false }): OsStats | undefined
  /**
   * A folder's names. With `recursive`, breadth first as Node lists (`a, b, a/x`), and never into a link, a junction
   * included: Node enters a junction on Windows and not a link on POSIX, and the `Os` answers alike on both, so a
   * link back to a folder above cannot make a listing endless or cut short (`listRecursive` in rules.ts)
   */
  readdirSync(path: HostPath, options?: { recursive?: boolean }): string[]
  readdirSync(path: HostPath, options: { withFileTypes: true; recursive?: boolean }): OsDirent[]
  readFileSync(path: HostPath): Buffer
  readFileSync(path: HostPath, encoding: 'utf8'): string
  writeFileSync(path: HostPath, data: string | Uint8Array, options?: WriteOptions): void
  appendFileSync(path: HostPath, data: string | Uint8Array, options?: { mode?: number }): void
  mkdirSync(path: HostPath, options?: MkdirOptions): void
  mkdtempSync(prefix: HostPath): HostPath
  renameSync(from: HostPath, to: HostPath): void
  copyFileSync(from: HostPath, to: HostPath, mode?: number): void
  /**
   * A copy of a file or, with `recursive`, a tree, that never follows a link (os/copy.ts): every link, the root too, is made
   * again as a link (on Windows a link to a folder at a whole drive path as a junction, any other as a symlink, which needs
   * Developer Mode or an administrator), so a link in a circle or a Windows junction back into the tree, which made Node's own
   * `cpSync` endless, cannot. The promise form never blocks the event loop
   */
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
  fsyncSync(fd: number): void
  /**
   * The names in the folder at `path` reach the disk before this answers; nothing where the OS has no folder sync (Windows), a
   * missing folder included
   */
  fsyncDirSync(path: HostPath): void
  closeSync(fd: number): void
  /**
   * The bytes this process may still write on the disk `path` is on, or null when the OS cannot say. Not Node's shape:
   * `statfsSync` answers blocks and throws
   */
  freeBytesSync(path: HostPath): number | null
  createReadStream(path: HostPath, options?: { encoding?: 'utf8'; start?: number; end?: number }): Readable
  /**
   * A watch on a folder; `recursive` watches below it too, and on Windows that is the one watch a project gets, since a watched
   * folder's parents cannot be moved there (`traits.locksWatchedFolders`)
   */
  watch(path: HostPath, options: { recursive?: boolean }, listener: WatchListener): OsWatcher
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
 * The OS's path rules: `path` is Node's `win32` or `posix` for the OS; relative paths resolve from the host's working folder
 * only through `env.cwd()`
 */
interface OsPaths {
  readonly path: PlatformPath
  /** The null device (`\\.\nul`, `/dev/null`): what git's `core.hooksPath` is set to so no hook runs */
  readonly devNull: HostPath
  same(a: HostPath, b: HostPath): boolean
  inside(root: HostPath, candidate: HostPath): boolean
  key(path: HostPath): string
  fromFileUrl(url: string | URL): HostPath
  toFileUrl(path: HostPath): URL
}

/** How a child ended. A child the host stopped on Windows ends with code 1 and no signal (`taskkill /F`). */
export type OsExit = { code: number | null; signal: NodeJS.Signals | null }

/**
 * One of the child's standard streams: a pipe to the host, nothing, an extra duplex pipe (`'overlapped'`: the apps' broker
 * channel on fd 3), or a file the host opened (`openSync`) the child reads as stdin or writes into
 */
/** `'inherit'`: the host's own (a child whose output is the host's log); in memory, discarded */
export type OsStdio = 'pipe' | 'ignore' | 'inherit' | 'overlapped' | number

export type StartOptions = {
  cwd?: HostPath
  env?: Env
  /** One entry per fd from 0; default three pipes */
  stdio?: readonly OsStdio[]
  /**
   * Whether the child leads a tree of its own. Contained (the default) is a child the host itself ends, by its own step at
   * shutdown or its own stop, and that keeps running for a supervisor's signal to the host's group: an agent CLI, a terminal's
   * shell, an app, a git call (it has `stopAll`); on POSIX it leads a process group (`detached`), on Windows it is attached and
   * its leftovers are found by parent links. `false` is a child that must not outlive the host and that no step of its own ends
   * (an ssh forward, a version probe, a setup script): it stays in the host's group, so the supervisor ends it with the group
   * (`host_proc.rs`'s `kill_group`, also after a crash), and a stop still ends what it started (`killTree` signals the members of
   * its tree in the host's group one by one). Always windowless on Windows
   */
  contained?: boolean
}

/**
 * A started child as Node's `ChildProcess` describes one: `'spawn'`, `'exit'`, `'close'` and `'error'` (could not start:
 * `ENOENT`, `EACCES`, or `EINVAL` for a Windows batch file, which Node throws at once). `exited` settles once with `'exit'`'s
 * values, or `{ code: null, signal: null }` and `error` when it never started
 */
export interface OsChild {
  readonly pid: number | undefined
  /** When the host asked for it, taken before the start: no later than the process's own creation (the orphan sweep needs that) */
  readonly spawnedAt: number
  readonly stdin: Writable | null
  readonly stdout: Readable | null
  readonly stderr: Readable | null
  /** By fd; `stdio[3]` is the `'overlapped'` duplex when asked for (the in-memory OS refuses one) */
  readonly stdio: ReadonlyArray<Readable | Writable | Duplex | null>
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  readonly killed: boolean
  readonly exited: Promise<OsExit & { error?: OsError }>
  /**
   * One signal to this process alone (default SIGTERM); false once it has ended. On Windows only SIGTERM, SIGKILL, SIGINT and
   * SIGQUIT are sent, each ending it at once, and any other throws (`ENOSYS`, `ERR_UNKNOWN_SIGNAL`; `signalRefusal` in rules.ts);
   * on POSIX a program may trap any but SIGKILL
   */
  kill(signal?: NodeJS.Signals): boolean
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
  input?: string | Uint8Array
  timeoutMs?: number
  maxBuffer?: number
  signal?: AbortSignal
  stdoutFile?: HostPath
  onChild?: (child: OsChild) => void
  /**
   * Each piece of stdout as it arrives, in place of collecting it (the result's stdout is empty and `maxBuffer` does not count
   * it); returning true ends the program (`ended: 'stopped'`)
   */
  onStdout?: (chunk: Buffer) => boolean | void
  /** Keeps this many bytes of stderr, its first or its last, in place of all of it: `maxBuffer` does not count it */
  stderrKeep?: { bytes: number; from: 'head' | 'tail' }
  /** The grace an ending gives the program before the second shot (default `RUN_STOP_GRACE_MS`, 2 s) */
  stopGraceMs?: number
  /** See `StartOptions.contained` (default true: a run is a tree of its own) */
  contained?: boolean
}

export type RunResult = OsExit & {
  stdout: Buffer
  stderr: Buffer
  ended?: 'timeout' | 'overflow' | 'aborted' | 'stopped'
}

export type RunSyncOptions = Omit<RunOptions, 'signal' | 'stdoutFile'> & {
  /**
   * How the output is answered: 'utf8' (default) or 'buffer'. Windows' own tools (cmd, taskkill, PowerShell to a pipe) write in
   * the console's code page: Korean from `cmd /c echo` came out as replacement characters in 'utf8', so read anything beyond
   * ASCII as bytes
   */
  encoding?: 'utf8' | 'buffer'
}

/**
 * How a `runSync` ended: `error` when it did not start (`ENOENT`), passed `maxBuffer` (`ENOBUFS`, output so far kept, SIGTERM)
 * or `timeoutMs` (`ETIMEDOUT`, SIGTERM)
 */
export type RunSyncResult<T extends string | Buffer = string> = OsExit & {
  stdout: T
  stderr: T
  error?: OsError
}

export interface OsProcesses {
  /**
   * Starts a child; never throws, a child that could not start emits `'error'`. On Windows a path without an extension is tried
   * with `.com` and `.exe` only (`programCandidates`)
   */
  start(command: string, args: readonly string[], options?: StartOptions): OsChild
  /**
   * Runs a program to its end and answers its exit and output, non-zero included; rejects only when it could not be started. A
   * timeout, overflow or abort ends the whole tree (`stop`, 2 s grace)
   */
  run(command: string, args: readonly string[], options?: RunOptions): Promise<RunResult>
  /**
   * The same, holding the host until it ends, for a program that starts nothing (`STARTS_NOTHING`, the list `guard/timed-start`
   * holds): a limit ends the pid alone, since ending a tree cannot be done synchronously without blocking on a process-table read
   */
  runSync(
    command: string,
    args: readonly string[],
    options?: RunSyncOptions & { encoding?: 'utf8' },
  ): RunSyncResult
  runSync(
    command: string,
    args: readonly string[],
    options: RunSyncOptions & { encoding: 'buffer' },
  ): RunSyncResult<Buffer>
  /** A command line through the OS's shell (`cmd.exe /d /s /c`, `/bin/sh -c`): a person's own setup command, never built from parts */
  runShell(commandLine: string, options?: Omit<RunOptions, 'stdoutFile'>): Promise<RunResult>
  /**
   * Ends a child and everything it started: on POSIX TERM to every group in its tree, then KILL to what is left after `graceMs`;
   * on Windows the child, then what it started, parents first, from the process table read just before (#2142). Then sweeps what
   * it left running (its group; on Windows by parent links and creation time) unless `sweep` is false
   */
  stop(child: OsChild, graceMs: number, options?: { sweep?: boolean }): Promise<OsExit>
  /** `stop` for several children; on Windows one table read before and one sweep after serve all, where `stop` each would read it twice per child */
  stopAll(children: readonly OsChild[], graceMs: number): Promise<void>
  alive(pid: number): boolean
  /**
   * One signal to a process the host did not start, by pid (a stray from a host before, a lock's owner): false when there is
   * none, throws `EPERM`; which signals are sent is `OsChild.kill`'s rule
   */
  signal(pid: number, signal: NodeJS.Signals): boolean
  readonly pid: number
}

/**
 * Programs by name, the way the host finds and starts them (`env-path.ts`, `tool-launch.ts`); on Windows a name is never
 * started bare, as Windows looks in the child's working folder before PATH
 */
interface OsTools {
  find(name: string): HostPath | null
  /** A program the host runs in a project's folder (`git`, `gh`): an absolute path on Windows, never a planted one */
  program(name: string): HostPath
  resolve(command: string, options?: { cwd?: HostPath; env?: Env }): ToolLaunch
}

interface OsEnv {
  /** A variable, in any case on Windows (`Path` is `PATH`) */
  get(name: string): string | undefined
  all(): Env
  /** Sets one for this host and the children it starts after (the tool PATH at start, `ensureToolPath`) */
  set(name: string, value: string | undefined): void
  readonly home: HostPath
  readonly temp: HostPath
  readonly execPath: HostPath
  readonly username: string
  cwd(): HostPath
}

type Timer = { cancel(): void }

/**
 * Time for the waits about the OS (a grace before a second shot, a retry while Windows holds a file, a poll). A real
 * `setTimeout` does not keep the host alive (`unref`); an awaited `sleep` does. In memory, time moves only when a test moves it
 */
export interface OsClock {
  now(): number
  setTimeout(callback: () => void, ms: number): Timer
  sleep(ms: number, options?: { signal?: AbortSignal }): Promise<void>
}

type SqliteOptions = { readonly?: boolean; fileMustExist?: boolean; timeout?: number }

/** SQLite (better-sqlite3) on the real OS; the in-memory OS has none (`ENOSYS`) */
interface OsSqlite {
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
  readonly traits: OsTraits
}
