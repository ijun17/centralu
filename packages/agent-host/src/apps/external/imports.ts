import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, type Dirent } from 'node:fs'
import { isIP } from 'node:net'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { wireJoin, wireSegments, type AppReview } from '@cc/protocol'
import { assertExistingPathSync } from '../../dev-services/path-guard.js'
import { proposedMcpServerNameError } from '../contract.js'
import { reviewKey } from './import-book.js'
import { MANIFEST_FILE, MAX_MANIFEST_BYTES, parseManifest, type AppManifest } from './manifest.js'
import { ZipError, readZipEntries, readZipEntry, type ZipEntry } from './zip.js'

/**
 * Imports an app from outside (M4 E-3) — **validates while staging** a folder or a zip (a file on
 * this machine, or an https address), and builds what the person reviews.
 *
 * This file only goes as far as staging. The destination is an empty folder the caller supplies (the
 * staging area in the data folder), and moving it into the user folder plus the person's
 * confirmation is the runtime door's job (handover in `runtime.ts`). Since the staging area is not a
 * place discovery scans, nothing starts or attaches an app that has not finished validation to a
 * session.
 *
 * What is blocked:
 *   - **Links are never followed.** If a link inside the folder points outside the folder, the import
 *     is refused (stating what it points at). A link pointing inside is never moved, only listed. The
 *     same holds for a link entry inside a zip — leaving a link unpacked is the oldest form of a
 *     zip-slip attack.
 *   - **A name is never used to write outside (zip slip).** An absolute path, `..`, a backslash, a
 *     drive letter, an empty segment, and control characters are all rejected. The path written is
 *     built only from segments that pass validation.
 *   - **Size.** File count, the total, one file, depth, and the archive itself all have caps. A zip
 *     is first measured by its declared size, and unpacking stops if it exceeds that declaration
 *     (`zip.ts`).
 *   - **A name starting with a dot is never moved.** `.git`, `.env`, and also `.claude/` and
 *     `.codex/` — these two are settings read by a building session working in the app folder, so a
 *     hook an imported bundle carries in could otherwise run without the person's confirmation. The
 *     folder fingerprint (`fingerprint.ts`) also never treats a dot-name as part of the app's
 *     behavior.
 */

export const IMPORT_LIMITS = {
  /** Number of files moved — matches the fingerprint's own cap (2000) */
  files: 2_000,
  /** Sum of the sizes of files moved */
  totalBytes: 64 * 1024 * 1024,
  /** One file */
  fileBytes: 16 * 1024 * 1024,
  /** Folder depth */
  depth: 16,
  /** Character count of one path */
  pathChars: 1024,
  /** The zip file itself (including the download) */
  archiveBytes: 32 * 1024 * 1024,
  /** How long a download must finish within */
  downloadMs: 60_000,
  /** How many https redirects are followed */
  redirects: 5,
}
export type ImportLimits = typeof IMPORT_LIMITS

/** Refuses an import — the reason is exactly the text shown to the person */
export class ImportRefused extends Error {
  readonly code = 'internal'
}

export type ImportSource = { kind: 'path'; path: string; label: string } | { kind: 'https'; url: URL; label: string }

/**
 * A person-supplied source → where to import from. Only **a file on this machine, or https**, are
 * accepted. Plain http can be altered in transit, and any other scheme is something we do not know
 * how to open. A path must be absolute — a relative path's meaning would depend on the host's
 * working folder.
 */
export function classifySource(raw: string): ImportSource {
  const s = raw.trim()
  if (!s) throw new ImportRefused('Choose a folder, a .zip file, or an https link to a .zip')
  if (s.includes('\0')) throw new ImportRefused('The source contains a NUL character')
  if (/^https:/i.test(s)) {
    let url: URL
    try {
      url = new URL(s)
    } catch {
      throw new ImportRefused(`Not a valid link: ${s}`)
    }
    const problem = httpsProblem(url)
    if (problem) throw new ImportRefused(problem)
    return { kind: 'https', url, label: url.href }
  }
  if (/^file:/i.test(s)) {
    let path: string
    try {
      path = fileURLToPath(s)
    } catch {
      throw new ImportRefused(`Only files on this machine can be imported from a file link: ${s}`)
    }
    return { kind: 'path', path, label: path }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) throw new ImportRefused(`Only folders and .zip files on this machine, or https links, can be imported: ${s}`)
  if (!isAbsolute(s)) throw new ImportRefused(`Use the full path of the folder or .zip file: ${s}`)
  return { kind: 'path', path: s, label: s }
}

/**
 * Where an https address must not point — this machine (loopback), link-local (cloud metadata
 * addresses live here), and unspecified addresses. A download happens only after the person clicks,
 * but what they clicked is the address the link gave. Where a named host actually resolves to is
 * never checked (a documented limit in docs/security-boundaries.md).
 */
function httpsProblem(url: URL): string | null {
  if (url.protocol !== 'https:') return `Only https links can be downloaded: ${url.href}`
  if (url.username || url.password) return 'Links with a user name or password in them are not accepted'
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return `A link to this machine cannot be downloaded: ${url.href}`
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number) as [number, number]
    if (a === 127 || a === 0 || (a === 169 && b === 254)) return `A link to this machine or a link-local address cannot be downloaded: ${url.href}`
  }
  if (isIP(host) === 6 && (host === '::1' || host === '::' || /^fe[89ab]/.test(host) || host.startsWith('::ffff:'))) {
    return `A link to this machine or a link-local address cannot be downloaded: ${url.href}`
  }
  return null
}

/**
 * Downloads a zip over https — a redirect is followed manually (https only, up to a cap), and the
 * address is re-checked every time. Size is checked first from `Content-Length`, then blocked again
 * by counting bytes actually received (the header can be missing or lying). `dest` is the caller's
 * temp folder.
 */
export async function downloadZip(url: URL, dest: string, limits: ImportLimits, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  const signal = AbortSignal.timeout(limits.downloadMs)
  let at = url
  for (let hop = 0; ; hop++) {
    let res: Response
    try {
      res = await fetchImpl(at, { redirect: 'manual', signal })
    } catch (e) {
      throw new ImportRefused(`Could not download ${at.href}: ${(e as Error).message}`)
    }
    if (res.status >= 300 && res.status < 400) {
      const to = res.headers.get('location')
      if (!to) throw new ImportRefused(`${at.href} redirected without saying where`)
      if (hop >= limits.redirects) throw new ImportRefused(`Too many redirects from ${url.href}`)
      const next = new URL(to, at)
      const problem = httpsProblem(next)
      if (problem) throw new ImportRefused(`${at.href} redirected to a place that is not allowed. ${problem}`)
      at = next
      continue
    }
    if (!res.ok) throw new ImportRefused(`Could not download ${at.href}: HTTP ${res.status}`)
    const declared = Number(res.headers.get('content-length') ?? NaN)
    if (declared > limits.archiveBytes) throw new ImportRefused(`The download is ${declared} bytes; at most ${limits.archiveBytes} are accepted`)
    const chunks: Buffer[] = []
    let got = 0
    const reader = res.body?.getReader()
    if (!reader) throw new ImportRefused(`${at.href} sent no body`)
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      got += value.byteLength
      if (got > limits.archiveBytes) {
        await reader.cancel().catch(() => {})
        throw new ImportRefused(`The download is larger than ${limits.archiveBytes} bytes; stopped`)
      }
      chunks.push(Buffer.from(value))
    }
    const buf = Buffer.concat(chunks)
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, 'download.zip'), buf, { mode: 0o600 })
    return buf
  }
}

export type StagedFiles = {
  files: { path: string; bytes: number }[]
  totalBytes: number
  skipped: { path: string; why: string }[]
}

/**
 * Stages a source on this machine (a folder or a `.zip`) into `dest` (a folder that does not exist
 * yet). The root is resolved to its **real path** — if the person chose a path that is itself a
 * link, that link was the person's choice (`/tmp` is `/private/tmp` on macOS), but a link **inside**
 * it is never followed.
 */
export function stageLocal(path: string, dest: string, limits: ImportLimits): StagedFiles {
  let root: string
  try {
    root = realpathSync(path)
  } catch {
    throw new ImportRefused(`Nothing to import at ${path}`)
  }
  const st = statSync(root)
  if (st.isDirectory()) return copyFolder(root, dest, limits)
  if (!st.isFile()) throw new ImportRefused(`${path} is not a folder or a .zip file`)
  if (st.size > limits.archiveBytes) throw new ImportRefused(`${path} is ${st.size} bytes; at most ${limits.archiveBytes} are accepted`)
  const buf = readFileSync(root)
  if (!isZip(buf)) throw new ImportRefused(`${path} is not a folder or a .zip file`)
  return stageZip(buf, dest, limits)
}

/** Whether the first four bytes are a zip's local header (or the end header of an empty zip) */
export function isZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && ((buf[2] === 3 && buf[3] === 4) || (buf[2] === 5 && buf[3] === 6))
}

/** A name that is never moved — if even one segment looks like this, everything beneath it is skipped (the "names starting with a dot" from the header comment) */
function hiddenPart(part: string): boolean {
  return part.startsWith('.') || part === '__MACOSX'
}

class Tally {
  out: StagedFiles = { files: [], totalBytes: 0, skipped: [] }
  constructor(private limits: ImportLimits) {}
  file(path: string, bytes: number): void {
    if (path.length > this.limits.pathChars) throw new ImportRefused(`A path is longer than ${this.limits.pathChars} characters: ${path.slice(0, 80)}…`)
    if (bytes > this.limits.fileBytes) throw new ImportRefused(`${path} is ${bytes} bytes; one file can be at most ${this.limits.fileBytes}`)
    if (this.out.files.length + 1 > this.limits.files) throw new ImportRefused(`More than ${this.limits.files} files; an app this large is not imported`)
    if (this.out.totalBytes + bytes > this.limits.totalBytes) throw new ImportRefused(`More than ${this.limits.totalBytes} bytes in all; an app this large is not imported`)
    this.out.files.push({ path, bytes })
    this.out.totalBytes += bytes
  }
  skip(path: string, why: string): void {
    this.out.skipped.push({ path, why })
  }
  depth(path: string, depth: number): void {
    if (depth > this.limits.depth) throw new ImportRefused(`Folders nest deeper than ${this.limits.depth} levels: ${path}`)
  }
}

/**
 * Moves a folder. Checked with `lstat`, so links are never followed. When opening a file, this
 * checks again that it is not a link (`O_NOFOLLOW`) and that it is still inside the root (the path
 * guard — in case a parent turned into a link in the meantime), then reads through the open
 * descriptor. A race where the same user swaps it out in that window still remains (the same limit
 * documented under "Project files" in docs/security-boundaries.md).
 */
function copyFolder(root: string, dest: string, limits: ImportLimits): StagedFiles {
  const t = new Tally(limits)
  mkdirSync(dest)
  const walk = (rel: string, depth: number): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(rel ? join(root, rel) : root, { withFileTypes: true })
    } catch (e) {
      throw new ImportRefused(`Could not read ${rel || root}: ${(e as Error).message}`)
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (hiddenPart(e.name)) {
        t.skip(e.isDirectory() ? `${r}/` : r, 'hidden')
        continue
      }
      const full = join(root, r)
      const st = lstatSync(full)
      if (st.isSymbolicLink()) {
        let target: string
        try {
          target = realpathSync(full)
        } catch {
          t.skip(r, 'link to nothing')
          continue
        }
        if (!inside(root, target)) throw new ImportRefused(`${r} is a link to ${target}, outside the folder. Links are not followed; remove it and import again`)
        t.skip(r, 'link')
        continue
      }
      if (st.isDirectory()) {
        t.depth(r, depth + 1)
        mkdirSync(join(dest, r))
        walk(r, depth + 1)
        continue
      }
      if (!st.isFile()) {
        t.skip(r, 'not a regular file')
        continue
      }
      t.file(r, st.size)
      writeFileSync(join(dest, r), readRegular(root, r, st.size), { mode: execBits(st.mode) })
    }
  }
  walk('', 0)
  return t.out
}

/** Reads one regular file inside the root — checks the parent with the path guard, and opens the last segment without following a link */
function readRegular(root: string, rel: string, size: number): Buffer {
  if (!assertExistingPathSync(root, rel).isFile()) throw new ImportRefused(`${rel} changed while it was being read`)
  const fd = openSync(join(root, rel), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.size !== size) throw new ImportRefused(`${rel} changed while it was being read`)
    const buf = Buffer.alloc(size)
    let off = 0
    while (off < size) {
      const n = readSync(fd, buf, off, size - off, off)
      if (n === 0) break
      off += n
    }
    return buf.subarray(0, off)
  } finally {
    closeSync(fd)
  }
}

/** Carries over only the executable bit — something like setuid is never moved */
function execBits(mode: number): number {
  return mode & 0o111 ? 0o755 : 0o644
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/**
 * Unpacks a zip. First, every entry's name, kind, and declared size are validated (if even one is
 * wrong, nothing is written), and only then are files written. If the bundle wraps everything in a
 * single folder (the common shape: `notes/centralu.app.json`), that folder is treated as the root.
 */
export function stageZip(buf: Buffer, dest: string, limits: ImportLimits): StagedFiles {
  let entries: ZipEntry[]
  try {
    entries = readZipEntries(buf, limits.files * 2)
  } catch (e) {
    throw new ImportRefused((e as Error).message)
  }
  const named = entries.map((e) => ({ e, parts: zipParts(e.name, limits) })).filter((x) => x.parts.length > 0)
  /*
   * Whether to strip the root folder is decided using **only the entries actually being moved.**
   * macOS's compressor adds `__MACOSX/` alongside the content, making the top level look like it has
   * two segments — but that folder is never moved, so counting it would cause the common case of a
   * bundle wrapped in one folder to be rejected as "no manifest".
   */
  const visible = named.filter((x) => !hiddenPart(x.parts[0]!))
  const top = new Set(visible.map((x) => x.parts[0]!))
  const strip =
    !visible.some((x) => x.parts.length === 1 && x.parts[0] === MANIFEST_FILE) &&
    top.size === 1 &&
    visible.every((x) => x.parts.length > 1 || x.e.kind === 'dir')
  const t = new Tally(limits)
  const plan: { parts: string[]; e: ZipEntry }[] = []
  const seen = new Map<string, 'file' | 'dir'>()
  for (const { e, parts: all } of named) {
    // If the top-level segment is itself a never-moved name (`__MACOSX/`), skip it before stripping — stripping would make what is underneath look like the app's own files
    if (hiddenPart(all[0]!)) {
      const at = all.length > 1 || e.kind === 'dir' ? `${all[0]}/` : all[0]!
      if (!t.out.skipped.some((s) => s.path === at)) t.skip(at, 'hidden')
      continue
    }
    const parts = strip ? all.slice(1) : all
    if (parts.length === 0) continue
    const path = wireJoin(...parts)
    const hidden = parts.findIndex(hiddenPart)
    if (hidden >= 0) {
      const at = wireJoin(...parts.slice(0, hidden + 1))
      if (!t.out.skipped.some((s) => s.path === at || s.path === `${at}/`)) t.skip(hidden < parts.length - 1 || e.kind === 'dir' ? `${at}/` : at, 'hidden')
      continue
    }
    if (e.kind === 'link') {
      // A link's content (the path it points at) is read only up to its declared size — refused if it points outside, never moved if it points inside
      const target = e.size <= 4096 ? readZipEntry(buf, e).toString('utf8') : '(too long)'
      const resolved = [...parts.slice(0, -1)]
      let escapes = target.startsWith('/') || target.includes('\\') || /^[a-z]:/i.test(target)
      for (const p of wireSegments(target)) {
        if (escapes) break
        if (p === '' || p === '.') continue
        if (p === '..') {
          if (resolved.length === 0) escapes = true
          else resolved.pop()
        } else resolved.push(p)
      }
      if (escapes) throw new ImportRefused(`${path} is a link to ${target}, outside the archive. Links are not followed`)
      t.skip(path, 'link')
      continue
    }
    if (e.kind === 'other') {
      t.skip(path, 'not a regular file')
      continue
    }
    t.depth(path, parts.length)
    // Two names differing only in case or Unicode normal form are the same file on macOS's filesystem — the list the person saw would no longer match the files actually written
    const key = parts.map((p) => p.normalize('NFC').toLowerCase())
    for (let i = 1; i < key.length; i++) {
      const dir = wireJoin(...key.slice(0, i))
      if (seen.get(dir) === 'file') throw new ImportRefused(`The archive has both a file and a folder named ${wireJoin(...parts.slice(0, i))}`)
      seen.set(dir, 'dir')
    }
    const k = wireJoin(...key)
    const kind = e.kind === 'dir' ? 'dir' : 'file'
    const had = seen.get(k)
    if (had && (had === 'file' || kind === 'file')) throw new ImportRefused(`The archive has two entries for ${path}`)
    seen.set(k, kind)
    if (kind === 'file') t.file(path, e.size)
    plan.push({ parts, e })
  }

  mkdirSync(dest)
  for (const { parts, e } of plan) {
    const out = join(dest, ...parts)
    if (!inside(dest, out)) throw new ImportRefused(`${wireJoin(...parts)} would be written outside the app folder`)
    if (e.kind === 'dir') {
      mkdirSync(out, { recursive: true })
      continue
    }
    mkdirSync(join(dest, ...parts.slice(0, -1)), { recursive: true })
    let data: Buffer
    try {
      data = readZipEntry(buf, e)
    } catch (err) {
      throw new ImportRefused(err instanceof ZipError ? err.message : `Could not unpack ${wireJoin(...parts)}: ${(err as Error).message}`)
    }
    writeFileSync(out, data, { mode: 0o644 })
  }
  t.out.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return t.out
}

/**
 * A zip entry name → path segments. Every shape that could escape is rejected (zip slip): an
 * absolute path, a drive letter, a backslash, `..`, `.`, an empty segment (`a//b`), and control
 * characters. The only trailing `/` accepted is for a directory entry.
 */
function zipParts(name: string, limits: ImportLimits): string[] {
  if (name.length > limits.pathChars) throw new ImportRefused(`An entry name is longer than ${limits.pathChars} characters`)
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new ImportRefused(`An entry name contains a control character: ${JSON.stringify(name)}`)
  if (name.includes('\\')) throw new ImportRefused(`An entry name uses a backslash: ${name}`)
  if (name.startsWith('/') || /^[a-z]:/i.test(name)) throw new ImportRefused(`An entry has an absolute path: ${name}`)
  const parts = name.endsWith('/') ? wireSegments(name.slice(0, -1)) : wireSegments(name)
  if (name === '/' || name === '') return []
  for (const p of parts) {
    if (p === '' || p === '.' || p === '..') throw new ImportRefused(`An entry's path leaves the archive or is malformed: ${name}`)
  }
  return parts
}

/**
 * Reads and validates the manifest of a staged folder — the same validation set discovery uses
 * (`parseManifest`), plus the naming rule for a newly joining app: #93's character rule and the ban
 * on the `app-` prefix (`proposedMcpServerNameError`, the same as for a new app), and a ban on a
 * built-in app's id.
 */
export function readStagedManifest(dir: string, reservedIds: readonly string[]): { manifest: AppManifest; warnings: string[] } {
  const path = join(dir, MANIFEST_FILE)
  let size: number
  try {
    const st = lstatSync(path)
    if (!st.isFile()) throw new Error('not a file')
    size = st.size
  } catch {
    throw new ImportRefused(`There is no ${MANIFEST_FILE} at the top, so this is not a Centralu app`)
  }
  if (size > MAX_MANIFEST_BYTES) throw new ImportRefused(`${MANIFEST_FILE} is larger than ${MAX_MANIFEST_BYTES} bytes`)
  const parsed = parseManifest(readFileSync(path, 'utf8'))
  if (!parsed.ok) throw new ImportRefused(`${MANIFEST_FILE} is not valid: ${parsed.error}`)
  const id = parsed.manifest.id
  const idProblem = proposedMcpServerNameError(id)
  if (idProblem) throw new ImportRefused(`The app id "${id}" cannot be used: ${idProblem}`)
  if (reservedIds.includes(id)) throw new ImportRefused(`"${id}" is the name of a built-in app; this app cannot be imported under it`)
  return { manifest: parsed.manifest, warnings: parsed.warnings }
}

/**
 * What a person reviews before enabling an app (E-3) — what it runs (the command and arguments),
 * what it declares it uses (uses), which secrets it wants, and which files come with it. `reviewKey`
 * is the key over the part enabling is tied to (server and uses).
 */
export function reviewOf(
  manifest: AppManifest,
  staged: StagedFiles,
  meta: { source: string; warnings: string[]; changed?: AppReview['changed'] },
): AppReview {
  return {
    appId: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    server: { command: manifest.server.command, args: manifest.server.args },
    uses: {
      ...(manifest.uses.agent !== undefined ? { agent: manifest.uses.agent } : {}),
      ...(manifest.uses.apps ? { apps: manifest.uses.apps } : {}),
      ...(manifest.uses.host ? { host: manifest.uses.host } : {}),
    },
    secrets: manifest.secrets ?? [],
    home: manifest.home ?? null,
    viewOrigin: manifest.view?.origin ?? 'opaque',
    files: staged.files,
    totalBytes: staged.totalBytes,
    skipped: staged.skipped,
    warnings: meta.warnings,
    reviewKey: reviewKey(manifest),
    source: meta.source,
    changed: meta.changed ?? null,
  }
}

/**
 * A file listing for an app folder already brought in — what the re-review dialog shows. Walked with
 * the same rules as staging (a link is never followed, and a dot-name is only recorded), but nothing
 * is written. If a cap is exceeded, this stops right there and records that fact — showing an
 * incomplete listing is never a reason to block the app.
 */
export function listAppFiles(dir: string, limits: ImportLimits): StagedFiles {
  const out: StagedFiles = { files: [], totalBytes: 0, skipped: [] }
  const walk = (rel: string, depth: number): boolean => {
    let entries: Dirent[]
    try {
      entries = readdirSync(rel ? join(dir, rel) : dir, { withFileTypes: true })
    } catch {
      return true
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (hiddenPart(e.name)) {
        out.skipped.push({ path: e.isDirectory() ? `${r}/` : r, why: 'hidden' })
        continue
      }
      if (e.isSymbolicLink()) {
        out.skipped.push({ path: r, why: 'link' })
        continue
      }
      if (e.isDirectory()) {
        if (depth + 1 > limits.depth || !walk(r, depth + 1)) return false
        continue
      }
      if (!e.isFile()) continue
      if (out.files.length >= limits.files) {
        out.skipped.push({ path: `${rel || '.'}/…`, why: `more than ${limits.files} files; the rest are not listed` })
        return false
      }
      let bytes = 0
      try {
        bytes = lstatSync(join(dir, r)).size
      } catch {
        // disappeared while being read
      }
      out.files.push({ path: r, bytes })
      out.totalBytes += bytes
    }
    return true
  }
  walk('', 0)
  return out
}

/** Cleans up one staging entry — silently, even on failure (the next startup cleans the whole staging area) */
export function discard(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}
