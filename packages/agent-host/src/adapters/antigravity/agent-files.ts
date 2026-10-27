import { spawn as spawnChild } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, createReadStream, createWriteStream, existsSync, fstatSync, openSync, readFileSync, readSync, watch, type FSWatcher } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createInflateRaw } from 'node:zlib'
import { errorMessage } from '@cc/protocol'
import { asObj } from '../../json-value.js'
import { processStartTime } from '../../dev-services/instance-lock.js'
import { HOST_PLATFORM, type Platform } from '../../os.js'
import { readZipEntriesFrom, ZipError, zipEntryStart, type ZipEntry } from '../../zip.js'
import { InstallFailure } from './failure.js'
import { AGY_INSTALL_SPACE_BYTES, type AgyArchive, type AgyPlatformKey } from './release.js'

/**
 * The OS layer's part for Google's Antigravity agent (tooling/os-layer.js; docs/plans/antigravity-adapter.md §3, §4): a
 * program Centralu installs and runs from its own folder. Everything about it that touches the OS is here, so the rest of
 * the adapter (its setup, sign-in flow and ACP shape) knows no OS:
 *
 * - which of Google's builds this machine takes (`agyPlatformKey`)
 * - the folder layout under Centralu's data folder, and what is on disk there (`agyHome`, `isInstalled`, `hasSignIn`)
 * - the install: the download to disk, the unpack with each OS's file modes, the one rename that puts it in place
 * - the sign-in's private folder, its `BROWSER` helper where the OS can run one, and the person's browser (`openInBrowser`)
 *
 * The folder, under `<data>/tools/antigravity/`:
 *
 *     <version>/             the server and its harness, side by side, and `install.json` written last
 *     gemini-home/           GEMINI_HOME: the agent's settings, token, conversations. Not versioned, so a session made
 *                            under one Centralu still loads under the next (ids are per GEMINI_HOME, spike §3)
 *     .install-<owner>-<random>/  an install in progress (removed when it ends, however it ends)
 *     .sign-in-<owner>-<random>/  a sign-in's browser helper and the address it hands over (removed when the sign-in ends)
 *
 * `<owner>` names the host process that made the folder (`ownerTag`), so another host never removes it while that one runs
 */

/** The registry's name for this machine's build, or null where Google ships none (a 32-bit or another OS) */
export function agyPlatformKey(platform: Platform = HOST_PLATFORM, arch: string = process.arch): AgyPlatformKey | null {
  const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : null
  if (!cpu) return null
  if (platform === 'darwin') return `darwin-${cpu}`
  if (platform === 'linux') return `linux-${cpu}`
  if (platform === 'win32') return `windows-${cpu}`
  return null
}

export type AgyHome = {
  root: string
  /** The installed version's folder */
  versionDir: string
  /** GEMINI_HOME: the `.gemini` folder itself, as the agent reads the variable */
  geminiHome: string
}

export function agyHome(dataDir: string, version: string): AgyHome {
  const root = join(dataDir, 'tools', 'antigravity')
  return { root, versionDir: join(root, version), geminiHome: join(root, 'gemini-home') }
}

/** The server's program in the installed folder */
export function agyProgram(home: AgyHome, archive: AgyArchive): string {
  return join(home.versionDir, archive.command)
}

/** The marker an install writes last, inside the folder it renames into place: present means the folder is whole */
export const INSTALL_MARKER = 'install.json'

/** Whether the pinned version is in place: its marker names the archive it came from, and every file is there */
export function isInstalled(home: AgyHome, archive: AgyArchive): boolean {
  try {
    const marker = asObj(JSON.parse(readFileSync(join(home.versionDir, INSTALL_MARKER), 'utf8')))
    if (marker.sha256 !== archive.sha256) return false
    return archive.files.every((f) => existsSync(join(home.versionDir, f)))
  } catch {
    return false
  }
}

/**
 * Whether the agent has a sign-in it will use without asking: `auth.type` in its settings, which `authenticate` writes and
 * every later process signs in from (spike §4), and the token file beside it (the file backend is forced, plan §4.2).
 * Only the settings are read; the token file is looked at, never opened.
 */
export function hasSignIn(home: AgyHome): boolean {
  const dir = join(home.geminiHome, 'antigravity-acp')
  try {
    const settings = asObj(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')))
    const auth = asObj(settings.auth)
    return typeof auth.type === 'string' && auth.type.length > 0 && existsSync(join(dir, 'acp_token.json'))
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The install (plan §3.2), only when the person asks (`agents.installTool`; nothing is downloaded at startup):
//
// 1. room: the folder's free space is read first, so a full disk is said before 100 MB arrive
// 2. download: the pinned archive into a fresh `.install-<random>` folder beside the install, hashed as it arrives
// 3. check: its sha256 against the pinned one; a mismatch removes it, and nothing of it is unpacked
// 4. unpack: exactly the files the release names, as plain files with plain names (no folder, no link, no path), each to
//    its declared size, into a `pkg` folder there, marked runnable; the marker (`install.json`) written last
// 5. put in place: `pkg` renamed to `<version>/` in one step, so the folder the launcher reads is whole or absent
// 6. tidy: the temporary folder and any older version removed (best effort: a running session may hold its files)

export type DownloadBody = { total: number | null; chunks: AsyncIterable<Uint8Array> }

/** What the install needs from the network and the disk's free space, apart for its tests */
export type InstallIo = {
  download(url: string, signal: AbortSignal): Promise<DownloadBody>
  /** Free bytes where `dir` is, or null when the OS cannot say */
  freeBytes(dir: string): Promise<number | null>
}

export const realInstallIo: InstallIo = {
  async download(url, signal) {
    // The archive as stored: `fetch` asks for gzip by itself, and Google's server then sends the zip gzipped with a
    // `content-length` of the gzipped size, which the decoded bytes never match (deep review of #1680, measured)
    const res = await fetch(url, { signal, redirect: 'follow', headers: { 'accept-encoding': 'identity' } })
    if (!res.ok || !res.body) throw new InstallFailure('network', `The download answered ${res.status} ${res.statusText}`.trim())
    return { total: decodedLength(res.headers), chunks: chunksOf(res.body) }
  },
  async freeBytes(dir) {
    try {
      const s = await statfs(dir)
      return s.bavail * s.bsize
    } catch {
      return null
    }
  },
}

/**
 * The size of the body `fetch` hands back, when the headers say it: `content-length` counts the bytes on the wire, so it is
 * the decoded size only with no `content-encoding` (a server may encode even when asked for `identity`; the sha256 still
 * decides then)
 */
export function decodedLength(headers: Headers): number | null {
  const encoding = headers.get('content-encoding')?.trim().toLowerCase()
  if (encoding && encoding !== 'identity') return null
  const length = Number(headers.get('content-length'))
  return Number.isFinite(length) && length > 0 ? length : null
}

/** A fetch body's chunks, as they arrive */
async function* chunksOf(body: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      yield value
    }
  } finally {
    reader.releaseLock()
  }
}

export type Progress = { received: number; total: number | null }

/** Progress is said at most this often by bytes (the archive is ~110 MB: about a hundred steps) */
const PROGRESS_STEP_BYTES = 1024 * 1024

export async function installAgy(
  home: AgyHome,
  archive: AgyArchive,
  version: string,
  opts: { io?: InstallIo; signal: AbortSignal; onProgress?: (p: Progress) => void; platform?: Platform },
): Promise<void> {
  const io = opts.io ?? realInstallIo
  const { signal } = opts
  if (isInstalled(home, archive)) return
  await mkdir(home.root, { recursive: true })
  await removeStale(home.root, '.install-')
  const free = await io.freeBytes(home.root)
  if (free !== null && free < AGY_INSTALL_SPACE_BYTES) {
    throw new InstallFailure('disk_space', `Antigravity needs about ${mb(AGY_INSTALL_SPACE_BYTES)} MB free to install; ${mb(free)} MB are free`)
  }
  const work = await mkdtemp(join(home.root, `.install-${ownerTag()}-`))
  try {
    const zip = join(work, 'archive.zip')
    const sha = await download(io, archive.url, zip, signal, opts.onProgress)
    if (sha !== archive.sha256) throw new InstallFailure('checksum', `The downloaded archive does not match the version Centralu pins (sha256 ${sha.slice(0, 12)}…)`)
    cancelled(signal)
    const pkg = join(work, 'pkg')
    await unpack(zip, archive, pkg, signal, opts.platform ?? HOST_PLATFORM)
    await rm(zip, { force: true })
    await writeFile(join(pkg, INSTALL_MARKER), `${JSON.stringify({ version, sha256: archive.sha256, url: archive.url })}\n`)
    cancelled(signal)
    // A folder there without a whole install (another version's sha, a damaged copy) is replaced; a whole one is kept
    if (isInstalled(home, archive)) return
    await rm(home.versionDir, { recursive: true, force: true })
    await renameHeld(pkg, home.versionDir)
  } catch (err) {
    throw asFailure(err, signal)
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {})
  }
  await removeOtherVersions(home)
}

async function download(io: InstallIo, url: string, to: string, signal: AbortSignal, onProgress?: (p: Progress) => void): Promise<string> {
  const body = await io.download(url, signal)
  const hash = createHash('sha256')
  const out = createWriteStream(to, { mode: 0o600 })
  const failed = new Promise<never>((_, reject) => out.once('error', reject))
  failed.catch(() => {})
  let received = 0
  let said = 0
  try {
    for await (const chunk of body.chunks) {
      cancelled(signal)
      hash.update(chunk)
      received += chunk.byteLength
      if (!out.write(chunk)) await Promise.race([new Promise<void>((resolve) => out.once('drain', () => resolve())), failed])
      if (received - said >= PROGRESS_STEP_BYTES) {
        said = received
        onProgress?.({ received, total: body.total })
      }
    }
    await Promise.race([new Promise<void>((resolve) => out.end(resolve)), failed])
  } finally {
    out.destroy()
  }
  if (body.total !== null && received !== body.total) throw new InstallFailure('network', `The download ended after ${received} of ${body.total} bytes`)
  onProgress?.({ received, total: body.total ?? received })
  return hash.digest('hex')
}

/**
 * Exactly the release's files, plain names only, each to its declared size; anything else refuses the archive. Read from the
 * file as a stream, entry by entry: only the zip's directory is held in memory, never the 110 MB archive or a 280 MB entry
 */
async function unpack(zip: string, archive: AgyArchive, dir: string, signal: AbortSignal, platform: Platform): Promise<void> {
  const fd = openSync(zip, 'r')
  let entries: ZipEntry[]
  let starts: Map<ZipEntry, number>
  try {
    const size = fstatSync(fd).size
    const read = (pos: number, len: number) => {
      const buf = Buffer.alloc(len)
      const got = readSync(fd, buf, 0, len, pos)
      return buf.subarray(0, got)
    }
    entries = readZipEntriesFrom(size, read, archive.files.length + 4).filter((e) => !(e.kind === 'dir' && e.size === 0))
    starts = new Map(entries.map((e) => [e, zipEntryStart(size, read, e)]))
  } finally {
    closeSync(fd)
  }
  const names = entries.map((e) => e.name).sort()
  const want = [...archive.files].sort()
  if (names.length !== want.length || names.some((n, i) => n !== want[i])) {
    throw new InstallFailure('unpack', `The archive holds ${names.join(', ') || 'nothing'}, not the files the release names (${want.join(', ')})`)
  }
  await mkdir(dir, { recursive: true })
  for (const e of entries) {
    if (e.kind !== 'file' || !/^[\w.-]+$/.test(e.name)) throw new InstallFailure('unpack', `The archive's entry ${e.name} is not a plain file`)
    if (e.method !== 0 && e.method !== 8) throw new InstallFailure('unpack', `The archive's entry ${e.name} uses compression method ${e.method}`)
    cancelled(signal)
    const path = join(dir, e.name)
    await unpackEntry(zip, e, starts.get(e) ?? 0, path, signal)
    // Windows has no run bit: a program there is one by its name
    if (platform !== 'win32') await chmod(path, 0o755)
  }
}

/**
 * One entry, from the archive's file to its own: inflated as it is read, and stopped the moment it passes the size it declares
 * (a zip bomb), so it is refused before more than that is written
 */
async function unpackEntry(zip: string, e: ZipEntry, start: number, path: string, signal: AbortSignal): Promise<void> {
  const tooLarge = () => new InstallFailure('unpack', `${e.name} does not unpack to the ${e.size} bytes it declares`)
  let written = 0
  const counted = new Transform({
    transform(chunk: Buffer, _enc, done) {
      written += chunk.length
      done(written > e.size ? tooLarge() : null, chunk)
    },
  })
  const out = createWriteStream(path, { mode: 0o755 })
  // An empty entry has no bytes to read (`createReadStream` reads to the end of the file when `end` is before `start`)
  const source = e.compressedSize > 0 ? createReadStream(zip, { start, end: start + e.compressedSize - 1 }) : null
  try {
    if (!source) {
      if (e.size > 0) throw tooLarge()
      await pipeline(async function* () {}, out, { signal })
    } else if (e.method === 8) await pipeline(source, createInflateRaw(), counted, out, { signal })
    else await pipeline(source, counted, out, { signal })
  } catch (err) {
    if (err instanceof InstallFailure || signal.aborted) throw err
    const code: unknown = err instanceof Error ? Reflect.get(err, 'code') : undefined
    if (code === 'ENOSPC' || code === 'EDQUOT') throw err
    throw new InstallFailure('unpack', `${e.name} could not be unpacked: ${errorMessage(err)}`)
  }
  if (written !== e.size) throw tooLarge()
}

function cancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new InstallFailure('cancelled', 'The install was cancelled')
}

function asFailure(err: unknown, signal: AbortSignal): InstallFailure {
  if (err instanceof InstallFailure) return err
  if (signal.aborted) return new InstallFailure('cancelled', 'The install was cancelled')
  const code: unknown = err instanceof Error ? Reflect.get(err, 'code') : undefined
  if (code === 'ENOSPC' || code === 'EDQUOT') return new InstallFailure('disk_space', 'The disk filled up while Antigravity was being installed')
  if (err instanceof ZipError) return new InstallFailure('unpack', err.message)
  if (err instanceof TypeError || code === 'ECONNRESET' || code === 'ENOTFOUND' || code === 'ETIMEDOUT' || code === 'EAI_AGAIN') {
    return new InstallFailure('network', `The download failed: ${errorMessage(err)}`)
  }
  return new InstallFailure('failed', errorMessage(err))
}

/**
 * What an earlier host left of an install or a sign-in it did not finish (it crashed, or was killed mid-way): removed when
 * this host starts (`AgySetup`), before any install or sign-in of its own (plan §3.2)
 */
export async function removeLeftovers(home: AgyHome): Promise<void> {
  await removeStale(home.root, '.install-')
  await removeStale(home.root, '.sign-in-')
}

/**
 * The folders of that kind whose owner is provably gone. Another host may share this data folder's `tools/` and be in
 * the middle of its own: the keeper's next host starts while the last one drains, and a second host on the same data
 * folder with another `--db` takes its own lock, not this folder (re-review of #1680: a second host's start removed a
 * live sign-in). So a folder goes only when the process its name records has ended, or that pid now belongs to a process
 * that started at another time; a folder whose owner cannot be told is kept
 */
async function removeStale(root: string, prefix: string): Promise<void> {
  const names = await readdir(root).catch((): string[] => [])
  const stale = names.filter((n) => n.startsWith(prefix) && ownerGone(n.slice(prefix.length)))
  await Promise.all(stale.map((n) => rm(join(root, n), { recursive: true, force: true }).catch(() => {})))
}

let ownStart: string | undefined

/**
 * This process, as a folder's name records its owner: `<pid>-<start>`, the start a short hash of when the process began
 * (`ps`), or `0` where that cannot be read (Windows). The pid alone could be another process's later
 */
export function ownerTag(pid: number = process.pid, startOf: (pid: number) => string | null = processStartTime): string {
  if (pid === process.pid && startOf === processStartTime) {
    ownStart ??= startKey(startOf(pid))
    return `${pid}-${ownStart}`
  }
  return `${pid}-${startKey(startOf(pid))}`
}

const startKey = (started: string | null) => (started ? createHash('sha256').update(started).digest('hex').slice(0, 8) : '0')

/**
 * Whether the process a folder's name records (after its prefix: `<pid>-<start>-<random>`) has provably ended: no
 * process has that pid, or the one that has it started at another time. A name without an owner, or an owner that may
 * still run (alive, its start unknown), is not gone
 */
export function ownerGone(rest: string, deps: { alive?: (pid: number) => boolean; startOf?: (pid: number) => string | null } = {}): boolean {
  const [, pidText, key] = /^(\d+)-([0-9a-f]{8}|0)-/.exec(rest) ?? []
  if (pidText === undefined || key === undefined) return false
  const pid = Number(pidText)
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  if (!(deps.alive ?? processAlive)(pid)) return true
  if (key === '0') return false
  const now = (deps.startOf ?? processStartTime)(pid)
  return now !== null && startKey(now) !== key
}

/** Whether a process has this pid (signal 0 tests without sending; EPERM means it exists, another user's) */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err instanceof Error ? Reflect.get(err, 'code') : undefined) === 'EPERM'
  }
}

/** Every version folder but the pinned one; `gemini-home` and the dot folders are never touched */
async function removeOtherVersions(home: AgyHome): Promise<void> {
  const names = await readdir(home.root).catch((): string[] => [])
  for (const n of names) {
    if (!/^\d+\.\d+\.\d+/.test(n)) continue
    const dir = join(home.root, n)
    if (dir === home.versionDir) continue
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * A rename Windows may refuse for a moment: a virus scanner holds a program just written (`EBUSY`, `EPERM`). Tried a few
 * times, a moment apart; anything else, or the last refusal, is the install's failure
 */
async function renameHeld(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (err) {
      const code: unknown = err instanceof Error ? Reflect.get(err, 'code') : undefined
      if (attempt >= 5 || (code !== 'EBUSY' && code !== 'EPERM')) throw err
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt))
    }
  }
}

const mb = (bytes: number) => Math.round(bytes / (1024 * 1024))

// ---------------------------------------------------------------------------------------------------------------------
// The sign-in's folder (plan §4)

export type SignInFolder = {
  /** The `BROWSER` helper, or null where none can be run (Windows: a batch file hands its argument to `cmd`, which splits it at `&`) */
  helper: string | null
  /** Calls `found` with what the helper wrote (a watch, and a look now for one written before the watch began) */
  watch(found: (text: string) => void): void
  /** Ends the watch and removes the folder */
  remove(): Promise<void>
}

/**
 * A folder only this user can read (0700) beside the install, for one sign-in: the `BROWSER` helper, which writes the one
 * argument it is given to `url` there through a temporary name, so the host never reads half an address
 */
export async function signInFolder(home: AgyHome, platform: Platform = HOST_PLATFORM): Promise<SignInFolder> {
  await mkdir(home.root, { recursive: true })
  await removeStale(home.root, '.sign-in-')
  const dir = await mkdtemp(join(home.root, `.sign-in-${ownerTag()}-`))
  await chmod(dir, 0o700).catch(() => {})
  const file = join(dir, 'url')
  let helper: string | null = null
  if (platform !== 'win32') {
    helper = join(dir, 'open-url')
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
    await writeFile(helper, `#!/bin/sh\nprintf '%s\\n' "$1" > ${q(`${file}.part`)} && mv ${q(`${file}.part`)} ${q(file)}\n`, { mode: 0o700 })
    await chmod(helper, 0o700)
  }
  let watcher: FSWatcher | null = null
  return {
    helper,
    watch(found) {
      const look = () => {
        if (existsSync(file)) void readFile(file, 'utf8').then((text) => found(text.trim()), () => {})
      }
      try {
        watcher = watch(dir, () => look())
        watcher.on('error', () => {})
      } catch {
        watcher = null
      }
      look()
    },
    async remove() {
      watcher?.close()
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The agent's own folder, kept from its tools (plan §4.2)

/**
 * Whether a permission request may reach the agent's own folder (`tools/antigravity/`: its token and settings in
 * `gemini-home/antigravity-acp/`, its MCP config and skills, its conversations, its programs) anywhere but this
 * conversation's plan. Refused under every preset and every saved rule (`AcpToolShape.neverAllowed`): Centralu answers
 * every request the agent asks, and under Auto its edit tools reached the token's folder with no card (re-review of #1680,
 * measured: `replace_file_content` on a file in `antigravity-acp/` ran; the harness counts that folder as part of its
 * workspace).
 *
 * The plan folder is the one place there the agent writes for the person: `/plan` writes
 * `gemini-home/antigravity-acp/brain/<its session id>/plan.md`, an edit it asks for (measured on 1.4.3; the same folder holds
 * the MCP schemas it reads). Only a file in that session's folder is let through (not the folder, so not a search or glob
 * over it), judged both as written there and where it really leads, so a link in it to the token is still refused; a plan
 * folder that is itself a link, or sits under one, lets nothing through.
 *
 * It fails closed: what it cannot judge is refused (recheck of #1680). What is read, exactly:
 *
 * - every string of the request, object keys too, and the strings of one that holds JSON (pretty-printed too). A request
 *   deeper than `SCAN_LIMITS.depth` or with more than `SCAN_LIMITS.strings` one-line strings is refused whole, unread.
 *   Any request that throws while read is refused
 * - each one-line string up to the longest path an OS takes, as written, without one pair of surrounding quotes, with
 *   `%VAR%`, `$VAR`, `${VAR}`, `$env:VAR` and `${env:VAR}` filled from the agent's environment, and with each `{a,b}` alternative spelled out (more
 *   than 64 are refused); then as a path: a `file:` address as a URL parser reads it (`file:C:/x` too), `~`, absolute,
 *   drive-relative (`C:foo`, judged against the drive's root, the session's folder and the host's own per-drive folder),
 *   `\foo` on Windows, or relative to the session's folder. A `file:/` address that does not parse is refused
 * - a glob (`*`, `?`, `[`, `{` in a segment) also as its fixed prefix, the folder it searches; a `..` after a glob segment is
 *   refused, since where it lands depends on what matched
 * - each path as written (Windows: its device prefix, trailing dots and spaces dropped as the OS does) and as it resolves:
 *   segment by segment through every link and junction, a `..` taken after the link before it as the OS does, case and
 *   8.3 names as the file system has them. A name that is there but does not resolve (a dangling link, a loop) is
 *   refused. Case is folded too (macOS and Windows take any case for one file)
 * - refused when it is in the folder, or is the folder or one of its parents (the data folder, `tools/`, the home folder, a
 *   drive): a listing or a recursive search from there reaches inside. A shell call is exempt from the parents rule only
 * - Windows: a network path (`\\host\share`, `\\?\UNC\…`, a mapped drive, a volume or device path) is refused when it
 *   is on the same volume as the folder, or its volume cannot be read. Its host's name proves nothing (`localhost`,
 *   `127.0.0.1`, the machine's names and addresses, a hosts entry, any share of any folder all lead here), its volume does. A WSL share's `mnt\<letter>` is also judged as that drive
 * - then every line and every word (split at spaces, `=`, `,`, `;`, quotes, brackets, `|`, `@`, `&`) of every string,
 *   multi-line ones and a shell command's included, and each word from every place a path can start in it, read the
 *   same way but by its text only (no links, no parents rule): a path in a list or an argument (`--out=<path>`, `-o<path>`). A command can still reach the folder in ways no text shows (a variable, `cd`
 *   then a relative name); it asks under every preset but Auto (security-boundaries.md)
 */
export async function reachesAgentFolder(home: AgyHome, call: unknown, sessionId: string, cwd: string): Promise<boolean> {
  // A check that throws (a path the OS will not take apart) has not shown the request stays outside
  return judgeRequest(home, call, sessionId, cwd).catch(() => true)
}

async function judgeRequest(home: AgyHome, call: unknown, sessionId: string, cwd: string): Promise<boolean> {
  const read = stringsIn(call)
  if (read === null) return true
  const guard = await guardOf(home, sessionId)
  const parents = asObj(call).kind !== 'execute'
  const env: Record<string, string | undefined> = { ...process.env, GEMINI_HOME: home.geminiHome }
  const judged = new Set<string>()
  for (const text of read.strings) {
    const variants = variantsOf(text, env)
    if (variants === null) return true
    for (const variant of variants) {
      const candidates = candidatesOf(variant, cwd)
      if (candidates === null) return true
      for (const c of candidates) {
        if (judged.has(c.path)) continue
        judged.add(c.path)
        if (await reaches(guard, c, parents)) return true
      }
    }
  }
  // Every line and word of every string, by its text only: a path in a list, an argument (`--out=<path>`, `-o<path>`,
  // `key:<path>`, `@<path>`), a command. Each word also from every place a path can start in it (`~`, a separator, a drive)
  const seen = new Set<string>()
  for (const text of read.texts) {
    const words = [...text.split(/[\r\n]+/), ...text.split(/[\s=,;'"`()<>|@[\]&]+/)].flatMap((word) => {
      const starts = [...word.matchAll(/[~\\/]|[A-Za-z]:[\\/]/g)].map((m) => m.index)
      return [word, ...starts.filter((i) => i > 0).map((i) => word.slice(i))]
    })
    for (const word of words) {
      const w = word.trim()
      if (w.length === 0 || w.length > MAX_PATH_TEXT || seen.has(w)) continue
      seen.add(w)
      for (const variant of variantsOf(w, env) ?? []) {
        for (const c of candidatesOf(variant, cwd) ?? []) {
          const target = written(c.path)
          if (within(guard.root.written, target) && !(guard.plans !== null && within(guard.plans.written, target))) return true
        }
      }
    }
  }
  return false
}

/** How far a request is read: past either bound it is refused, unread (a padded or deeply nested request) */
export const SCAN_LIMITS = { depth: 32, strings: 1024, linkSteps: 256 }

const WINDOWS = sep === '\\'
/** The longest path any OS opens (Windows' 32767 UTF-16 units); a longer string names no file */
const MAX_PATH_TEXT = 32767

/**
 * The strings in a request, distinct: `strings` those that may be one path (one line, short enough), `texts` all of them.
 * Null when the request is beyond `SCAN_LIMITS`
 */
function stringsIn(value: unknown): { strings: string[]; texts: string[] } | null {
  const out = new Set<string>()
  const texts = new Set<string>()
  const add = (text: string, depth: number): boolean => {
    const s = text.trim()
    if (s.length === 0) return true
    texts.add(s)
    if (/^[[{]/.test(s)) {
      try {
        if (!walk(JSON.parse(s), depth + 1)) return false
      } catch {
        // Not JSON: read as text
      }
    }
    if (s.length > MAX_PATH_TEXT || /[\r\n]/.test(s)) return true
    out.add(s)
    return out.size <= SCAN_LIMITS.strings
  }
  const walk = (v: unknown, depth: number): boolean => {
    if (depth > SCAN_LIMITS.depth) return false
    if (typeof v === 'string') return add(v, depth)
    if (Array.isArray(v)) return v.every((x) => walk(x, depth + 1))
    if (v && typeof v === 'object') return Object.entries(v).every(([k, x]) => add(k, depth) && walk(x, depth + 1))
    return true
  }
  return walk(value, 0) ? { strings: [...out], texts: [...texts] } : null
}

/**
 * A string as written, without one pair of surrounding quotes, with environment variables filled in, and with each
 * `{a,b}` alternative spelled out. Null when there are more alternatives than `MAX_ALTERNATIVES`
 */
function variantsOf(text: string, env: Record<string, string | undefined>): string[] | null {
  const out = new Set([text])
  const quoted = /^(["'`])(.*)\1$/.exec(text)
  if (quoted?.[2]) out.add(quoted[2].trim())
  const lookup = (name: string) => (WINDOWS ? Object.entries(env).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1] : env[name])
  for (const v of [...out]) {
    const filled = v
      .replace(/%([^%\s]+)%/g, (all, name: string) => (WINDOWS ? (lookup(name) ?? all) : all))
      // `$env:NAME` and `${env:NAME}` are PowerShell's own spelling
      .replace(/\$\{env:([^}\s]+)\}|\$env:(\w+)|\$\{(\w+)\}|\$(\w+)/gi, (all, a?: string, b?: string, c?: string, d?: string) => lookup(a ?? b ?? c ?? d ?? '') ?? all)
    out.add(filled)
  }
  const all = new Set<string>()
  for (const v of out) {
    const spelled = alternativesOf(v)
    if (spelled === null) return null
    for (const a of spelled) all.add(a)
  }
  return [...all].filter((s) => s.length > 0)
}

const MAX_ALTERNATIVES = 64

/** A glob's `{a,b}` alternatives, innermost first, each spelled out; null past `MAX_ALTERNATIVES` */
function alternativesOf(text: string): string[] | null {
  let todo = [text]
  const done: string[] = []
  while (todo.length > 0) {
    const next: string[] = []
    for (const t of todo) {
      const m = /\{([^{}]*,[^{}]*)\}/.exec(t)
      if (!m) done.push(t)
      else for (const alt of (m[1] ?? '').split(',')) next.push(t.slice(0, m.index) + alt + t.slice(m.index + m[0].length))
    }
    if (done.length + next.length > MAX_ALTERNATIVES) return null
    todo = next
  }
  return done
}

type Candidate = { path: string }

/**
 * The absolute paths a string may name, each as written (not normalized: `..` is judged after the links before it), and
 * a glob's fixed prefix too. Null when the string reads as a path that cannot be judged
 */
export function candidatesOf(text: string, cwd: string): Candidate[] | null {
  let s = text
  if (/^file:/i.test(s)) {
    // As a URL parser reads it, `file:C:/x` and `file:x` included; one that does not parse is a path only if it reads as one
    let local: string | null = null
    try {
      local = fileURLToPath(s)
    } catch {
      if (/^file:[\\/]/i.test(s)) return null
    }
    if (local === null) return [{ path: joinRaw(cwd, s) }]
    s = local
  }
  if (WINDOWS) s = withoutDevicePrefix(s)
  const roots: string[] = []
  // A WSL share is another volume, but `/mnt/c` in it is this machine's `C:`: that path is judged too
  const mounted = WINDOWS ? wslDrivePath(windowsForm(s)) : null
  if (mounted !== null) roots.push(mounted)
  let pathLike = true
  if (s === '~' || s.startsWith('~/') || (WINDOWS && s.startsWith('~\\'))) roots.push(homedir() + s.slice(1))
  // Windows: `\foo` is from the root of the process's drive, which Centralu takes to be the session folder's
  else if (WINDOWS && /^[\\/](?![\\/])/.test(s)) roots.push(`${cwd.slice(0, 2)}${s}`, resolve(s))
  else if (isAbsolute(s)) roots.push(s)
  else if (WINDOWS && /^[A-Za-z]:/.test(s)) {
    // Drive-relative: the process's folder on that drive, which Centralu cannot see; every folder it may be is judged
    const drive = s.slice(0, 2)
    const rest = s.slice(2)
    roots.push(`${drive}\\${rest}`, resolve(s))
    if (cwd.slice(0, 2).toLowerCase() === drive.toLowerCase()) roots.push(joinRaw(cwd, rest))
  } else {
    pathLike = /[\\/]/.test(s)
    roots.push(joinRaw(cwd, s))
  }
  const out: Candidate[] = []
  for (const path of roots) {
    out.push({ path })
    if (!pathLike) continue
    const segments = path.split(WINDOWS ? /[\\/]/ : '/')
    const at = segments.findIndex((seg, i) => i > 0 && /[*?[{]/.test(seg))
    if (at < 0) continue
    if (segments.slice(at + 1).includes('..')) return null
    out.push({ path: segments.slice(0, at).join(sep) || sep })
  }
  return out
}

/**
 * The Windows path a WSL share's `\mnt\<letter>\…` (or `\<letter>\…`, where the distro mounts drives at its root) names:
 * `\\wsl$\<distro>\mnt\c\x` and `\\wsl.localhost\<distro>\mnt\c\x` as `c:\x`, any case, either slash. Null for any other
 * path. A distro's mount point can be set to anything (`/etc/wsl.conf`); only these two are known
 */
export function wslDrivePath(path: string): string | null {
  const m = /^[\\/]{2}wsl(?:\$|\.localhost)[\\/]+[^\\/]+[\\/]+(?:mnt[\\/]+)?([A-Za-z])(?:[\\/]+(.*))?$/i.exec(path)
  return m ? `${(m[1] ?? '').toLowerCase()}:\\${(m[2] ?? '').replace(/\//g, '\\')}` : null
}

const joinRaw = (dir: string, rest: string) => (rest.length ? `${dir.replace(/[\\/]+$/, '')}${sep}${rest}` : dir)

/** `\\?\C:\…` and `\\.\C:\…` as `C:\…`, `\\?\UNC\host\…` and `\\.\UNC\host\…` as `\\host\…` */
function withoutDevicePrefix(s: string): string {
  return s.replace(/^[\\/]{2}[?.][\\/]UNC[\\/]/i, '\\\\').replace(/^[\\/]{2}[?.][\\/]([A-Za-z]:)/, '$1')
}

/** Windows' own reading of a path: made absolute with `..` taken by the text, and each name's trailing dots and spaces dropped */
function windowsForm(path: string): string {
  return resolve(withoutDevicePrefix(path))
    .split('\\')
    .map((seg) => (seg === '.' || seg === '..' ? seg : seg.replace(/[. ]+$/, '') || seg))
    .join('\\')
}

type Guard = {
  root: { written: string; real: string }
  plans: { written: string; real: string } | null
  /** The volume the folder (or the part of its path that exists) is on, or null when it cannot be read */
  volume: bigint | null
}

async function guardOf(home: AgyHome, sessionId: string): Promise<Guard> {
  const memo = new Map<string, Promise<string | null>>()
  const root = await resolveLinks(home.root, memo)
  const plansAt = /^[A-Za-z0-9-]{1,64}$/.test(sessionId) ? join(home.geminiHome, 'antigravity-acp', 'brain', sessionId) : null
  let plans = plansAt === null ? null : await resolveLinks(plansAt, memo)
  // A plan folder that is (or sits under) a link leads somewhere else: no plan folder then, so nothing is let through
  if (plansAt !== null && plans !== null && root !== null) {
    const expected = join(root.real, relative(written(home.root), written(plansAt)))
    if (fold(plans.real) !== fold(expected)) plans = null
  }
  const volume = root?.existing ? await stat(root.existing, { bigint: true }).then((s) => s.dev, () => null) : null
  return {
    root: { written: written(home.root), real: root?.real ?? written(home.root) },
    plans: plansAt === null || plans === null ? null : { written: written(plansAt), real: plans.real },
    volume,
  }
}

const written = (path: string) => (WINDOWS ? windowsForm(path) : resolve(path))

async function reaches(guard: Guard, c: Candidate, parents: boolean): Promise<boolean> {
  const real = await resolveLinks(c.path, new Map())
  if (real === null) return true
  const pairs: [root: string, plans: string | null, target: string][] = [
    [guard.root.written, guard.plans?.written ?? null, written(c.path)],
    [guard.root.real, guard.plans?.real ?? null, real.real],
  ]
  for (const [root, plans, target] of pairs) {
    if (within(root, target)) {
      const plan = plans !== null && within(plans, target) && !(await isFolder(real.real)) && !(await hardLinked(real.real))
      if (!plan) return true
    }
    if (parents && within(target, root)) return true
  }
  if (WINDOWS && /^[\\/]{2}/.test(real.real)) {
    if (real.existing === null || guard.volume === null) return true
    const volume = await stat(real.existing, { bigint: true }).then((s) => s.dev, () => null)
    if (volume === null || volume === guard.volume) return true
  }
  return false
}

/** A file with a second name: a hardlink to the token in the plan folder is the token, and `realpath` cannot tell */
async function hardLinked(path: string): Promise<boolean> {
  return stat(path).then((s) => s.nlink > 1, () => false)
}

async function isFolder(path: string): Promise<boolean> {
  return stat(path).then((s) => s.isDirectory(), () => false)
}

const fold = (p: string) => p.toLowerCase()

/** Whether `target` is `folder` or inside it, case folded (exported for its test under POSIX rules on every OS) */
export function within(folder: string, target: string, paths: Pick<typeof import('node:path'), 'relative' | 'isAbsolute' | 'sep'> = { relative, isAbsolute, sep }): boolean {
  const rel = paths.relative(fold(folder), fold(target))
  return rel === '' || (!paths.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${paths.sep}`))
}

/**
 * Where a path really leads: from its root, segment by segment, each through `realpath` (links, junctions, 8.3 names, the
 * file system's case), a `..` taken after the link before it (POSIX; Windows takes `..` by the text, so its form is
 * normalized first). The part past the first segment that does not exist is kept as written. `existing` is the deepest
 * part that does, or null when not even the root does. Null when it takes more than `SCAN_LIMITS.linkSteps` lookups
 */
async function resolveLinks(path: string, memo: Map<string, Promise<string | null>>): Promise<{ real: string; existing: string | null } | null> {
  const full = WINDOWS ? windowsForm(path) : isAbsolute(path) ? path : resolve(path)
  const real = (p: string) => {
    let r = memo.get(p)
    if (!r) memo.set(p, (r = realpath(p).catch(() => null)))
    return r
  }
  const root = parse(full).root
  const parts = full.slice(root.length).split(WINDOWS ? /[\\/]+/ : /\/+/).filter(Boolean)
  let at = await real(root)
  if (at === null) return { real: resolve(full), existing: null }
  let i = 0
  let steps = 0
  for (; i < parts.length; i++) {
    const part = parts[i] ?? '.'
    if (part === '.') continue
    if (part === '..') {
      at = dirname(at)
      continue
    }
    if (++steps > SCAN_LIMITS.linkSteps) return null
    const next = await real(join(at, part))
    // A name that is there but does not resolve (a dangling link, a loop, no access) cannot be followed: unjudgeable
    if (next === null && (await lstat(join(at, part)).then(() => true, () => false))) return null
    if (next === null) break
    at = next
  }
  return { real: i < parts.length ? resolve(at, ...parts.slice(i)) : at, existing: at }
}

/** The person's browser on this machine, started apart from the host and never through a shell */
export function openInBrowser(url: string, platform: Platform = HOST_PLATFORM): void {
  const [command, args] = platform === 'darwin' ? ['open', [url]] : platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]]
  try {
    const child = spawnChild(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // Nothing to tell the person beyond the sign-in's own end: a browser that did not open times the sign-in out
  }
}

/** Whether the host opens the sign-in's address itself: where the helper hands it over. Elsewhere the agent's own launcher opens it */
export function hostOpensSignIn(folder: SignInFolder): boolean {
  return folder.helper !== null
}
