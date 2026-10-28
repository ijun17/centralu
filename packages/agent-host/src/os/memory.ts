import { EventEmitter } from 'node:events'
import { posix, win32 } from 'node:path'
import type { PlatformPath } from 'node:path'
import { Duplex, PassThrough, Readable, type Writable } from 'node:stream'
import type Database from 'better-sqlite3'
import type {
  Env,
  LinkKind,
  MkdirOptions,
  OpenFlags,
  Os,
  OsChild,
  OsClock,
  OsDirent,
  OsError,
  OsExit,
  OsFileConstants,
  OsFileHandle,
  OsFiles,
  OsFilesAsync,
  OsProcesses,
  OsStats,
  OsStdio,
  OsWatcher,
  RmOptions,
  RunSyncOptions,
  RunSyncResult,
  SqliteOptions,
  StartOptions,
  Timer,
  WatchListener,
  WriteOptions,
} from './port.js'
import {
  DEFAULT_PATHEXT,
  IGNORED_BY_DEFAULT,
  commandInterpreter,
  envValue,
  fileUrlToPath,
  findOnPath,
  foldCase,
  isInside,
  launchFor,
  listRecursive,
  pathKey,
  pathRulesFrom,
  pathToFileUrl,
  programCandidates,
  programFor,
  resolveCommand,
  samePath,
  signalError,
  signalRefusal,
  storedTimeNs,
  traitsOf,
  type OsFamily,
} from './rules.js'
import { abortReason, asError, errorCode } from './errors.js'
import { copyTreeAsync, copyTreeSync } from './copy.js'
import { runChild } from './run.js'

/**
 * The OS in memory (#1599, docs/plans/os-layer.md §7.1): a file tree, a process table and a clock that follow Windows'
 * or POSIX (Linux's) rules, on any OS. Logic tests run on it instead of the machine, so Windows' rules are tested on
 * Linux and leave the Windows job; `real.test.ts` holds it to the real OS on each OS the tests run on.
 *
 * What it follows, by family (measured on Windows 11 with Node 22, and Linux's own rules):
 * - **Names.** Windows: `\` or `/`, drives (`C:\`), case kept and ignored (`realpathNativeSync` answers the stored case,
 *   `realpathSync` the case given), paths normalized by name before they are read (`a\link\..` is `a`). POSIX: `/`, case
 *   counts, `..` taken after a link is followed.
 * - **Links.** Windows: a symlink needs a right (`symlinks: false` refuses one with `EPERM`); a junction needs none, is
 *   always absolute (a relative target is read from its folder), is a link to `lstat` and a folder listing, and one to a
 *   file cannot be followed (`ENOENT`). Removing a link never touches its target.
 * - **What Windows holds.** A running process's working folder cannot be renamed or removed (`EBUSY`); a folder below
 *   which something is held open (a file, a watch, a working folder) cannot be renamed (`EPERM`); a file open in this
 *   process can be renamed and deleted but not replaced (`EPERM`); a running program's file can be renamed but not
 *   deleted or replaced (`EPERM`). POSIX holds none of these.
 * - **Refusals.** The codes each family gives (`unlink` of a folder: `EPERM` / `EISDIR`; a path through a file: `ENOENT`
 *   / `ENOTDIR`; a copy onto a folder: `EPERM` / `EISDIR`; a folder renamed onto one: `EPERM` / replaced if empty,
 *   else `ENOTEMPTY`).
 * - **Processes.** Programs are functions a test adds (`programs.add`); a start finds them as the OS would (PATH, and on
 *   Windows PATHEXT, `.exe`/`.com` and a batch file refused with `EINVAL`). Windows: only TERM, KILL, INT and QUIT
 *   end a process (exit `null` and the signal), any other name Node knows is `ENOSYS`, one it does not is
 *   `ERR_UNKNOWN_SIGNAL` (`signalRefusal`), and `stop` ends a tree at once (code 1, as `taskkill /F`). POSIX: groups, a signal a program
 *   may trap, `stop` sends TERM and KILL after the grace on the clock. Output closes before `'exit'`, `'close'` follows.
 * - **Time** moves only by `clock.advance(ms)`: timers, grace periods and file times read it.
 *
 * Not modeled: 8.3 short names, Windows' reserved names and trailing dots, alternate data streams, shares (UNC),
 * `\\?\` paths, permissions beyond the mode bits (and on Windows the read-only bit), hard links to folders, file
 * locking between processes, a program's file read through a link, PTYs, and SQLite (given with `sqlite`).
 */

export type ProgramContext = {
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Env
  readonly pid: number
  /** What the host writes; ended when the host ends its stdin */
  readonly stdin: Readable
  readonly stdout: Writable
  readonly stderr: Writable
  /** The `'overlapped'` fd 3, when asked for */
  readonly extra: Duplex | null
  /** The OS as this program sees it: what it starts is its own child */
  readonly os: MemoryOs
  /** Starts a child of this program (in its group unless `contained`) */
  start(command: string, args: readonly string[], options?: StartOptions): OsChild
  /** Called for a signal before it ends the process; answer true to trap it (POSIX; never SIGKILL, never on Windows) */
  onSignal(listener: (signal: NodeJS.Signals) => boolean | void): void
  /** Aborted when the process ends, however it ends */
  readonly ended: AbortSignal
}

/** A program: its exit code, or nothing for 0. Throwing writes the error to stderr and exits 1. */
export type Program = (ctx: ProgramContext) => number | void | Promise<number | void>
/** A program `runSync` can run: it answers at once */
/**
 * A program `runSync` can run: it answers at once, with its output as text (UTF-8) or bytes (a tool writing in a
 * console code page), and `ms`, how long it would take, for `timeoutMs`
 */
export type SyncProgram = (ctx: { args: readonly string[]; cwd: string; env: Env; input: string }) => {
  code?: number
  stdout?: string | Uint8Array
  stderr?: string | Uint8Array
  ms?: number
}

/** spawnSync's `maxBuffer` when none is given */
const SYNC_MAX_BUFFER = 1024 * 1024

export interface MemoryPrograms {
  /** Puts a program's file at `path` (folders made as needed) and runs `program` when it is started */
  add(path: string, program: Program, options?: { sync?: SyncProgram }): void
}

export type ProcessRow = { pid: number; ppid: number; pgid: number; command: string; args: readonly string[]; cwd: string; alive: boolean; exit: OsExit | null }

export interface MemoryClock extends OsClock {
  /** Moves time on by `ms`, firing each timer that comes due in order, and letting what it starts run */
  advance(ms: number): Promise<void>
  /** Timers waiting */
  pending(): number
}

export interface MemoryOs extends Os {
  readonly family: OsFamily
  readonly programs: MemoryPrograms
  readonly clock: MemoryClock
  /** Every process started, in order */
  processTable(): readonly ProcessRow[]
}

export type MemoryOsOptions = {
  as: OsFamily
  /** Windows: more drive letters than C; POSIX: folders that are volumes of their own (a rename across is `EXDEV`) */
  volumes?: readonly string[]
  /** Windows: whether this account may make a symlink (an administrator, Developer Mode). Default true. */
  symlinks?: boolean
  /** Variables set on top of the family's defaults (`undefined` removes one) */
  env?: Env
  /** When the clock starts, in ms since 1970 */
  now?: number
  /** The host's working folder (made if missing); default the home folder */
  cwd?: string
  /** The engine `sqlite.open` uses: the in-memory OS has none of its own */
  sqlite?: (path: string, options: SqliteOptions) => Database.Database
}

type Meta = { ino: bigint; dev: bigint; perm: number; atimeNs: bigint; mtimeNs: bigint; ctimeNs: bigint; birthNs: bigint }
type FileNode = Meta & { kind: 'file'; data: Buffer; nlink: number }
type DirNode = Meta & { kind: 'dir'; entries: Map<string, { name: string; node: Node }>; parent: DirNode | null }
type LinkNode = Meta & { kind: 'link'; target: string; junction: boolean }
type Node = FileNode | DirNode | LinkNode

/** Where a path leads: the folder it is in, its name there, and the node when there is one; `dirOnly` for `name/` on POSIX */
type Found = { parent: DirNode; name: string; node: Node | undefined; native: string; given: string; dirOnly?: boolean }

/** Characters Windows refuses in a name (measured: `a*b` is ENOENT to write or read, EINVAL to make a folder) */
const refusedOnWindows = (name: string) => /[<>"|?*]/.test(name) || [...name].some((c) => c.charCodeAt(0) < 0x20)

const LINK_HOPS = 40
const STAT_FILE = 0o100000
const STAT_DIR = 0o040000
const STAT_LINK = 0o120000

const WINDOWS_CONSTANTS: OsFileConstants = { O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 256, O_EXCL: 1024, O_TRUNC: 512, O_APPEND: 8, O_NOFOLLOW: 0, O_NONBLOCK: 0, COPYFILE_EXCL: 1 }
const POSIX_CONSTANTS: OsFileConstants = { O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128, O_TRUNC: 512, O_APPEND: 1024, O_NOFOLLOW: 131072, O_NONBLOCK: 2048, COPYFILE_EXCL: 1 }

const MESSAGES: Record<string, string> = {
  ENOENT: 'no such file or directory',
  EEXIST: 'file already exists',
  ENOTDIR: 'not a directory',
  EISDIR: 'illegal operation on a directory',
  ENOTEMPTY: 'directory not empty',
  EXDEV: 'cross-device link not permitted',
  EBUSY: 'resource busy or locked',
  EPERM: 'operation not permitted',
  EACCES: 'permission denied',
  EINVAL: 'invalid argument',
  ELOOP: 'too many symbolic links encountered',
  EBADF: 'bad file descriptor',
}

function fsError(code: string, syscall: string, path?: string, dest?: string): OsError {
  const where = path === undefined ? '' : ` '${path}'${dest === undefined ? '' : ` -> '${dest}'`}`
  return Object.assign(new Error(`${code}: ${MESSAGES[code] ?? code}, ${syscall}${where}`), { code, syscall, ...(path === undefined ? {} : { path }), ...(dest === undefined ? {} : { dest }) })
}

/** One of Node's own errors (not an errno one) */
function nodeError(code: string, message: string, syscall: string, path: string): OsError {
  return Object.assign(new Error(message), { code, syscall, path })
}

const later = (fn: () => void) => void setImmediate(fn)

export function memoryOs(options: MemoryOsOptions): MemoryOs {
  const family = options.as
  const windows = family === 'windows'
  const HOME = windows ? 'C:\\Users\\person' : '/home/person'
  const cwd = options.cwd ?? HOME
  // Relative paths are read from this OS's working folder, never from the one of the process running the tests
  const P: PlatformPath = pathRulesFrom(family, () => cwd)
  const traits = traitsOf(family)
  const fold = (name: string) => foldCase(name, family)
  const canSymlink = options.symlinks ?? true

  // ---- time ----
  let nowMs = options.now ?? Date.UTC(2026, 0, 1)
  let timerSeq = 0
  const timers: Array<{ at: number; seq: number; fn: () => void }> = []
  const nowNs = () => BigInt(Math.round(nowMs)) * 1_000_000n
  const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r))
  }
  const clock: MemoryClock = {
    now: () => nowMs,
    setTimeout: (fn, ms) => {
      const t = { at: nowMs + Math.max(0, ms), seq: timerSeq++, fn }
      timers.push(t)
      return { cancel: () => void timers.splice(timers.indexOf(t) >>> 0, timers.includes(t) ? 1 : 0) }
    },
    sleep: (ms, o) =>
      new Promise<void>((resolve, reject) => {
        const signal = o?.signal
        if (signal?.aborted) return reject(abortReason(signal))
        const t = clock.setTimeout(resolve, ms)
        signal?.addEventListener('abort', () => (t.cancel(), reject(abortReason(signal))), { once: true })
      }),
    advance: async (ms) => {
      const until = nowMs + ms
      await flush()
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.seq - b.seq)
        const next = timers[0]
        if (!next || next.at > until) break
        timers.shift()
        nowMs = Math.max(nowMs, next.at)
        next.fn()
        await flush()
      }
      nowMs = until
      await flush()
    },
    pending: () => timers.length,
  }

  // ---- the tree ----
  let inoSeq = 1000n
  const meta = (dev: bigint, perm: number): Meta => {
    const t = nowNs()
    return { ino: inoSeq++, dev, perm, atimeNs: t, mtimeNs: t, ctimeNs: t, birthNs: t }
  }
  const newDir = (parent: DirNode | null, dev: bigint, perm = 0o755): DirNode => ({ ...meta(dev, perm), kind: 'dir', entries: new Map(), parent })
  const newFile = (dev: bigint, data: Buffer, perm = 0o644): FileNode => ({ ...meta(dev, perm), kind: 'file', data, nlink: 1 })

  const roots = new Map<string, DirNode>()
  let devSeq = 1n
  if (windows) {
    for (const letter of ['C', ...(options.volumes ?? [])]) roots.set(letter.toLowerCase(), newDir(null, devSeq++))
  }
  const posixRoot = newDir(null, devSeq++)
  if (!windows) roots.set('/', posixRoot)

  const touch = (n: Meta) => {
    n.mtimeNs = nowNs()
    n.ctimeNs = n.mtimeNs
  }

  /** A path as the OS reads it: the root it starts from and its names */
  function parse(p: string, syscall: string): { root: DirNode; rootPath: string; parts: string[] } {
    if (typeof p !== 'string' || p === '') throw fsError('ENOENT', syscall, String(p))
    if (windows) {
      const full = win32.resolve(cwd, p)
      const root = win32.parse(full).root
      const drive = /^([A-Za-z]):\\$/.exec(root)?.[1]
      const node = drive ? roots.get(drive.toLowerCase()) : undefined
      if (!drive || !node) throw fsError('ENOENT', syscall, p)
      const parts = full.slice(root.length).split('\\').filter(Boolean)
      // A name Windows refuses (`a*b`): not there to read or write (ENOENT), invalid to make a folder of (EINVAL)
      if (parts.some(refusedOnWindows)) throw fsError(syscall === 'mkdir' ? 'EINVAL' : 'ENOENT', syscall, p)
      return { root: node, rootPath: `${drive.toUpperCase()}:\\`, parts }
    }
    const full = p.startsWith('/') ? p : `${cwd}/${p}`
    return { root: posixRoot, rootPath: '/', parts: full.split(posix.sep).filter((s) => s !== '') }
  }

  /**
   * Where `p` leads; `follow` follows a link in the last name too. Throws for a missing folder on the way. On POSIX a
   * trailing `/` names a folder: the last name is followed, and is `ENOTDIR` when it is not one (`file/`), as Linux
   * answers; Windows reads `file\` as `file`.
   */
  function lookup(p: string, follow: boolean, syscall: string, hops = 0): Found {
    const trailing = !windows && typeof p === 'string' && p.length > 1 && p.endsWith('/')
    const f = lookupName(p, follow || trailing, syscall, hops)
    if (trailing && f.node && f.node.kind !== 'dir') throw fsError('ENOTDIR', syscall, p)
    return trailing ? { ...f, dirOnly: true } : f
  }

  function lookupName(p: string, follow: boolean, syscall: string, hops: number): Found {
    const { root, rootPath, parts } = parse(p, syscall)
    let dir = root
    const native: string[] = []
    const given: string[] = []
    for (const [i, part] of parts.entries()) {
      const last = i === parts.length - 1
      if (part === '.') {
        if (last) return { parent: dir.parent ?? dir, name: '.', node: dir, native: rootPath + native.join(P.sep), given: rootPath + given.join(P.sep) }
        continue
      }
      if (part === '..') {
        dir = dir.parent ?? dir
        native.pop()
        given.pop()
        if (last) return { parent: dir.parent ?? dir, name: '..', node: dir, native: rootPath + native.join(P.sep), given: rootPath + given.join(P.sep) }
        continue
      }
      const entry = dir.entries.get(fold(part))
      if (!entry) {
        if (last) return { parent: dir, name: part, node: undefined, native: rootPath + [...native, part].join(P.sep), given: rootPath + [...given, part].join(P.sep) }
        throw fsError('ENOENT', syscall, p)
      }
      const node = entry.node
      if (node.kind === 'link' && (!last || follow)) {
        if (hops >= LINK_HOPS) throw fsError('ELOOP', syscall, p)
        const from = rootPath + native.join(P.sep)
        const target = node.junction || P.isAbsolute(node.target) ? node.target : windows ? win32.resolve(from, node.target) : `${from}/${node.target}`
        const rest = parts.slice(i + 1)
        const next = rest.length ? (windows ? win32.join(target, ...rest) : [target, ...rest].join(posix.sep)) : target
        let found: Found
        try {
          found = lookup(next, follow, syscall, hops + 1)
        } catch (e) {
          const code = errorCode(e)
          throw code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP' ? fsError(code, syscall, p) : e
        }
        if (node.junction && rest.length === 0 && found.node?.kind === 'file') throw fsError('ENOENT', syscall, p)
        if (rest.length === 0 && !found.node) throw fsError('ENOENT', syscall, p)
        return found
      }
      native.push(entry.name)
      given.push(part)
      if (last) return { parent: dir, name: entry.name, node, native: rootPath + native.join(P.sep), given: rootPath + given.join(P.sep) }
      if (node.kind !== 'dir') throw fsError(windows ? 'ENOENT' : 'ENOTDIR', syscall, p)
      dir = node
    }
    // The root itself
    return { parent: root, name: '', node: root, native: rootPath, given: rootPath }
  }

  /** `lookup`, or null when a folder on the way (or the link's target) is missing */
  const lookupOrNull = (p: string, syscall: string, follow = false): Found | null => {
    try {
      return lookup(p, follow, syscall)
    } catch (e) {
      if (errorCode(e) === 'ENOENT' || errorCode(e) === 'ENOTDIR') return null
      throw e
    }
  }

  const existing = (p: string, follow: boolean, syscall: string): Node => {
    const f = lookup(p, follow, syscall)
    if (!f.node) throw fsError('ENOENT', syscall, p)
    return f.node
  }

  // ---- what Windows holds ----
  const openFiles = new Map<Node, number>()
  const heldDirs = new Map<Node, number>()
  const watchedDirs = new Map<Node, number>()
  const runningFiles = new Map<Node, number>()
  const hold = (m: Map<Node, number>, n: Node) => m.set(n, (m.get(n) ?? 0) + 1)
  const release = (m: Map<Node, number>, n: Node) => {
    const left = (m.get(n) ?? 0) - 1
    if (left > 0) m.set(n, left)
    else m.delete(n)
  }
  const below = (dir: DirNode, test: (n: Node) => boolean): boolean => {
    for (const { node } of dir.entries.values()) {
      if (test(node)) return true
      if (node.kind === 'dir' && below(node, test)) return true
    }
    return false
  }
  const heldBelow = (dir: DirNode) => below(dir, (n) => openFiles.has(n) || heldDirs.has(n) || watchedDirs.has(n) || runningFiles.has(n))
  const busyTree = (n: Node) => heldDirs.has(n) || (n.kind === 'dir' && below(n, (x) => heldDirs.has(x)))

  // ---- watches ----
  type Watch = { dir: DirNode; recursive: boolean; listener: WatchListener; closed: boolean; errors: EventEmitter }
  const watches = new Set<Watch>()
  const notify = (dir: DirNode, name: string, event: 'rename' | 'change') => {
    if (watches.size === 0) return
    const chain: string[] = [name]
    for (let d: DirNode | null = dir; d; d = d.parent) {
      for (const w of watches) {
        if (w.closed || w.dir !== d || (d !== dir && !w.recursive)) continue
        const rel = chain.join(P.sep)
        later(() => !w.closed && w.listener(event, rel))
      }
      const parent: DirNode | null = d.parent
      if (parent) for (const e of parent.entries.values()) if (e.node === d) chain.unshift(e.name)
    }
  }

  const link = (parent: DirNode, name: string, node: Node) => {
    parent.entries.set(fold(name), { name, node })
    if (node.kind === 'dir') node.parent = parent
    touch(parent)
    notify(parent, name, 'rename')
  }
  const unlinkEntry = (parent: DirNode, name: string) => {
    const key = fold(name)
    const e = parent.entries.get(key)
    parent.entries.delete(key)
    touch(parent)
    if (e) notify(parent, e.name, 'rename')
    if (e?.node.kind === 'file') e.node.nlink--
  }

  // ---- files ----
  const statOf = (n: Node): OsStats => {
    const type = n.kind === 'dir' ? STAT_DIR : n.kind === 'file' ? STAT_FILE : STAT_LINK
    const perm = windows ? (n.kind === 'link' ? 0o666 : n.perm & 0o200 ? 0o666 : 0o444) : n.kind === 'link' ? 0o777 : n.perm
    const size = n.kind === 'file' ? n.data.length : n.kind === 'dir' ? (windows ? 0 : 4096) : windows ? 0 : Buffer.byteLength(n.target)
    const ms = (ns: bigint) => Number(ns / 1_000_000n)
    return {
      isFile: () => n.kind === 'file',
      isDirectory: () => n.kind === 'dir',
      isSymbolicLink: () => n.kind === 'link',
      size,
      mode: type | perm,
      uid: windows ? 0 : 1000,
      nlink: n.kind === 'file' ? n.nlink : n.kind === 'dir' && !windows ? 2 + [...n.entries.values()].filter((e) => e.node.kind === 'dir').length : 1,
      dev: n.dev,
      ino: n.ino,
      atimeMs: ms(n.atimeNs),
      mtimeMs: ms(n.mtimeNs),
      mtimeNs: n.mtimeNs,
      ctimeMs: ms(n.ctimeNs),
      birthtimeMs: ms(n.birthNs),
    }
  }

  const dirent = (name: string, n: Node, parentPath: string): OsDirent => ({
    name,
    parentPath,
    isFile: () => n.kind === 'file',
    isDirectory: () => n.kind === 'dir',
    isSymbolicLink: () => n.kind === 'link',
  })

  const sortedEntries = (dir: DirNode) => [...dir.entries.values()].sort((a, b) => (fold(a.name) < fold(b.name) ? -1 : fold(a.name) > fold(b.name) ? 1 : 0))

  function readdir(p: string, o?: { withFileTypes?: boolean; recursive?: boolean }): string[] | OsDirent[] {
    const entriesOf = (dir: string): OsDirent[] => {
      const f = lookup(dir, true, 'scandir')
      if (!f.node) throw fsError('ENOENT', 'scandir', dir)
      if (f.node.kind !== 'dir') throw fsError('ENOTDIR', 'scandir', dir)
      return sortedEntries(f.node).map((e) => dirent(e.name, e.node, dir))
    }
    // Breadth first and never into a link, by the one rule the real OS follows too
    const listed = o?.recursive ? listRecursive(p, entriesOf, (...s) => P.join(...s)) : entriesOf(p).map((entry) => ({ rel: entry.name, entry }))
    return o?.withFileTypes ? listed.map((e) => e.entry) : listed.map((e) => e.rel)
  }

  function readFile(p: string): Buffer {
    const n = existing(p, true, 'open')
    if (n.kind === 'dir') throw fsError('EISDIR', 'read')
    if (n.kind !== 'file') throw fsError('ENOENT', 'open', p)
    n.atimeNs = nowNs()
    return Buffer.from(n.data)
  }

  const bytes = (data: string | Uint8Array) => (typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data))

  /**
   * A file without its owner's write bit cannot be written: on Windows that is the read-only attribute, `EPERM` (to
   * write, append, open for writing, copy or rename onto it; it can still be renamed away and removed); on POSIX the
   * mode, `EACCES` for the owner the host runs as (never root)
   */
  const readOnly = (n: Node) => n.kind === 'file' && (n.perm & 0o200) === 0
  const refuseReadOnly = (n: Node, syscall: string, p: string) => {
    if (readOnly(n)) throw fsError(windows ? 'EPERM' : 'EACCES', syscall, p)
  }

  /** The file at `p` for writing, made when missing; `exclusive` refuses one there */
  function fileForWrite(p: string, syscall: string, o: { exclusive?: boolean; mode?: number; noFollow?: boolean } = {}): FileNode {
    const f = lookup(p, !o.noFollow, syscall)
    if (f.node) {
      if (o.exclusive) throw fsError('EEXIST', syscall, p)
      if (f.node.kind === 'dir') throw fsError('EISDIR', syscall, p)
      if (f.node.kind === 'link') throw fsError(windows ? 'EPERM' : 'ELOOP', syscall, p)
      if (windows && runningFiles.has(f.node)) throw fsError('EBUSY', syscall, p)
      refuseReadOnly(f.node, syscall, p)
      return f.node
    }
    // `name/` names a folder: a file is not made under it (Linux)
    if (f.dirOnly) throw fsError('EISDIR', syscall, p)
    if (f.parent.kind !== 'dir') throw fsError('ENOENT', syscall, p)
    const n = newFile(f.parent.dev, Buffer.alloc(0), (o.mode ?? 0o666) & ~0o022)
    link(f.parent, f.name, n)
    return n
  }

  function writeFile(p: string, data: string | Uint8Array, o: WriteOptions = {}) {
    const flag = o.flag ?? 'w'
    const n = fileForWrite(p, 'open', { exclusive: flag.includes('x'), mode: o.mode })
    n.data = flag.startsWith('a') ? Buffer.concat([n.data, bytes(data)]) : bytes(data)
    touch(n)
    const f = lookup(p, true, 'open')
    notify(f.parent, f.name, 'change')
  }

  function mkdir(p: string, o: MkdirOptions = {}, parentOf?: string) {
    // A link in the name's place is taken (EEXIST), even one that leads nowhere; `mkdir -p` follows it, to a folder
    // (done), to anything else (EEXIST) or nowhere (ENOENT), as Node does on Linux and Windows alike
    const named = lookupOrNull(p, 'mkdir')
    if (named?.node?.kind === 'link') {
      if (!o.recursive) throw fsError('EEXIST', 'mkdir', p)
      const to = lookupOrNull(p, 'mkdir', true)?.node
      if (!to) throw fsError('ENOENT', 'mkdir', p)
      if (to.kind === 'dir') return
      throw fsError('EEXIST', 'mkdir', p)
    }
    let f: Found
    try {
      f = lookup(p, true, 'mkdir')
    } catch (e) {
      const up = P.dirname(p)
      if (!o.recursive || errorCode(e) !== 'ENOENT' || up === p) throw e
      // A folder on the way is missing: made first, as `mkdir -p` does
      mkdir(up, o, parentOf ?? p)
      f = lookup(p, true, 'mkdir')
    }
    if (f.node) {
      if (o.recursive && f.node.kind === 'dir') return
      // A file on the way of `mkdir -p` (Windows reads it as missing, then finds it there): ENOTDIR, as on Linux
      if (parentOf !== undefined) throw fsError('ENOTDIR', 'mkdir', parentOf)
      throw fsError('EEXIST', 'mkdir', p)
    }
    link(f.parent, f.name, newDir(f.parent, f.parent.dev, (o.mode ?? 0o777) & ~0o022))
  }

  let tempSeq = 0
  const TEMP_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  function mkdtemp(prefix: string): string {
    for (;;) {
      let n = tempSeq++
      let suffix = ''
      for (let i = 0; i < 6; i++) {
        suffix += TEMP_CHARS[n % TEMP_CHARS.length]
        n = Math.floor(n / TEMP_CHARS.length) + i * 7
      }
      const path = prefix + suffix
      if (!lookup(path, false, 'mkdtemp').node) {
        mkdir(path, { mode: 0o700 })
        return path
      }
    }
  }

  const inside = (dir: DirNode, n: Node): boolean => {
    for (let d: DirNode | null = n.kind === 'dir' ? n : null; d; d = d.parent) if (d === dir) return true
    return false
  }

  function rename(from: string, to: string) {
    const a = lookup(from, false, 'rename')
    if (!a.node) throw fsError('ENOENT', 'rename', from, to)
    const b = lookup(to, false, 'rename')
    if (b.parent.dev !== a.parent.dev) throw fsError('EXDEV', 'rename', from, to)
    if (a.node === b.node) {
      const sameEntry = a.parent === b.parent && fold(a.name) === fold(b.name)
      if (sameEntry) {
        // The same file under another case on Windows: its name is stored as now written
        const written = P.basename(to)
        if (windows && written !== a.name) {
          a.parent.entries.delete(fold(a.name))
          link(a.parent, written, a.node)
          touch(a.parent)
          notify(a.parent, a.name, 'rename')
        }
        return
      }
      // Two hard links to one file: Windows takes the name away (one link left), POSIX does nothing (rename(2))
      if (windows) unlinkEntry(a.parent, a.name)
      return
    }
    const src = a.node
    // Into itself: Windows refuses with EPERM, Linux with EINVAL
    if (src.kind === 'dir' && inside(src, b.parent)) throw fsError(windows ? 'EPERM' : 'EINVAL', 'rename', from, to)
    if (windows && src.kind === 'dir') {
      if (heldDirs.has(src)) throw fsError('EBUSY', 'rename', from, to)
      if (heldBelow(src)) throw fsError('EPERM', 'rename', from, to)
    }
    if (b.node) {
      const dst = b.node
      if (windows) {
        if (dst.kind === 'dir') throw fsError('EPERM', 'rename', from, to)
        if (openFiles.has(dst) || runningFiles.has(dst) || readOnly(dst)) throw fsError('EPERM', 'rename', from, to)
      } else if (dst.kind === 'dir') {
        if (src.kind !== 'dir') throw fsError('EISDIR', 'rename', from, to)
        if (dst.entries.size > 0) throw fsError('ENOTEMPTY', 'rename', from, to)
      } else if (src.kind === 'dir') throw fsError('ENOTDIR', 'rename', from, to)
      unlinkEntry(b.parent, b.name)
    }
    a.parent.entries.delete(fold(a.name))
    touch(a.parent)
    notify(a.parent, a.name, 'rename')
    link(b.parent, b.name, src)
    src.ctimeNs = nowNs()
  }

  function unlink(p: string) {
    const f = lookup(p, false, 'unlink')
    if (!f.node) throw fsError('ENOENT', 'unlink', p)
    if (f.node.kind === 'dir') throw fsError(windows ? 'EPERM' : 'EISDIR', 'unlink', p)
    if (windows && runningFiles.has(f.node)) throw fsError('EPERM', 'unlink', p)
    unlinkEntry(f.parent, f.name)
  }

  function rmdir(p: string) {
    const f = lookup(p, false, 'rmdir')
    if (!f.node) throw fsError('ENOENT', 'rmdir', p)
    if (f.node.kind === 'link') {
      if (windows && f.node.junction) return unlinkEntry(f.parent, f.name)
      throw fsError('ENOTDIR', 'rmdir', p)
    }
    if (f.node.kind !== 'dir') throw fsError(windows ? 'ENOENT' : 'ENOTDIR', 'rmdir', p)
    if (f.node.entries.size > 0) throw fsError('ENOTEMPTY', 'rmdir', p)
    if (windows && heldDirs.has(f.node)) throw fsError('EBUSY', 'rmdir', p)
    unlinkEntry(f.parent, f.name)
  }

  function rm(p: string, o: RmOptions = {}) {
    const f = lookup(p, false, 'rm')
    if (!f.node) {
      if (o.force) return
      throw fsError('ENOENT', 'lstat', p)
    }
    if (f.node.kind === 'dir') {
      if (!o.recursive) throw nodeError('ERR_FS_EISDIR', `Path is a directory: rm returned EISDIR (is a directory) ${p}`, 'rm', p)
      if (windows && busyTree(f.node)) throw fsError('EBUSY', 'rmdir', p)
      if (windows && below(f.node, (n) => runningFiles.has(n))) throw fsError('EPERM', 'unlink', p)
    } else if (windows && runningFiles.has(f.node)) throw fsError('EPERM', 'unlink', p)
    unlinkEntry(f.parent, f.name)
  }

  function symlink(target: string, p: string, kind?: LinkKind) {
    const f = lookup(p, false, 'symlink')
    if (f.node) throw fsError('EEXIST', 'symlink', target, p)
    const junction = windows && kind === 'junction'
    if (windows && !junction && !canSymlink) throw fsError('EPERM', 'symlink', target, p)
    const stored = junction ? win32.resolve(P.dirname(f.native), target) : windows ? target.replaceAll('/', '\\') : target
    const n: LinkNode = { ...meta(f.parent.dev, 0o777), kind: 'link', target: stored, junction }
    link(f.parent, f.name, n)
  }

  function readlink(p: string): string {
    const n = existing(p, false, 'readlink')
    if (n.kind !== 'link') throw fsError('EINVAL', 'readlink', p)
    return n.target
  }

  function hardLink(existingPath: string, to: string) {
    const n = existing(existingPath, false, 'link')
    if (n.kind === 'dir') throw fsError('EPERM', 'link', existingPath, to)
    const f = lookup(to, false, 'link')
    if (f.node) throw fsError('EEXIST', 'link', existingPath, to)
    if (f.parent.dev !== n.dev) throw fsError('EXDEV', 'link', existingPath, to)
    if (n.kind === 'file') n.nlink++
    link(f.parent, f.name, n)
  }

  function copyFile(from: string, to: string, mode = 0) {
    const src = existing(from, true, 'copyfile')
    if (src.kind !== 'file') throw fsError(windows ? 'EPERM' : 'EISDIR', 'copyfile', from, to)
    const f = lookup(to, true, 'copyfile')
    if (f.node) {
      if (f.node.kind === 'dir') throw fsError(windows ? 'EPERM' : 'EISDIR', 'copyfile', from, to)
      if (mode & 1) throw fsError('EEXIST', 'copyfile', from, to)
    }
    const n = fileForWrite(to, 'copyfile', { mode: src.perm })
    n.data = Buffer.from(src.data)
    touch(n)
    // Windows' CopyFile keeps the source's change time
    if (windows) n.mtimeNs = src.mtimeNs
  }

  function chmod(p: string, mode: number) {
    const n = existing(p, true, 'chmod')
    n.perm = windows ? (mode & 0o200 ? 0o666 : 0o444) : mode & 0o7777
    n.ctimeNs = nowNs()
  }

  function utimes(p: string, atime: number | Date, mtime: number | Date) {
    const n = existing(p, true, 'utime')
    n.atimeNs = storedTimeNs(atime, family)
    n.mtimeNs = storedTimeNs(mtime, family)
  }

  // ---- descriptors ----
  const constants = windows ? WINDOWS_CONSTANTS : POSIX_CONSTANTS
  type Fd = { node: FileNode | DirNode; read: boolean; write: boolean; append: boolean; pos: number; closed: boolean }
  const fds = new Map<number, Fd>()
  let fdSeq = 3
  const FLAGS: Record<string, number> = {
    r: constants.O_RDONLY,
    'r+': constants.O_RDWR,
    w: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC,
    wx: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_EXCL,
    a: constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND,
    ax: constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_EXCL,
  }
  function open(p: string, flags: OpenFlags, mode?: number): number {
    const f = typeof flags === 'number' ? flags : FLAGS[flags]
    if (f === undefined) throw fsError('EINVAL', 'open', p)
    const access = f & 3
    const noFollow = constants.O_NOFOLLOW !== 0 && (f & constants.O_NOFOLLOW) !== 0
    let node: FileNode | DirNode
    if (f & constants.O_CREAT) {
      node = fileForWrite(p, 'open', { exclusive: (f & constants.O_EXCL) !== 0, mode, noFollow })
      if (f & constants.O_TRUNC) node.data = Buffer.alloc(0)
    } else {
      const found = lookup(p, !noFollow, 'open')
      if (!found.node) throw fsError('ENOENT', 'open', p)
      if (found.node.kind === 'link') throw fsError('ELOOP', 'open', p)
      // A folder opens (to fsync it); for writing too on Windows, not on POSIX. It reads as EISDIR
      if (found.node.kind === 'dir' && !windows && access !== constants.O_RDONLY) throw fsError('EISDIR', 'open', p)
      if (access !== constants.O_RDONLY) refuseReadOnly(found.node, 'open', p)
      node = found.node
    }
    const fd = fdSeq++
    fds.set(fd, { node, read: access !== constants.O_WRONLY, write: access !== constants.O_RDONLY, append: (f & constants.O_APPEND) !== 0, pos: 0, closed: false })
    // An open folder holds nothing on Windows: it is opened to share its deletion too
    if (node.kind === 'file') hold(openFiles, node)
    return fd
  }
  const fdOf = (fd: number, syscall: string): Fd => {
    const d = fds.get(fd)
    if (!d || d.closed) throw fsError('EBADF', syscall)
    return d
  }
  function readFd(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null): number {
    const d = fdOf(fd, 'read')
    if (!d.read) throw fsError('EBADF', 'read')
    if (d.node.kind !== 'file') throw fsError('EISDIR', 'read')
    const at = position ?? d.pos
    const n = Math.max(0, Math.min(length, d.node.data.length - at))
    // At or past the end (a log truncated under a reader): 0 bytes, as the OS answers
    if (n === 0) return 0
    d.node.data.copy(buffer, offset, at, at + n)
    if (position === null) d.pos += n
    return n
  }
  function writeFd(fd: number, data: string | Uint8Array): number {
    const d = fdOf(fd, 'write')
    if (!d.write) throw fsError('EBADF', 'write')
    if (d.node.kind !== 'file') throw fsError('EISDIR', 'write')
    const b = bytes(data)
    const at = d.append ? d.node.data.length : d.pos
    const end = at + b.length
    const next = Buffer.alloc(Math.max(d.node.data.length, end))
    d.node.data.copy(next)
    b.copy(next, at)
    d.node.data = next
    d.pos = end
    touch(d.node)
    return b.length
  }
  function closeFd(fd: number) {
    const d = fdOf(fd, 'close')
    d.closed = true
    fds.delete(fd)
    if (d.node.kind === 'file') release(openFiles, d.node)
  }
  /** Another descriptor on the same file (a child's copy of one it was given) */
  function dupFd(fd: number): number {
    const d = fdOf(fd, 'dup')
    const copy = fdSeq++
    fds.set(copy, { ...d })
    if (d.node.kind === 'file') hold(openFiles, d.node)
    return copy
  }

  const syncly = <T>(fn: () => T): Promise<T> =>
    new Promise((resolve, reject) => {
      later(() => {
        try {
          resolve(fn())
        } catch (e) {
          reject(asError(e))
        }
      })
    })

  function watch(p: string, o: { recursive?: boolean }, listener: WatchListener): OsWatcher {
    const n = existing(p, true, 'watch')
    if (n.kind !== 'dir') throw fsError('ENOTDIR', 'watch', p)
    const w: Watch = { dir: n, recursive: !!o.recursive, listener, closed: false, errors: new EventEmitter() }
    watches.add(w)
    hold(watchedDirs, n)
    const watcher: OsWatcher = {
      close: () => {
        if (w.closed) return
        w.closed = true
        watches.delete(w)
        release(watchedDirs, n)
      },
      on: (_event, fn) => {
        w.errors.on('error', fn)
        return watcher
      },
    }
    return watcher
  }

  function createReadStream(p: string, o: { encoding?: 'utf8'; start?: number; end?: number } = {}): Readable {
    let done = false
    const stream = new Readable({
      encoding: o.encoding,
      read() {
        if (done) return
        done = true
        try {
          const data = readFile(p)
          const slice = data.subarray(o.start ?? 0, o.end === undefined ? undefined : o.end + 1)
          if (slice.length) this.push(slice)
          this.push(null)
        } catch (e) {
          this.destroy(asError(e))
        }
      },
    })
    return stream
  }

  function statSync(p: string): OsStats
  function statSync(p: string, o: { throwIfNoEntry: false }): OsStats | undefined
  function statSync(p: string, o?: { throwIfNoEntry: false }): OsStats | undefined {
    try {
      return statOf(existing(p, true, 'stat'))
    } catch (e) {
      if (o?.throwIfNoEntry === false && ['ENOENT', 'ENOTDIR'].includes(errorCode(e) ?? '')) return undefined
      throw e
    }
  }
  function lstatSync(p: string): OsStats
  function lstatSync(p: string, o: { throwIfNoEntry: false }): OsStats | undefined
  function lstatSync(p: string, o?: { throwIfNoEntry: false }): OsStats | undefined {
    try {
      return statOf(existing(p, false, 'lstat'))
    } catch (e) {
      if (o?.throwIfNoEntry === false && ['ENOENT', 'ENOTDIR'].includes(errorCode(e) ?? '')) return undefined
      throw e
    }
  }
  function readdirSync(p: string, o?: { recursive?: boolean }): string[]
  function readdirSync(p: string, o: { withFileTypes: true; recursive?: boolean }): OsDirent[]
  function readdirSync(p: string, o?: { withFileTypes?: boolean; recursive?: boolean }): string[] | OsDirent[] {
    return readdir(p, o)
  }
  function readFileSync(p: string): Buffer
  function readFileSync(p: string, encoding: 'utf8'): string
  function readFileSync(p: string, encoding?: 'utf8'): Buffer | string {
    return encoding ? readFile(p).toString('utf8') : readFile(p)
  }
  function readdirAsync(p: string, o?: { recursive?: boolean }): Promise<string[]>
  function readdirAsync(p: string, o: { withFileTypes: true; recursive?: boolean }): Promise<OsDirent[]>
  function readdirAsync(p: string, o?: { withFileTypes?: boolean; recursive?: boolean }): Promise<string[] | OsDirent[]> {
    return syncly(() => readdir(p, o))
  }
  function readFileAsync(p: string): Promise<Buffer>
  function readFileAsync(p: string, encoding: 'utf8'): Promise<string>
  function readFileAsync(p: string, encoding?: 'utf8'): Promise<Buffer | string> {
    return syncly(() => (encoding ? readFile(p).toString('utf8') : readFile(p)))
  }
  const fstat = (fd: number) => statOf(fdOf(fd, 'fstat').node)
  const fchmod = (fd: number, mode: number) => {
    const n = fdOf(fd, 'fchmod').node
    n.perm = windows ? (mode & 0o200 ? 0o666 : 0o444) : mode & 0o7777
  }
  const handle = (fd: number): OsFileHandle => ({
    fd,
    stat: () => syncly(() => fstat(fd)),
    read: (buffer, offset, length, position) => syncly(() => ({ bytesRead: readFd(fd, buffer, offset, length, position) })),
    write: (data) => syncly(() => void writeFd(fd, data)),
    chmod: (mode) => syncly(() => fchmod(fd, mode)),
    close: () => syncly(() => closeFd(fd)),
  })
  const promises: OsFilesAsync = {
    access: (p) => syncly(() => void existing(p, true, 'access')),
    stat: (p) => syncly(() => statSync(p)),
    lstat: (p) => syncly(() => lstatSync(p)),
    readdir: readdirAsync,
    readFile: readFileAsync,
    writeFile: (p, data, o) => syncly(() => writeFile(p, data, o)),
    appendFile: (p, data, o) => syncly(() => writeFile(p, data, { flag: 'a', mode: o?.mode })),
    mkdir: (p, o) => syncly(() => mkdir(p, o)),
    mkdtemp: (prefix) => syncly(() => mkdtemp(prefix)),
    rename: (a, b) => syncly(() => rename(a, b)),
    copyFile: (a, b, mode) => syncly(() => copyFile(a, b, mode)),
    cp: (a, b, o) => copyTreeAsync(promises, a, b, o, family, P),
    unlink: (p) => syncly(() => unlink(p)),
    rmdir: (p) => syncly(() => rmdir(p)),
    rm: (p, o) => syncly(() => rm(p, o)),
    symlink: (t, p, k) => syncly(() => symlink(t, p, k)),
    readlink: (p) => syncly(() => readlink(p)),
    realpath: (p) => syncly(() => realpathNative(p)),
    link: (a, b) => syncly(() => hardLink(a, b)),
    chmod: (p, mode) => syncly(() => chmod(p, mode)),
    utimes: (p, a, m) => syncly(() => utimes(p, a, m)),
    open: (p, flags, mode) => syncly(() => handle(open(p, flags, mode))),
  }
  function realpathNative(p: string): string {
    const f = lookup(p, true, 'realpath')
    if (!f.node) throw fsError('ENOENT', 'realpath', p)
    return f.native
  }

  const files: OsFiles = {
    constants,
    existsSync: (p) => {
      try {
        return lookup(p, true, 'access').node !== undefined
      } catch {
        return false
      }
    },
    statSync,
    lstatSync,
    readdirSync,
    readFileSync,
    writeFileSync: writeFile,
    appendFileSync: (p, data, o) => writeFile(p, data, { flag: 'a', mode: o?.mode }),
    mkdirSync: mkdir,
    mkdtempSync: mkdtemp,
    renameSync: rename,
    copyFileSync: copyFile,
    cpSync: (a, b, o) => copyTreeSync(files, a, b, o, family, P),
    unlinkSync: unlink,
    rmdirSync: rmdir,
    rmSync: rm,
    symlinkSync: symlink,
    readlinkSync: readlink,
    realpathSync: (p) => {
      const f = lookup(p, true, 'lstat')
      if (!f.node) throw fsError('ENOENT', 'lstat', p)
      return f.given
    },
    realpathNativeSync: realpathNative,
    linkSync: hardLink,
    chmodSync: chmod,
    utimesSync: utimes,
    openSync: open,
    readSync: readFd,
    writeSync: writeFd,
    fstatSync: fstat,
    fchmodSync: fchmod,
    closeSync: closeFd,
    createReadStream,
    watch,
    promises,
  }
  // ---- the environment ----
  const vars = new Map<string, string>()
  const defaults: Env = windows
    ? {
        Path: 'C:\\Windows\\System32;C:\\Windows;C:\\Program Files\\nodejs',
        PATHEXT: DEFAULT_PATHEXT,
        SystemRoot: 'C:\\Windows',
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        USERPROFILE: HOME,
        USERNAME: 'person',
        APPDATA: `${HOME}\\AppData\\Roaming`,
        LOCALAPPDATA: `${HOME}\\AppData\\Local`,
        TEMP: `${HOME}\\AppData\\Local\\Temp`,
        TMP: `${HOME}\\AppData\\Local\\Temp`,
      }
    : { PATH: '/usr/local/bin:/usr/bin:/bin', HOME, USER: 'person', SHELL: '/bin/sh', TMPDIR: '/tmp' }
  const setVar = (name: string, value: string | undefined) => {
    const key = windows ? ([...vars.keys()].find((k) => fold(k) === fold(name)) ?? name) : name
    if (value === undefined) vars.delete(key)
    else vars.set(key, value)
  }
  for (const [k, v] of Object.entries({ ...defaults, ...(options.env ?? {}) })) setVar(k, v)
  const env = {
    get: (name: string) => envValue(Object.fromEntries(vars), name, family),
    all: (): Env => Object.fromEntries(vars),
    set: setVar,
    home: HOME,
    get temp() {
      return envValue(Object.fromEntries(vars), windows ? 'TEMP' : 'TMPDIR', family) ?? (windows ? `${HOME}\\AppData\\Local\\Temp` : '/tmp')
    },
    execPath: windows ? 'C:\\Program Files\\nodejs\\node.exe' : '/usr/local/bin/node',
    username: 'person',
    cwd: () => cwd,
  }
  // The folders every machine of the family has
  for (const dir of windows ? [HOME, env.temp, `${HOME}\\AppData\\Roaming`, 'C:\\Windows\\System32', 'C:\\Program Files\\nodejs', cwd] : [HOME, '/tmp', '/usr/bin', '/usr/local/bin', '/bin', '/dev', cwd]) {
    mkdir(dir, { recursive: true })
  }
  for (const v of options.volumes ?? []) if (!windows) {
    mkdir(v, { recursive: true })
    const f = lookup(v, false, 'mount')
    const vol = newDir(f.parent, devSeq++)
    f.parent.entries.set(fold(f.name), { name: f.name, node: vol })
  }
  const devNull = windows ? '\\\\.\\nul' : '/dev/null'

  // ---- processes ----
  type Proc = {
    row: ProcessRow
    child: MemoryChild
    traps: Array<(signal: NodeJS.Signals) => boolean | void>
    ended: AbortController
    terminate: (exit: OsExit) => void
  }
  const programs = new Map<string, { program: Program; sync?: SyncProgram }>()
  const procs = new Map<number, Proc>()
  const table: ProcessRow[] = []
  let pidSeq = windows ? 4000 : 2000
  const HOST_PID = windows ? 1200 : 1000

  const programKey = (path: string) => pathKey(path, family, cwd)

  /** The program file `command` names, as the OS would find it from `cwdPath` and `childEnv` */
  function findProgram(command: string, cwdPath: string, childEnv: Env): { path: string } | { error: string } {
    const isFile = (p: string) => {
      try {
        return existing(p, true, 'spawn').kind === 'file'
      } catch {
        return false
      }
    }
    const candidates: string[] = []
    const withExts = (p: string) => programCandidates(p, family)
    if (/[\\/]/.test(command)) candidates.push(...withExts(P.resolve(cwdPath, command)))
    else if (windows) {
      // Windows' process creation looks in the working folder first, then PATH (libuv's search_path)
      candidates.push(...withExts(win32.join(cwdPath, command)))
      for (const dir of (envValue(childEnv, 'PATH', family) ?? '').split(';').filter(Boolean)) candidates.push(...withExts(win32.join(dir.replaceAll('"', ''), command)))
    } else {
      for (const dir of (childEnv.PATH ?? '').split(':').filter(Boolean)) candidates.push(posix.join(dir, command))
    }
    for (const c of candidates) {
      if (!isFile(c)) continue
      if (windows && /\.(cmd|bat)$/i.test(c)) return { error: 'EINVAL' }
      if (programs.has(programKey(c))) return { path: c }
      return { error: 'EACCES' }
    }
    return { error: 'ENOENT' }
  }

  class MemoryChild extends EventEmitter implements OsChild {
    pid: number | undefined = undefined
    spawnedAt: number
    stdin: Writable | null = null
    stdout: Readable | null = null
    stderr: Readable | null = null
    stdio: Array<Readable | Writable | Duplex | null> = []
    exitCode: number | null = null
    signalCode: NodeJS.Signals | null = null
    killed = false
    exited: Promise<OsExit & { error?: OsError }>
    settle!: (exit: OsExit & { error?: OsError }) => void
    constructor(at: number) {
      super()
      this.spawnedAt = at
      this.exited = new Promise((resolve) => (this.settle = resolve))
      // `exited` carries a start that failed, as the real child's does: an `'error'` nobody listens to is no crash
      this.on('error', () => {})
    }
    /** The family's rule for which signals are sent (`signalRefusal`); a refused one throws and ends nothing */
    kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
      const refused = signalRefusal(signal, family)
      if (refused === 'ERR_UNKNOWN_SIGNAL') throw signalError(signal, refused)
      const p = this.pid === undefined ? undefined : procs.get(this.pid)
      if (!p || !p.row.alive) return false
      if (refused) throw signalError(signal, refused)
      this.killed = true
      // Node reports a Windows child it ended with the signal it was sent
      deliver(p, signal, { code: null, signal })
      return true
    }
    unref(): void {
      // Nothing keeps a test's process alive but the test
    }
  }

  /**
   * A signal the family sends (`signalRefusal` has passed it) to a process. Windows ends it at once, as `exit` says
   * (a child's own `kill`: no code and the signal; `process.kill` by pid: code 1, as Windows reports a process ended from
   * outside). POSIX lets a program trap it (never KILL), does nothing for one ignored by default, else ends it.
   */
  function deliver(p: Proc, signal: NodeJS.Signals, windowsExit: OsExit = { code: 1, signal: null }) {
    if (!p.row.alive) return
    if (windows) return p.terminate(windowsExit)
    if (signal !== 'SIGKILL' && p.traps.some((t) => t(signal) === true)) return
    if (IGNORED_BY_DEFAULT.has(signal)) return
    p.terminate({ code: null, signal })
  }

  /**
   * An output pipe and the processes that hold its writing end: it ends only when the last one has, so a grandchild
   * given its parent's stdout (`'inherit'`) holds the host's pipe open after the child has exited, as on a real OS
   */
  type OutPipe = { stream: PassThrough; holders: number; onEnd: Array<() => void> }
  const holdPipe = (pipe: OutPipe) => (pipe.holders++, pipe)
  const releasePipe = (pipe: OutPipe) => {
    if (--pipe.holders > 0) return
    pipe.stream.end()
    for (const f of pipe.onEnd.splice(0)) f()
  }

  function startProcess(
    command: string,
    args: readonly string[],
    o: StartOptions,
    ppid: number,
    parentGroup: number,
    parentPipes?: { stdout: OutPipe; stderr: OutPipe },
  ): OsChild {
    const child = new MemoryChild(nowMs)
    const cwdPath = o.cwd ?? env.cwd()
    const childEnv = o.env ?? env.all()
    const fail = (code: string) => {
      const error = fsError(code, `spawn ${command}`, command)
      later(() => {
        child.emit('error', error)
        child.settle({ code: null, signal: null, error })
      })
      return child
    }
    let cwdNode: Node
    try {
      cwdNode = existing(cwdPath, true, 'spawn')
      if (cwdNode.kind !== 'dir') return fail('ENOENT')
    } catch {
      return fail('ENOENT')
    }
    const found = findProgram(command, cwdPath, childEnv)
    if ('error' in found) return fail(found.error)
    const entry = programs.get(programKey(found.path))
    if (!entry) return fail('EACCES')
    const programNode = existing(found.path, true, 'spawn')
    const pid = pidSeq
    pidSeq += windows ? 4 : 1
    const contained = o.contained !== false
    const row: ProcessRow = { pid, ppid, pgid: !windows && contained ? pid : parentGroup, command, args: [...args], cwd: cwdPath, alive: true, exit: null }
    table.push(row)
    child.pid = pid

    const stdio = o.stdio ?? ['pipe', 'pipe', 'pipe']
    const programStdin = new PassThrough()
    let extra: Duplex | null = null
    const hostSide: Array<Readable | Writable | Duplex | null> = []
    // fd 0: a pipe from the host, a file the host opened (read from its position), or nothing
    if (stdio[0] === 'pipe') {
      child.stdin = programStdin
      hostSide.push(programStdin)
    } else if (typeof stdio[0] === 'number') {
      const d = fdOf(stdio[0], 'read')
      programStdin.end(d.node.kind === 'file' ? d.node.data.subarray(d.pos) : Buffer.alloc(0))
      hostSide.push(null)
    } else {
      programStdin.end()
      hostSide.push(null)
    }
    // fd 1 and 2: a pipe to the host, a file, the parent program's own pipe (`'inherit'`), or nowhere
    const held: OutPipe[] = []
    const outFor = (spec: OsStdio | undefined, inherited: OutPipe | undefined): { pipe: OutPipe; host: Readable | null } => {
      if (spec === 'inherit' && inherited) {
        held.push(holdPipe(inherited))
        return { pipe: inherited, host: null }
      }
      const pipe = holdPipe({ stream: new PassThrough(), holders: 0, onEnd: [] })
      held.push(pipe)
      if (spec === 'pipe' || spec === undefined) return { pipe, host: pipe.stream }
      if (typeof spec === 'number') {
        const fd = dupFd(spec)
        pipe.stream.on('data', (d: Buffer) => writeFd(fd, d))
        pipe.stream.on('end', () => closeFd(fd))
        return { pipe, host: null }
      }
      pipe.stream.resume()
      return { pipe, host: null }
    }
    const out = outFor(stdio[1], parentPipes?.stdout)
    const err = outFor(stdio[2], parentPipes?.stderr)
    child.stdout = out.host
    child.stderr = err.host
    hostSide.push(child.stdout, child.stderr)
    if (stdio[3] === 'overlapped') {
      const toProgram = new PassThrough()
      const toHost = new PassThrough()
      extra = Duplex.from({ readable: toProgram, writable: toHost })
      hostSide.push(Duplex.from({ readable: toHost, writable: toProgram }))
    }
    child.stdio = hostSide

    const ended = new AbortController()
    if (windows) {
      hold(heldDirs, cwdNode)
      hold(runningFiles, programNode)
    }
    const proc: Proc = {
      row,
      child,
      traps: [],
      ended,
      terminate: (exit) => {
        if (!row.alive) return
        row.alive = false
        row.exit = exit
        ended.abort()
        if (windows) {
          release(heldDirs, cwdNode)
          release(runningFiles, programNode)
        }
        // Input it never read: the host's write fails as a write to a closed pipe does (EPIPE)
        if (programStdin.writableLength > 0) programStdin.destroy(Object.assign(new Error('write EPIPE'), { code: 'EPIPE', syscall: 'write' }))
        for (const pipe of held) releasePipe(pipe)
        extra?.end()
        child.exitCode = exit.code
        child.signalCode = exit.signal
        later(() => {
          child.emit('exit', exit.code, exit.signal)
          child.settle(exit)
          // 'close' once its output has ended: at once, unless something it started still holds its pipes
          const open = [...new Set([out.pipe, err.pipe])].filter((p) => p.holders > 0)
          let left = open.length
          const closed = () => later(() => child.emit('close', exit.code, exit.signal))
          if (left === 0) closed()
          for (const p of open) p.onEnd.push(() => --left === 0 && closed())
        })
      },
    }
    procs.set(pid, proc)

    const pipes = { stdout: out.pipe, stderr: err.pipe }
    const ctx: ProgramContext = {
      args: [...args],
      cwd: cwdPath,
      env: childEnv,
      pid,
      stdin: programStdin,
      stdout: out.pipe.stream,
      stderr: err.pipe.stream,
      extra,
      os: memory,
      // A program's children stay in its group unless it contains them, as a plain spawn does; `'inherit'` hands them its pipes
      start: (c, a, so = {}) => startProcess(c, a, { contained: false, ...so }, pid, row.pgid, pipes),
      onSignal: (listener) => void proc.traps.push(listener),
      ended: ended.signal,
    }
    later(() => {
      child.emit('spawn')
      Promise.resolve()
        .then(() => entry.program({ ...ctx, os: memory }))
        .then(
          (code) => proc.terminate({ code: typeof code === 'number' ? code : 0, signal: null }),
          (e: unknown) => {
            if (row.alive && !err.pipe.stream.writableEnded) err.pipe.stream.write(String(asError(e).stack ?? e))
            proc.terminate({ code: 1, signal: null })
          },
        )
    })
    return child
  }

  const descendants = (pid: number): Proc[] => {
    const out: Proc[] = []
    const walk = (p: number) => {
      for (const q of procs.values()) {
        if (q.row.ppid === p && !out.includes(q)) {
          out.push(q)
          walk(q.row.pid)
        }
      }
    }
    walk(pid)
    return out
  }

  async function stop(child: OsChild, graceMs: number): Promise<OsExit> {
    const pid = child.pid
    const root = pid === undefined ? undefined : procs.get(pid)
    if (!root) {
      const e = await child.exited
      return { code: e.code, signal: e.signal }
    }
    const tree = [root, ...descendants(root.row.pid)]
    if (windows) {
      // taskkill /T /F: the tree at once, code 1
      for (const p of tree) p.terminate({ code: 1, signal: null })
    } else {
      // TERM to every group in the tree but the host's, then KILL to what is left of it after the grace
      const groups = new Set(tree.map((p) => p.row.pgid).filter((g) => g !== HOST_PID))
      const hit = [...procs.values()].filter((p) => p.row.alive && groups.has(p.row.pgid))
      for (const p of hit) deliver(p, 'SIGTERM')
      if (root.row.alive && !groups.has(root.row.pgid)) deliver(root, 'SIGTERM')
      clock.setTimeout(() => {
        for (const p of [...hit, root]) if (p.row.alive) deliver(p, 'SIGKILL')
      }, graceMs)
    }
    const exit = await child.exited
    if (!windows && root.row.pgid === root.row.pid) {
      // Its group is swept once it has gone: TERM, then KILL after the grace
      const left = [...procs.values()].filter((p) => p.row.alive && p.row.pgid === root.row.pid)
      for (const p of left) deliver(p, 'SIGTERM')
      if (left.length) clock.setTimeout(() => left.forEach((p) => p.row.alive && deliver(p, 'SIGKILL')), graceMs)
    }
    return { code: exit.code, signal: exit.signal }
  }

  /**
   * As Node's `spawnSync`: past `maxBuffer` on either stream (default 1 MiB) it answers `ENOBUFS` with what was
   * written, and past `timeoutMs` (the program's `ms`) `ETIMEDOUT`; both as ended by SIGTERM
   */
  function runSync(command: string, args: readonly string[], o?: RunSyncOptions & { encoding?: 'utf8' }): RunSyncResult
  function runSync(command: string, args: readonly string[], o: RunSyncOptions & { encoding: 'buffer' }): RunSyncResult<Buffer>
  function runSync(command: string, args: readonly string[], o: RunSyncOptions = {}): RunSyncResult<string | Buffer> {
    const text = (b: Buffer) => (o.encoding === 'buffer' ? b : b.toString('utf8'))
    const cwdPath = o.cwd ?? env.cwd()
    const found = findProgram(command, cwdPath, o.env ?? env.all())
    if ('error' in found) return { code: null, signal: null, stdout: text(Buffer.alloc(0)), stderr: text(Buffer.alloc(0)), error: fsError(found.error, `spawnSync ${command}`, command) }
    const entry = programs.get(programKey(found.path))
    if (!entry?.sync) throw new Error(`memoryOs: ${found.path} has no answer for runSync (programs.add(path, program, { sync }))`)
    const input = o.input === undefined ? '' : typeof o.input === 'string' ? o.input : Buffer.from(o.input).toString('utf8')
    const r = entry.sync({ args, cwd: cwdPath, env: o.env ?? env.all(), input })
    const pid = pidSeq
    pidSeq += windows ? 4 : 1
    const stdout = bytes(r.stdout ?? '')
    const stderr = bytes(r.stderr ?? '')
    const max = o.maxBuffer ?? SYNC_MAX_BUFFER
    const failed = o.timeoutMs !== undefined && (r.ms ?? 0) > o.timeoutMs ? 'ETIMEDOUT' : stdout.length > max || stderr.length > max ? 'ENOBUFS' : null
    const exit: OsExit = failed ? { code: null, signal: 'SIGTERM' } : { code: r.code ?? 0, signal: null }
    table.push({ pid, ppid: HOST_PID, pgid: HOST_PID, command, args: [...args], cwd: cwdPath, alive: false, exit })
    return { ...exit, stdout: text(stdout), stderr: text(stderr), ...(failed ? { error: fsError(failed, `spawnSync ${command}`, command) } : {}) }
  }

  const shell = (line: string): [string, string[]] => (windows ? [commandInterpreter(env.all()), ['/d', '/s', '/c', line]] : ['/bin/sh', ['-c', line]])

  const processes: OsProcesses = {
    start: (command, args, o = {}) => startProcess(command, args, o, HOST_PID, HOST_PID),
    run: (command, args, o = {}) => runChild({ processes: { stop }, clock, files }, (stdio) => processes.start(command, args, { cwd: o.cwd, env: o.env, stdio }), o),
    runSync,
    runShell: (line, o = {}) => {
      const [command, args] = shell(line)
      return runChild({ processes: { stop }, clock, files }, (stdio) => processes.start(command, args, { cwd: o.cwd, env: o.env, stdio }), o)
    },
    stop,
    alive: (pid) => pid === HOST_PID || procs.get(pid)?.row.alive === true,
    signal: (pid, signal) => {
      const refused = signalRefusal(signal, family)
      if (refused === 'ERR_UNKNOWN_SIGNAL') throw signalError(signal, refused)
      const p = procs.get(pid)
      if (!p?.row.alive) return false
      if (refused) throw signalError(signal, refused)
      deliver(p, signal)
      return true
    },
    pid: HOST_PID,
  }

  const launchDeps = () => ({
    family,
    read: (p: string) => readFile(p).toString('utf8'),
    exists: (p: string) => files.existsSync(p) || files.lstatSync(p, { throwIfNoEntry: false }) !== undefined,
    node: env.execPath,
  })

  const memory: MemoryOs = {
    family,
    files,
    paths: {
      path: P,
      devNull,
      same: (a, b) => samePath(a, b, family, cwd),
      inside: (root, p) => isInside(root, p, family, cwd),
      key: (p) => pathKey(p, family, cwd),
      fromFileUrl: (url) => fileUrlToPath(url, family),
      toFileUrl: (p) => pathToFileUrl(P.resolve(p), family),
    },
    processes,
    tools: {
      find: (name) => findOnPath(name, env.all(), family, launchDeps().exists),
      program: (name) =>
        programFor(name, family, (n, pathExt) => findOnPath(n, pathExt ? { ...env.all(), PATHEXT: pathExt } : env.all(), family, launchDeps().exists), (p) => launchFor(p, launchDeps()), env.all()).path,
      resolve: (command, o = {}) => resolveCommand(command, o.env ?? env.all(), launchDeps(), o.cwd),
    },
    env,
    clock,
    sqlite: {
      open: (path, o = {}) => {
        if (!options.sqlite) throw Object.assign(new Error('memoryOs: no SQLite engine was given (memoryOs({ sqlite }))'), { code: 'ENOSYS' })
        return options.sqlite(path, o)
      },
    },
    traits,
    programs: {
      add: (path, program, o = {}) => {
        mkdir(P.dirname(path), { recursive: true })
        if (!lookup(path, true, 'open').node) writeFile(path, '')
        programs.set(programKey(path), { program, sync: o.sync })
      },
    },
    processTable: () => table,
  }
  return memory
}

export type { Timer }
