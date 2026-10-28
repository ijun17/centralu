import { spawn as spawnChild } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, createReadStream, createWriteStream, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, watch, type FSWatcher } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, statfs, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
 * - the private folder of a process's `BROWSER` helper (`browserFolder`), and the person's browser (`openInBrowser`)
 *
 * The folder, under `<data>/tools/antigravity/`:
 *
 *     <version>/             the server and its harness, side by side, and `install.json` written last
 *     gemini-home/           GEMINI_HOME: the agent's settings, conversations, and its token where it keeps a file (not on
 *                            a Mac with a usable Keychain, plan §4.2). Not versioned, so a session made
 *                            under one Centralu still loads under the next (ids are per GEMINI_HOME, spike §3)
 *     .install-<owner>-<random>/  an install in progress (removed when it ends, however it ends)
 *     .sign-in-<owner>-<random>/  one process's browser helper and the address it hands over (a sign-in's or a session's;
 *                            removed when that process's sign-in or session ends)
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
 * every later process signs in from (spike §4). The token itself is not looked for: the agent keeps it in its own store
 * (1.4.3: the macOS Keychain when one is usable, otherwise a file in `GEMINI_HOME`; plan §4.2), which Centralu does not
 * read. A sign-in the settings still name but whose token is gone or no longer works is told at the next session, when the
 * agent asks for its own login (`SignInWanted`), and the line says sign-in required again (`AgySetup.noteSignedOut`)
 */
export function hasSignIn(home: AgyHome): boolean {
  const dir = join(home.geminiHome, 'antigravity-acp')
  try {
    const settings = asObj(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')))
    const auth = asObj(settings.auth)
    return typeof auth.type === 'string' && auth.type.length > 0
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
// The browser helper's folder (plan §4)

export type BrowserFolder = {
  /**
   * What `BROWSER` is set to in the agent's process: a command its launcher (Python's `webbrowser`) runs with the address.
   * Empty where none can be written (a path holding the list separator `BROWSER` is split at, or `%s`): the agent's
   * launcher would then start the browser itself, so a session and a sign-in refuse to start (`NO_HELPER`)
   */
  browser: string
  /**
   * Calls `found` with each address the helper hands over (a watch, and a look now for one written before the watch
   * began). Each is taken once: the file is removed as it is read, so a later process on the same folder is not told of it
   */
  watch(found: (text: string) => void): void
  /** Ends the watch and removes the folder */
  remove(): Promise<void>
}

/**
 * A folder only this user can read (0700) beside the install, for one Antigravity process's browser: the `BROWSER` helper,
 * which writes the one argument it is given to a file of its own there (`url-<run>`) through a temporary name, so the
 * host never reads half an address. Every Antigravity process gets one (a sign-in, a session), so the agent never starts a browser itself on any
 * OS (review of #1685: on Windows it started the person's browser as its own child, inside the host's job object, and a
 * Stop, the sign-in's end or the host's exit ended it with every tab):
 * - **macOS and Linux**: a `sh` script, `BROWSER` its path (measured on macOS: the launcher runs it, and opens no browser)
 * - **Windows**: a batch file would hand the address to `cmd`, which splits it at `&`. So `BROWSER` is a command line,
 *   `'<node>' '<dir>/open-url.mjs' %s`: Python's launcher splits a `BROWSER` entry holding `%s` with `shlex` and runs it
 *   with no shell (CPython 3.14 `webbrowser.get`, the agent's runtime), so the address reaches the helper whole. The
 *   helper exits 0, so the launcher does not fall back to the default browser
 */
export async function browserFolder(home: AgyHome, platform: Platform = HOST_PLATFORM, node: string = process.execPath): Promise<BrowserFolder> {
  await mkdir(home.root, { recursive: true })
  await removeStale(home.root, '.sign-in-')
  const dir = await mkdtemp(join(home.root, `.sign-in-${ownerTag()}-`))
  await chmod(dir, 0o700).catch(() => {})
  let browser: string
  if (platform === 'win32') {
    const script = join(dir, 'open-url.mjs')
    await writeFile(script, WINDOWS_HELPER)
    browser = windowsBrowserCommand(node, script)
  } else {
    const helper = join(dir, 'open-url')
    // `url-<pid>`: each run its own name, so a rename never lands on a file the host is reading; exit 0 whatever happens
    const part = `${shQuote(join(dir, 'part-'))}"$$"`
    await writeFile(helper, `#!/bin/sh\nprintf '%s\\n' "$1" > ${part} && mv ${part} ${shQuote(join(dir, 'url-'))}"$$"\nexit 0\n`, { mode: 0o700 })
    await chmod(helper, 0o700)
    browser = usableBrowser(helper, ':') ? helper : ''
  }
  let watcher: FSWatcher | null = null
  const taken = new Set<string>()
  return {
    browser,
    watch(found) {
      const look = () => {
        let names: string[]
        try {
          names = readdirSync(dir).filter((n) => n.startsWith('url-') && !taken.has(n))
        } catch {
          return
        }
        for (const name of names) {
          taken.add(name)
          const path = join(dir, name)
          void readFile(path, 'utf8').then(
            async (text) => {
              await rm(path, { force: true }).catch(() => {})
              found(text.trim())
            },
            () => {},
          )
        }
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

/**
 * The Windows helper: the address to `url-<pid>-<time>` beside it, through a temporary name (each run its own, so the
 * rename never meets a file the host is reading), and exit 0 whatever happens: a non-zero exit would send the agent's
 * launcher on to the default browser, inside the job
 */
const WINDOWS_HELPER = `import { renameSync, writeFileSync } from 'node:fs'
try {
  const tag = \`\${process.pid}-\${Date.now()}\`
  const part = new URL(\`./part-\${tag}\`, import.meta.url)
  writeFileSync(part, \`\${process.argv[2] ?? ''}\n\`)
  renameSync(part, new URL(\`./url-\${tag}\`, import.meta.url))
} catch {}
process.exit(0)
`

/**
 * `BROWSER` for Windows: node and the helper, each in `shlex` single quotes (no escapes inside, so a backslash stays), and
 * `%s` where the launcher puts the address. Empty when a path holds `;` (the launcher splits `BROWSER` there) or `%s`
 */
export function windowsBrowserCommand(node: string, script: string): string {
  if (!usableBrowser(node, ';') || !usableBrowser(script, ';')) return ''
  return `${shQuote(node)} ${shQuote(script)} %s`
}

/** In single quotes, as both `sh` and `shlex` read them: nothing is escaped inside, and a `'` is closed, escaped and reopened */
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

const usableBrowser = (path: string, listSep: string) => !path.includes(listSep) && !path.includes('%s')

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
