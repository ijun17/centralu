import Database from 'better-sqlite3'
import { spawn, spawnSync, type ChildProcess, type SpawnOptions, type StdioOptions } from 'node:child_process'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'
import { devNull, homedir, tmpdir, userInfo } from 'node:os'
import { stopTree } from '../dev-services/kill-tree.js'
import { killHandle, spawnGrouped, sweepExited } from '../dev-services/grouped-child.js'
import { whichTool } from '../env-path.js'
import { HOST_PLATFORM, familyOf, pathsOf, traitsFor } from '../os.js'
import { programPath, resolveCommand } from '../tool-launch.js'
import type {
  CopyTreeOptions,
  Env,
  LinkKind,
  Os,
  OsChild,
  OsDirent,
  OsError,
  OsExit,
  OsFileHandle,
  OsFiles,
  OsFilesAsync,
  OsStats,
  OsStdio,
  RunSyncResult,
  StartOptions,
  WatchListener,
} from './port.js'
import { envValue, fileUrlToPath, isInside, pathKey, pathToFileUrl, samePath, type OsFamily } from './rules.js'
import { abortReason, asOsError, errorCode } from './errors.js'
import { runChild } from './run.js'

/**
 * The `Os` of the machine the host runs on (#1599, docs/plans/os-layer.md §7.1): Node's own calls, and for what
 * differs between OSes the layer modules that already own it (`env-path.ts` and `tool-launch.ts` for finding and
 * starting programs, `kill-tree.ts` and `grouped-child.ts` for containing and ending trees, `os.ts` for the
 * questions). Nothing here decides anything those modules decide.
 */

/** The family of the OS the host runs on, for a test that holds the in-memory OS to this one (`memoryOs({ as: HOST_FAMILY })`) */
export const HOST_FAMILY: OsFamily = familyOf(HOST_PLATFORM)

const NS_PER_MS = 1_000_000n

function toStats(s: fs.BigIntStats): OsStats {
  return {
    isFile: () => s.isFile(),
    isDirectory: () => s.isDirectory(),
    isSymbolicLink: () => s.isSymbolicLink(),
    size: Number(s.size),
    mode: Number(s.mode),
    uid: Number(s.uid),
    nlink: Number(s.nlink),
    dev: s.dev,
    ino: s.ino,
    atimeMs: Number(s.atimeNs / NS_PER_MS),
    mtimeMs: Number(s.mtimeNs / NS_PER_MS),
    mtimeNs: s.mtimeNs,
    ctimeMs: Number(s.ctimeNs / NS_PER_MS),
    birthtimeMs: Number(s.birthtimeNs / NS_PER_MS),
  }
}

const constants = {
  O_RDONLY: fs.constants.O_RDONLY,
  O_WRONLY: fs.constants.O_WRONLY,
  O_RDWR: fs.constants.O_RDWR,
  O_CREAT: fs.constants.O_CREAT,
  O_EXCL: fs.constants.O_EXCL,
  O_TRUNC: fs.constants.O_TRUNC,
  O_APPEND: fs.constants.O_APPEND,
  // Windows has neither: Node leaves them undefined there
  O_NOFOLLOW: fs.constants.O_NOFOLLOW ?? 0,
  O_NONBLOCK: fs.constants.O_NONBLOCK ?? 0,
  COPYFILE_EXCL: fs.constants.COPYFILE_EXCL,
}

const handle = (h: fsp.FileHandle): OsFileHandle => ({
  fd: h.fd,
  stat: async () => toStats(await h.stat({ bigint: true })),
  read: async (buffer, offset, length, position) => ({ bytesRead: (await h.read(buffer, offset, length, position)).bytesRead }),
  write: async (data) => void (typeof data === 'string' ? await h.write(data) : await h.write(data)),
  chmod: (mode) => h.chmod(mode),
  close: () => h.close(),
})

function readdirAsync(p: string, o?: { recursive?: boolean }): Promise<string[]>
function readdirAsync(p: string, o: { withFileTypes: true; recursive?: boolean }): Promise<OsDirent[]>
function readdirAsync(p: string, o?: { withFileTypes?: boolean; recursive?: boolean }): Promise<string[] | OsDirent[]> {
  return o?.withFileTypes ? fsp.readdir(p, { withFileTypes: true, recursive: o.recursive }) : fsp.readdir(p, { encoding: 'utf8', recursive: o?.recursive })
}
function readFileAsync(p: string): Promise<Buffer>
function readFileAsync(p: string, encoding: 'utf8'): Promise<string>
function readFileAsync(p: string, encoding?: 'utf8'): Promise<Buffer | string> {
  return encoding ? fsp.readFile(p, encoding) : fsp.readFile(p)
}

const promises: OsFilesAsync = {
  access: (p) => fsp.access(p),
  stat: async (p) => toStats(await fsp.stat(p, { bigint: true })),
  lstat: async (p) => toStats(await fsp.lstat(p, { bigint: true })),
  readdir: readdirAsync,
  readFile: readFileAsync,
  writeFile: (p, data, o) => fsp.writeFile(p, data, o),
  appendFile: (p, data, o) => fsp.appendFile(p, data, o),
  mkdir: async (p, o) => void (await fsp.mkdir(p, o)),
  mkdtemp: (prefix) => fsp.mkdtemp(prefix),
  rename: (a, b) => fsp.rename(a, b),
  copyFile: (a, b, mode) => fsp.copyFile(a, b, mode),
  cp: (a, b, o?: CopyTreeOptions) => fsp.cp(a, b, o),
  unlink: (p) => fsp.unlink(p),
  rmdir: (p) => fsp.rmdir(p),
  rm: (p, o) => fsp.rm(p, o),
  symlink: (target, p, kind?: LinkKind) => fsp.symlink(target, p, kind),
  readlink: (p) => fsp.readlink(p),
  realpath: (p) => fsp.realpath(p),
  link: (a, b) => fsp.link(a, b),
  chmod: (p, mode) => fsp.chmod(p, mode),
  utimes: (p, a, m) => fsp.utimes(p, a, m),
  open: async (p, flags, mode) => handle(await fsp.open(p, flags, mode)),
}

function statSync(p: string): OsStats
function statSync(p: string, o: { throwIfNoEntry: false }): OsStats | undefined
function statSync(p: string, o?: { throwIfNoEntry: false }): OsStats | undefined {
  const s = fs.statSync(p, { bigint: true, throwIfNoEntry: o?.throwIfNoEntry ?? true })
  return s ? toStats(s) : undefined
}
function lstatSync(p: string): OsStats
function lstatSync(p: string, o: { throwIfNoEntry: false }): OsStats | undefined
function lstatSync(p: string, o?: { throwIfNoEntry: false }): OsStats | undefined {
  const s = fs.lstatSync(p, { bigint: true, throwIfNoEntry: o?.throwIfNoEntry ?? true })
  return s ? toStats(s) : undefined
}
function readdirSync(p: string, o?: { recursive?: boolean }): string[]
function readdirSync(p: string, o: { withFileTypes: true; recursive?: boolean }): OsDirent[]
function readdirSync(p: string, o?: { withFileTypes?: boolean; recursive?: boolean }): string[] | OsDirent[] {
  return o?.withFileTypes ? fs.readdirSync(p, { withFileTypes: true, recursive: o.recursive }) : fs.readdirSync(p, { encoding: 'utf8', recursive: o?.recursive })
}
function readFileSync(p: string): Buffer
function readFileSync(p: string, encoding: 'utf8'): string
function readFileSync(p: string, encoding?: 'utf8'): Buffer | string {
  return encoding ? fs.readFileSync(p, encoding) : fs.readFileSync(p)
}

const files: OsFiles = {
  constants,
  existsSync: (p) => fs.existsSync(p),
  statSync,
  lstatSync,
  readdirSync,
  readFileSync,
  writeFileSync: (p, data, o) => fs.writeFileSync(p, data, o),
  appendFileSync: (p, data, o) => fs.appendFileSync(p, data, o),
  mkdirSync: (p, o) => void fs.mkdirSync(p, o),
  mkdtempSync: (prefix) => fs.mkdtempSync(prefix),
  renameSync: (a, b) => fs.renameSync(a, b),
  copyFileSync: (a, b, mode) => fs.copyFileSync(a, b, mode),
  cpSync: (a, b, o) => fs.cpSync(a, b, o),
  unlinkSync: (p) => fs.unlinkSync(p),
  rmdirSync: (p) => fs.rmdirSync(p),
  rmSync: (p, o) => fs.rmSync(p, o),
  symlinkSync: (target, p, kind) => fs.symlinkSync(target, p, kind),
  readlinkSync: (p) => fs.readlinkSync(p),
  realpathSync: (p) => fs.realpathSync(p),
  realpathNativeSync: (p) => fs.realpathSync.native(p),
  linkSync: (a, b) => fs.linkSync(a, b),
  chmodSync: (p, mode) => fs.chmodSync(p, mode),
  utimesSync: (p, a, m) => fs.utimesSync(p, a, m),
  openSync: (p, flags, mode) => fs.openSync(p, flags, mode),
  readSync: (fd, buffer, offset, length, position) => fs.readSync(fd, buffer, offset, length, position),
  writeSync: (fd, data) => (typeof data === 'string' ? fs.writeSync(fd, data) : fs.writeSync(fd, data)),
  fstatSync: (fd) => toStats(fs.fstatSync(fd, { bigint: true })),
  fchmodSync: (fd, mode) => fs.fchmodSync(fd, mode),
  closeSync: (fd) => fs.closeSync(fd),
  createReadStream: (p, o) => fs.createReadStream(p, o),
  watch: (p, o, listener: WatchListener) => fs.watch(p, { recursive: o.recursive }, (event, name) => listener(event, name === null ? null : String(name))),
  promises,
}

/**
 * A Node child as an `OsChild`: its events and fields passed on. A start Node refuses at once (`EINVAL` for a Windows
 * batch file) becomes a child that never started and says so with `'error'`, as one that is not found does.
 */
class RealChild extends EventEmitter implements OsChild {
  readonly exited: Promise<OsExit & { error?: OsError }>
  constructor(
    readonly node: ChildProcess | null,
    readonly spawnedAt: number,
    failed?: OsError,
  ) {
    super()
    // `exited` carries a start that failed: an `'error'` nobody else listens to is no crash
    this.on('error', () => {})
    this.exited = new Promise((resolve) => {
      if (!node) {
        process.nextTick(() => {
          const error = failed ?? asOsError(new Error('not started'))
          this.emit('error', error)
          resolve({ code: null, signal: null, error })
        })
        return
      }
      node.once('spawn', () => this.emit('spawn'))
      node.once('exit', (code, signal) => {
        this.emit('exit', code, signal)
        resolve({ code, signal })
      })
      node.once('close', (code: number | null, signal: NodeJS.Signals | null) => this.emit('close', code, signal))
      node.on('error', (e) => {
        const error = asOsError(e)
        this.emit('error', error)
        if (node.pid === undefined) resolve({ code: null, signal: null, error })
      })
    })
  }
  get pid() {
    return this.node?.pid
  }
  get stdin() {
    return this.node?.stdin ?? null
  }
  get stdout() {
    return this.node?.stdout ?? null
  }
  get stderr() {
    return this.node?.stderr ?? null
  }
  get stdio() {
    return this.node ? this.node.stdio.map((s): Readable | Writable | null => s ?? null) : [null, null, null]
  }
  get exitCode() {
    return this.node?.exitCode ?? null
  }
  get signalCode() {
    return this.node?.signalCode ?? null
  }
  get killed() {
    return this.node?.killed ?? false
  }
  kill(signal?: NodeJS.Signals): boolean {
    return this.node?.kill(signal) ?? false
  }
}

function asChild(start: () => { child: ChildProcess; spawnedAt: number }): RealChild {
  const before = Date.now()
  try {
    const { child, spawnedAt } = start()
    return new RealChild(child, spawnedAt)
  } catch (e) {
    return new RealChild(null, before, asOsError(e))
  }
}

const stdioFor = (stdio: readonly OsStdio[] | undefined): StdioOptions => (stdio ? [...stdio] : ['pipe', 'pipe', 'pipe'])

function start(command: string, args: readonly string[], o: StartOptions = {}, shell = false): RealChild {
  const options: SpawnOptions = { cwd: o.cwd, env: o.env ?? process.env, stdio: stdioFor(o.stdio), shell, windowsHide: true }
  if (o.contained === false) {
    return asChild(() => {
      const spawnedAt = Date.now()
      return { child: spawn(command, [...args], { ...options, windowsHide: true }), spawnedAt }
    })
  }
  return asChild(() => spawnGrouped(command, args, options))
}

async function stop(child: OsChild, graceMs: number): Promise<OsExit> {
  if (!(child instanceof RealChild)) throw new TypeError('realOs().processes.stop: a child the real OS started')
  const node = child.node
  const running = () => node !== null && node.exitCode === null && node.signalCode === null
  if (node?.pid !== undefined && running()) stopTree(killHandle(node), graceMs, running)
  const exit = await child.exited
  if (node?.pid !== undefined) await sweepExited({ pid: node.pid, spawnedAt: child.spawnedAt, exitedAt: Date.now() })
  return { code: exit.code, signal: exit.signal }
}

function runSync(command: string, args: readonly string[], o: { cwd?: string; env?: Env; input?: string | Uint8Array; timeoutMs?: number; maxBuffer?: number } = {}): RunSyncResult {
  const r = spawnSync(command, [...args], {
    cwd: o.cwd,
    env: o.env ?? process.env,
    input: o.input,
    timeout: o.timeoutMs,
    maxBuffer: o.maxBuffer,
    encoding: 'utf8',
    windowsHide: true,
  })
  return { code: r.status, signal: r.signal, stdout: r.stdout ?? '', stderr: r.stderr ?? '', ...(r.error ? { error: asOsError(r.error) } : {}) }
}

const family = HOST_FAMILY
const clock: Os['clock'] = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => {
    const t = setTimeout(callback, ms)
    t.unref()
    return { cancel: () => clearTimeout(t) }
  },
  sleep: (ms, o) =>
    new Promise((resolve, reject) => {
      const signal = o?.signal
      if (signal?.aborted) return reject(abortReason(signal))
      const t = setTimeout(resolve, ms)
      t.unref()
      signal?.addEventListener('abort', () => (clearTimeout(t), reject(abortReason(signal))), { once: true })
    }),
}

let username: string | undefined

const realOsValue: Os = {
  files,
  paths: {
    path: pathsOf(),
    devNull,
    same: (a, b) => samePath(a, b, family),
    inside: (root, p) => isInside(root, p, family),
    key: (p) => pathKey(p, family),
    fromFileUrl: (url) => fileUrlToPath(url, family),
    toFileUrl: (p) => pathToFileUrl(p, family),
  },
  processes: {
    start: (command, args, o) => start(command, args, o),
    run: (command, args, o = {}) => runChild({ processes: { stop }, clock, files }, (stdio) => start(command, args, { cwd: o.cwd, env: o.env, stdio }), o),
    runSync: (command, args, o) => runSync(command, args, o),
    runShell: (line, o = {}) => runChild({ processes: { stop }, clock, files }, (stdio) => start(line, [], { cwd: o.cwd, env: o.env, stdio }, true), o),
    stop,
    alive: (pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch (e) {
        return errorCode(e) === 'EPERM'
      }
    },
    pid: process.pid,
  },
  tools: {
    find: (name) => whichTool(name),
    program: (name) => programPath(name),
    resolve: (command, o = {}) => resolveCommand(command, o.env ?? process.env, undefined, o.cwd),
  },
  env: {
    get: (name) => envValue(process.env, name, family),
    all: () => ({ ...process.env }),
    set: (name, value) => {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    },
    home: homedir(),
    temp: tmpdir(),
    execPath: process.execPath,
    get username() {
      if (username === undefined) {
        try {
          username = userInfo().username
        } catch {
          username = envValue(process.env, family === 'windows' ? 'USERNAME' : 'USER', family) ?? ''
        }
      }
      return username
    },
    cwd: () => process.cwd(),
  },
  clock,
  sqlite: {
    open: (path, o = {}) => new Database(path, { readonly: o.readonly, fileMustExist: o.fileMustExist, timeout: o.timeout }),
  },
  traits: traitsFor(),
}

/** The machine's own OS. One for the process: it holds no state of its own. */
export function realOs(): Os {
  return realOsValue
}

