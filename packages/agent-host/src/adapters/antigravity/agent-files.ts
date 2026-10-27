import { spawn as spawnChild } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, statfs, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { inflateRaw } from 'node:zlib'
import { errorMessage } from '@cc/protocol'
import { asObj } from '../../json-value.js'
import { HOST_PLATFORM, type Platform } from '../../os.js'
import { readZipEntries, ZipError, zipEntryBytes } from '../../zip.js'
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
 *     .install-<random>/     an install in progress (removed when it ends, however it ends)
 *     .sign-in-<random>/     a sign-in's browser helper and the address it hands over (removed when the sign-in ends)
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
    const res = await fetch(url, { signal, redirect: 'follow' })
    if (!res.ok || !res.body) throw new InstallFailure('network', `The download answered ${res.status} ${res.statusText}`.trim())
    const length = Number(res.headers.get('content-length'))
    return { total: Number.isFinite(length) && length > 0 ? length : null, chunks: chunksOf(res.body) }
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

const inflate = promisify(inflateRaw)

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
  const work = await mkdtemp(join(home.root, '.install-'))
  try {
    const zip = join(work, 'archive.zip')
    const sha = await download(io, archive.url, zip, signal, opts.onProgress)
    if (sha !== archive.sha256) throw new InstallFailure('checksum', `The downloaded archive does not match the version Centralu pins (sha256 ${sha.slice(0, 12)}…)`)
    cancelled(signal)
    const pkg = join(work, 'pkg')
    await unpack(await readFile(zip), archive, pkg, signal, opts.platform ?? HOST_PLATFORM)
    await rm(zip, { force: true })
    await writeFile(join(pkg, INSTALL_MARKER), `${JSON.stringify({ version, sha256: archive.sha256, url: archive.url })}\n`)
    cancelled(signal)
    // A folder there without a whole install (another version's sha, a damaged copy) is replaced; a whole one is kept
    if (isInstalled(home, archive)) return
    await rm(home.versionDir, { recursive: true, force: true })
    await rename(pkg, home.versionDir)
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

/** Exactly the release's files, plain names only, each to its declared size; anything else refuses the archive */
async function unpack(buf: Buffer, archive: AgyArchive, dir: string, signal: AbortSignal, platform: Platform): Promise<void> {
  const entries = readZipEntries(buf, archive.files.length + 4).filter((e) => !(e.kind === 'dir' && e.size === 0))
  const names = entries.map((e) => e.name).sort()
  const want = [...archive.files].sort()
  if (names.length !== want.length || names.some((n, i) => n !== want[i])) {
    throw new InstallFailure('unpack', `The archive holds ${names.join(', ') || 'nothing'}, not the files the release names (${want.join(', ')})`)
  }
  await mkdir(dir, { recursive: true })
  for (const e of entries) {
    if (e.kind !== 'file' || !/^[\w.-]+$/.test(e.name)) throw new InstallFailure('unpack', `The archive's entry ${e.name} is not a plain file`)
    const raw = zipEntryBytes(buf, e)
    // Inflated only up to the size it declares: a larger stream stops there (a zip bomb), and is refused
    const data = e.method === 0 ? raw : e.method === 8 ? await inflate(raw, { maxOutputLength: Math.max(e.size, 1) }).catch(() => Buffer.alloc(0)) : null
    if (!data) throw new InstallFailure('unpack', `The archive's entry ${e.name} uses compression method ${e.method}`)
    if (data.length !== e.size) throw new InstallFailure('unpack', `${e.name} does not unpack to the ${e.size} bytes it declares`)
    cancelled(signal)
    const path = join(dir, e.name)
    await writeFile(path, data, { mode: 0o755 })
    // Windows has no run bit: a program there is one by its name
    if (platform !== 'win32') await chmod(path, 0o755)
  }
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

/** What an earlier host left of an install or a sign-in it did not finish (it crashed, or was killed mid-way) */
async function removeStale(root: string, prefix: string): Promise<void> {
  const names = await readdir(root).catch((): string[] => [])
  await Promise.all(names.filter((n) => n.startsWith(prefix)).map((n) => rm(join(root, n), { recursive: true, force: true }).catch(() => {})))
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
  const dir = await mkdtemp(join(home.root, '.sign-in-'))
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
