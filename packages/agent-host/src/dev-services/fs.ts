import { bytesText } from '../bytes-text.js'
import { isObj } from '../json-value.js'
import { errnoCode, isMissing } from '../os/errors.js'
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, open, readdir, readlink, realpath, stat, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { folderNameError, IMAGE_PREVIEW_MAX_BYTES, wireBaseName, wireJoin, type FsEntry, type FsFile } from '@cc/protocol'
import { assertCreatePath, assertExistingPath, canonicalPath, isInside, MissingPathError, pathParts, UnsafePathError } from './path-guard.js'
import { runGit, type GitTrust } from './git-exec.js'
import { clonesFiles, familyOf, HOST_PLATFORM, traitsFor, type Platform } from '../os.js'
import { realOs } from '../os/real.js'
import { retarget } from '../os/rules.js'
import { rpcError } from '../rpc-error.js'

/**
 * The file tree and viewer service (C-1).
 *
 * Two principles:
 *   1. **Read only one level at a time** — the first render has to be fast even on a repository
 *      with 10k+ files.
 *   2. **Never leave the project** — blocks a path escape (`../../etc/passwd`); *moving* or *trashing* the wrong
 *      entry destroys something the person never pointed at.
 *
 * Operations reject traversal and symlink escapes before use; reads also check the opened object's identity. These
 * pathname guards are not an atomic sandbox against concurrent same-user filesystem mutations.
 */

// What `listDir` and `readTextFile` answer are the protocol's shapes (`fs.listDir`, `fs.readFile`), not copies of them
export type { FsEntry, FsFile }

const MAX_TEXT = 2_000_000 // past 2MB this is truncated for display (the viewer virtual-scrolls anyway)
const MAX_IMAGE_PREVIEW = IMAGE_PREVIEW_MAX_BYTES
const READ_TEXT_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW

/** Raster formats the viewer can safely show with `img`. SVG is left to the text viewer. */
const IMAGE_MIMES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
}

function imageMime(path: string): string | undefined {
  return IMAGE_MIMES[extname(path).slice(1).toLowerCase()]
}

/** Blocks a path from leaving the project root */
export function safeJoin(root: string, rel: string): string {
  const target = resolve(root, rel || '.')
  if (!isInside(resolve(root), target)) {
    throw rpcError('Path is outside the project')
  }
  return target
}

function fail(message: string): never {
  throw rpcError(message)
}

/**
 * The last segment of a path, and nothing else.
 *
 * Both writing operations take a *name* we do not control (the source entry of a move, the OS for a drop) and paste
 * it onto a destination directory, so `../../.ssh/authorized_keys` must not climb out (`safeJoin` would catch it
 * later, without saying so).
 *
 * Which characters are separators is a security question (#47): `/` is the wire's, while `\` is an ordinary character
 * on macOS and Linux but a separator on Windows. So the platform is asked, and a name it would read as a path is
 * **refused** rather than reduced to its last piece, which would rename the thing being moved beyond undo.
 */
export function baseName(path: string): string {
  const name = wireBaseName(path)
  if (!name || name === '.' || name === '..') fail(`Not a file name: ${path || '(empty)'}`)
  if (basename(name) !== name) fail(`Not a file name: ${path}`)
  return name
}

/**
 * Where "drop this onto that folder" lands, as a project-relative path.
 *
 * The gesture is *into a directory*, so the caller never gets to choose the new name —
 * which is also why renaming is not reachable through this door (it is out of scope, #19).
 */
export function moveTarget(from: string, toDir: string): string {
  return wireJoin(toDir, baseName(from))
}

/**
 * Move a file or folder inside the project (#19).
 *
 * **Never overwrites:** the file already there may be one an agent is mid-edit on. `moved: false` means the drop
 * landed where the entry already was — a miss, not a failure, so the caller stays quiet about it.
 *
 * The destination guard ahead of `rename` is not atomic (POSIX `rename` replaces the destination and Node exposes no
 * `RENAME_NOREPLACE`); the window is between two calls driven by one person's drag, so the realistic collision is a
 * file that was already there, which this catches.
 */
export async function moveEntry(root: string, from: string, toDir: string): Promise<{ path: string; moved: boolean }> {
  const src = safeJoin(root, from)
  await assertExistingPath(root, from)
  if (src === resolve(root)) fail('Cannot move the project itself')
  const rel = moveTarget(from, toDir)
  const dst = safeJoin(root, rel)
  await assertExistingPath(root, toDir)
  const dstState = await assertCreatePath(root, rel)
  if (src === dst) return { path: rel, moved: false }
  // A folder cannot be moved inside itself — `rename` would fail, but with EINVAL, which
  // reaches the person as noise rather than as the reason.
  if (dst.startsWith(src + sep)) fail(`Cannot move ${baseName(from)} into itself`)
  if (dstState.exists) fail(`${rel} already exists — nothing was moved`)
  await realOs().files.promises.rename(src, dst)
  return { path: rel, moved: true }
}

/**
 * Write a file the OS handed us into the project (#19, dragging in from Finder).
 *
 * Bytes rather than a source path: the webview does not tell the page where a dropped file came from. The original
 * stays where it was. `wx` makes the no-overwrite rule atomic here, unlike the move above.
 *
 * On Windows the name must also be one Windows takes as a file's name (#849), checked as a new folder's is. Node
 * writes through `\\?\` paths, so `nul`, `aux.c` or `notes.` would land as a file of that very name, one Explorer,
 * cmd and git read as a device or without its trailing dot or space, and cannot open or remove; and
 * `notes.txt:payload` would write a hidden stream on `notes.txt` past `wx`, not a file of that name.
 */
export async function importFile(
  root: string,
  toDir: string,
  name: string,
  data: Buffer,
  platform: Platform = HOST_PLATFORM,
): Promise<{ path: string }> {
  const base = baseName(name)
  if (traitsFor(platform).hasWindowsFileNames) {
    const why = folderNameError(base, true)
    if (why) fail(why)
  }
  const rel = wireJoin(toDir, base)
  const dst = safeJoin(root, rel)
  const dirInfo = await assertExistingPath(root, toDir)
  await assertCreatePath(root, rel)
  if (!dirInfo.isDirectory()) fail(`${toDir || '.'} is not a folder`)
  await writeFile(dst, data, { flag: 'wx' }).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'EEXIST') fail(`${rel} already exists — nothing was written`)
    throw e
  })
  return { path: rel }
}

/**
 * The absolute path of something that is really there.
 *
 * The desktop shell (Rust) trashes and reveals, knowing nothing of projects, so it is handed a full path made only
 * here. A missing path fails out loud: the shell's answer to one is to do nothing.
 */
export async function resolveExisting(root: string, rel: string): Promise<string> {
  const abs = safeJoin(root, rel)
  const rootReal = await realpath(root)
  const expected = await assertExistingPath(root, rel)
  const canonical = await realpath(abs)
  /*
   * **No test exercises this line, and none can:** it only trips when the filesystem changed between the
   * assertExistingPath above and this realpath. Do not remove it for lacking a test (#86). The dev/ino comparison
   * below asks "is this the same file"; this asks "is this inside". Both stay.
   */
  safeJoin(rootReal, relative(rootReal, canonical))
  const current = await lstat(canonical, { bigint: true })
  if (current.isSymbolicLink() || current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new UnsafePathError('Path changed while resolving the file')
  }
  return canonical
}

/**
 * The absolute path of an entry of the project, **itself**, for the trash (`fs.resolve` with `purpose: 'trash'`, #838).
 *
 * The folder the entry sits in is resolved (links in the middle of the path are followed, inside the project only, as
 * everywhere), and the last segment is taken as it is after an `lstat`, a link included: trashing a link moves the
 * link, never what it points at (following it, as `resolveExisting` does, an untrusted repository's `old-build -> .`
 * would trash the project folder). The project folder is refused, and so is a path that
 * folds to it (`''`, `.`, `a/..`). The shell's trash check allows a link only as the last segment.
 */
export async function resolveEntry(root: string, rel: string): Promise<string> {
  const parts = pathParts(root, rel)
  const name = parts.at(-1)
  if (name === undefined) throw new UnsafePathError(PROJECT_FOLDER_ITSELF)
  if (name === '..') throw new UnsafePathError('Path is outside the project')
  const parentRel = wireJoin(...parts.slice(0, -1))
  const parent = await resolveExisting(root, parentRel)
  const parentInfo = await stat(parent, { bigint: true })
  if (!parentInfo.isDirectory()) throw new UnsafePathError(`${parentRel || '.'} is not a folder`)
  const entry = join(parent, name)
  await lstat(entry).catch((error: unknown) => {
    if (isMissing(error)) throw new MissingPathError(rel)
    throw error
  })
  // The checked string is the used one: a child of a folder inside the project, never the folder itself
  if (!isInside(parent, entry) || entry === parent) throw new UnsafePathError('Path is outside the project')
  return entry
}

/**
 * The absolute path of what an entry is, for revealing it or opening it in an IDE (`fs.resolve` without a trash
 * purpose): a link is followed to its target, which has to be inside the project (`CLAUDE.md -> AGENTS.md` opens
 * `AGENTS.md`), and never the project folder itself (#838: `old-build -> .`).
 */
export async function resolveTarget(root: string, rel: string): Promise<string> {
  const target = await resolveExisting(root, rel)
  if (target === (await realpath(root))) throw new UnsafePathError(PROJECT_FOLDER_ITSELF)
  return target
}

const PROJECT_FOLDER_ITSELF = 'That is the project folder itself, not an entry in it'

/**
 * The project folder itself, for "Delete project and trash folder" (`fs.resolve` with `purpose: 'project'`, #838): the
 * one place the trash may be handed the whole folder. Its real path, so no link is handed to the shell.
 */
export async function resolveProjectFolder(root: string): Promise<string> {
  const folder = await realpath(root)
  if (!(await stat(folder)).isDirectory()) throw new UnsafePathError('The project folder is not a folder')
  return folder
}

/**
 * The .gitignore decision is left to git itself.
 * Calling check-ignore per file would spawn a process per file, so this asks **once per
 * directory** instead. If git is missing or this is not a repository, everything is treated as
 * not ignored.
 */
async function ignoredIn(root: string, names: string[], dir: string, trust: GitTrust): Promise<Set<string>> {
  if (names.length === 0) return new Set()
  // git reads and prints `/` on every platform (#47), so the native separator goes before the pathspec does
  const rel = relative(root, dir).replaceAll(sep, '/')
  // NUL-separated both ways (`-z`, #176): line output, per `core.quotePath`, quotes a Korean name as `"\355\225\234…"`
  const input = names.map((n) => wireJoin(rel, n)).join('\0')
  /*
   * Outside a repository git exits *before reading anything*, and the list lands on a closed pipe: nothing is ignored,
   * which is right, but an unheard EPIPE would end the host. `runGit` swallows it (past 65,536 bytes, about four
   * thousand names, it is certain; CI hit it below that on timing alone).
   *
   * check-ignore exits 1 when nothing matched, which is not an error: what it printed is kept. Before trust, the call
   * runs none of the repository's programs (`core.fsmonitor`, #407).
   */
  let stdout: string
  try {
    stdout = await runGit(root, ['check-ignore', '--stdin', '-z'], { input, allowRepoPrograms: trust.trusted === true })
  } catch (e) {
    stdout = isObj(e) && typeof e.stdout === 'string' ? e.stdout : ''
  }
  const set = new Set<string>()
  for (const path of stdout.split('\0')) {
    const name = wireBaseName(path)
    if (name) set.add(name)
  }
  return set
}

export async function listDir(root: string, rel: string, trust: GitTrust = {}): Promise<FsEntry[]> {
  const dir = safeJoin(root, rel)
  const dirInfo = await assertExistingPath(root, rel)
  if (!dirInfo.isDirectory()) fail(`${rel || '.'} is not a folder`)
  const entries = await readdir(dir, { withFileTypes: true })
  const visible = entries.filter((e) => e.name !== '.git')
  const ignored = await ignoredIn(root, visible.map((e) => e.name), dir, trust)

  return visible
    .map((e) => ({
      name: e.name,
      path: wireJoin(rel, e.name),
      isDir: e.isDirectory(),
      ignored: ignored.has(e.name),
    }))
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
}

export async function readTextFile(root: string, rel: string): Promise<FsFile> {
  const file = await resolveExisting(root, rel)
  // bigint: on NTFS two different files' ids can be equal as Numbers (path-guard.ts, #368)
  const pathInfo = await stat(file, { bigint: true })
  if (!pathInfo.isFile()) fail('Path is not a regular file')

  const handle = await open(file, READ_TEXT_FLAGS)
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile()) fail('Path is not a regular file')
    if (opened.dev !== pathInfo.dev || opened.ino !== pathInfo.ino) {
      throw new UnsafePathError('Path changed while opening the file')
    }
    const size = Number(opened.size)

    const mime = imageMime(rel)
    if (mime && mime !== 'image/svg+xml' && size > MAX_IMAGE_PREVIEW) {
      return {
        text: '',
        truncated: false,
        binary: true,
        bytes: size,
        previewError: `Image is too large to preview (${bytesText(size)}; limit is ${bytesText(MAX_IMAGE_PREVIEW)})`,
      }
    }

    const readLimit = mime && mime !== 'image/svg+xml' ? MAX_IMAGE_PREVIEW : MAX_TEXT
    const buf = Buffer.allocUnsafe(Math.min(size, readLimit) + 1)
    let total = 0
    while (total < buf.length) {
      const { bytesRead } = await handle.read(buf, total, buf.length - total, total)
      if (bytesRead === 0) break
      total += bytesRead
    }
    const bytes = buf.subarray(0, total)

    if (mime) {
      // SVG is both an image and its own source: both are returned so the viewer can offer Text/Preview. It is drawn
      // only as an `<img>`, so an SVG is never injected into or executed in the app's own DOM.
      if (mime === 'image/svg+xml') {
        const truncated = total > MAX_TEXT
        return {
          text: (truncated ? bytes.subarray(0, MAX_TEXT) : bytes).toString('utf8'),
          truncated,
          binary: false,
          bytes: size,
          image: { mime, data: bytes.toString('base64') },
        }
      }
      return { text: '', truncated: false, binary: true, bytes: size, image: { mime, data: bytes.toString('base64') } }
    }

    // A null byte anywhere is treated as binary (the same heuristic git uses)
    const head = bytes.subarray(0, 8000)
    if (head.includes(0)) return { text: '', truncated: false, binary: true, bytes: size }

    const truncated = total > MAX_TEXT
    return {
      text: (truncated ? bytes.subarray(0, MAX_TEXT) : bytes).toString('utf8'),
      truncated,
      binary: false,
      bytes: size,
    }
  } finally {
    await handle.close()
  }
}
/**
 * Copies a file or directory whole — **cloned rather than copied, when possible** (#76).
 *
 * APFS's clonefile shares data blocks copy-on-write, so worktree isolation holds — unlike a symlink, which is why
 * node_modules is cloned rather than linked (one install must never change the other's).
 *
 * Measured (this repository, APFS):
 *   Rust target, 8.5GB — clone 3.98s, 10MB on disk, vs. an ordinary copy at 14.7s, 8.5GB on disk
 *   node_modules, 637MB (pnpm's forest of symlinks) — 4.18s vs. 4.44s (no real difference, and no penalty either)
 *
 * Wherever cloning cannot happen (another filesystem or volume, not APFS, not macOS) it **silently falls back to an
 * ordinary copy**: throwing would block session creation over one failed copy.
 */
export async function copyTree(
  src: string,
  dst: string,
  { clone = cloneTree, links = { from: src, to: dst } }: CopyTreeOptions = {},
): Promise<void> {
  const existed = await lstat(dst).then(
    () => true,
    () => false,
  )
  if (await clone(src, dst)) return
  /*
   * `cp` creates part of the result before it fails (#167), and an ordinary copy on top dies with
   * `ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY` on a directory symlink already there, so the half-finished result is deleted.
   * A destination that existed before the copy started was never ours and is left untouched.
   */
  if (!existed) await realOs().files.promises.rm(dst, { recursive: true, force: true })
  if (!traitsFor().cpKeepsLinks) return copyTreeWindows(src, dst, links)
  // The `Os`'s copy, which makes every link again as a link and never follows one (a link in a circle ends the host in
  // Node's own `cpSync`). verbatimSymlinks: without it Node rewrites a relative link into an absolute one into the
  // source, and dropEscapingLinks would remove every pnpm link in a Linux worktree. macOS takes the clone path above
  // (`dropEscapingLinks` retargets its links, #1708). `links`: a whole link into the project leads to the same place
  // in the worktree, as copyTreeWindows makes it.
  // Sync: a 20 000-entry pnpm tree takes 1.7 s this way and 7.4 s step by step through promises (Linux)
  realOs().files.cpSync(src, dst, { recursive: true, verbatimSymlinks: true, links })
}

export type CopyTreeOptions = {
  /** The clone to try first; the ordinary copy runs when it answers false */
  clone?: (src: string, dst: string) => Promise<boolean>
  /**
   * The folder whose copy this is and the one it lands in (the project and its worktree). On Windows a link whose
   * target is inside `from` is made again pointing at the same place inside `to`; any other link is left out. Without
   * it, `src` and `dst` themselves.
   */
  links?: { from: string; to: string }
}

/**
 * The ordinary copy on Windows (#849): a walk that never follows a link.
 *
 * Not `cpSync`: pnpm (without Developer Mode) and npm/yarn workspaces link folders with junctions, which `cpSync`
 * copies as real folders (breaking resolution, hiding outside targets from `dropEscapingLinks`), and two junctions
 * pointing at each other end the host with 0xC0000409 (measured on Windows 11, Node 22.23).
 *
 * A junction is made again pointing at the same place in the worktree; a relative symlink is kept as written. A link
 * whose resolved target is not inside `links.from` is not made at all: it would be a window out of the worktree.
 *
 * What is a link comes from the folder's listing, never `lstat`, which calls a reparse point a link only when it can
 * read the target: a junction to a volume path (`\??\Volume{…}\…`, `\??\GLOBALROOT\…`), which anyone can make, would
 * be walked as a folder. A walked folder, too deep a tree and too many entries stop the copy as a last guard.
 */
async function copyTreeWindows(src: string, dst: string, links: { from: string; to: string }): Promise<void> {
  const from = canonicalPath(links.from)
  const to = canonicalPath(links.to)
  // `src` itself is a real path (resolveExisting), so lstat can be asked about it
  const top = await lstat(src)
  const kind = (e: { isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean }): CopyKind =>
    e.isSymbolicLink() ? 'link' : e.isDirectory() ? 'folder' : e.isFile() ? 'file' : 'other'
  const pending: { source: string; target: string; kind: CopyKind; depth: number }[] = [
    { source: src, target: dst, kind: kind(top), depth: 0 },
  ]
  const walked = new Set<string>()
  let entries = 0
  while (pending.length > 0) {
    const item = pending.pop()
    if (!item) break
    const { source, target, kind: what, depth } = item
    if (++entries > MAX_COPY_ENTRIES) throw new Error(`more than ${MAX_COPY_ENTRIES} entries in ${src}; the copy stopped`)
    if (what === 'link') {
      const left = await copyLinkWindows(source, target, from, to)
      if (left) console.error(`[copy] link left out (${left}): ${source}`)
    } else if (what === 'folder') {
      if (depth > MAX_COPY_DEPTH) throw new Error(`${source} is more than ${MAX_COPY_DEPTH} folders deep; the copy stopped`)
      const real = await realpath(source)
      if (walked.has(real)) {
        console.error(`[copy] folder left out (already copied from ${real}): ${source}`)
        continue
      }
      walked.add(real)
      await mkdir(target, { recursive: true })
      for (const entry of await readdir(source, { withFileTypes: true })) {
        pending.push({ source: join(source, entry.name), target: join(target, entry.name), kind: kind(entry), depth: depth + 1 })
      }
    } else if (what === 'file') {
      await copyFile(source, target)
    }
    // Anything else (a socket, a device) is not something a copy can carry
  }
}

type CopyKind = 'link' | 'folder' | 'file' | 'other'

/** Guards against a walk that never ends; a project's node_modules is far below both (this repository: about 10^5) */
const MAX_COPY_ENTRIES = 2_000_000
const MAX_COPY_DEPTH = 256

/** Makes the link `source` again at `target`; or says why it was left out */
async function copyLinkWindows(source: string, target: string, from: string, to: string): Promise<string | null> {
  const written = await readlink(source).catch(() => null)
  if (written === null) return 'its target cannot be read'
  // Where it really leads, so a short name or another case of the project folder still counts as inside it
  const real = canonicalPath(resolve(dirname(source), written))
  const there = retarget(real, { from, to }, 'windows')
  if (there === null) return `points outside ${from}`
  const folder = await stat(real).then(
    (s) => s.isDirectory(),
    () => true, // dangling: a junction is the only link made without a privilege, and its target may still appear
  )
  if (!isAbsolute(written)) {
    try {
      await symlink(written, target, folder ? 'dir' : 'file')
      return null
    } catch (e) {
      // Without Developer Mode or administrator rights a symlink cannot be made; a junction or a copy can
      if (errnoCode(e) !== 'EPERM') throw e
    }
  }
  if (folder) await symlink(there, target, 'junction')
  else await copyFile(real, target)
  return null
}

/** A macOS clonefile copy. Returns false wherever it cannot happen (a different volume, not APFS, not macOS) */
async function cloneTree(src: string, dst: string): Promise<boolean> {
  if (!clonesFiles()) return false
  return new Promise<boolean>((done) => {
    // -c demands clonefile (used if it can be, failed otherwise — it never quietly falls back to a copy on its own)
    const p = spawn('/bin/cp', ['-Rc', src, dst], { stdio: 'ignore', windowsHide: true })
    p.on('error', () => done(false))
    p.on('close', (code) => done(code === 0))
  })
}

/**
 * Creates the spot a copy will land in and returns its absolute path — **asking the guard one
 * level at a time:** a recursive `mkdir` follows a tracked `logs -> /somewhere`, and copying `logs/.env` would write a
 * secret outside. Level by level stops where the symlink is, leaving not even an empty directory outside.
 */
export async function prepareCopyTarget(root: string, rel: string): Promise<string> {
  const parts = relative(resolve(root), resolve(root, rel || '.')).split(sep).filter((part) => part.length > 0)
  for (let i = 1; i < parts.length; i++) {
    const branch = parts.slice(0, i).join(sep)
    if (!(await assertCreatePath(root, branch)).exists) await mkdir(join(root, branch))
  }
  await assertCreatePath(root, parts.join(sep))
  return join(root, ...parts)
}

/**
 * Picks out and removes **only the symlinks that point outside the worktree** from a
 * freshly copied tree. Returns what was removed.
 *
 * Links are kept: pnpm's node_modules is a forest of relative symlinks (1,368 in this repository) that point into
 * their own tree, so in the worktree they point into the worktree; flattening them would blow up size, loop, and
 * break pnpm's shape. One pointing outside is a window that looks to an agent like a file in its own tree (#95), so
 * only it goes, rather than the whole tree. The walk takes 177ms (measured) next to a 4 s copy, and never follows a
 * link, so it cannot cycle.
 *
 * Given `from`, the folder `root` is a copy of (the project, for its worktree), a link that leads into `from` is made
 * again leading to the same place inside `root` (`retarget`), as `copyTree`'s `links` rule makes it on Linux and
 * Windows: macOS's clone keeps every link as written, so this is where its copy follows the rule too (#1708).
 */
export async function dropEscapingLinks(root: string, start: string, from?: string): Promise<string[]> {
  const rootReal = await realpath(root)
  const startReal = await realpath(start)
  if (!isInside(rootReal, startReal)) throw new UnsafePathError('Path is outside the project')
  const fromReal = from === undefined ? null : await realpath(from).catch(() => null)

  const removed: string[] = []
  const stack = [startReal]
  while (stack.length > 0) {
    const dir = stack.pop()
    if (dir === undefined) break
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue // covers copying a single file (ENOTDIR) and something that vanished in the meantime — nothing to see in either case
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        const target = await linkTarget(abs)
        if (isInside(rootReal, target)) continue
        await realOs().files.promises.rm(abs, { force: true })
        const there = fromReal === null ? null : retarget(target, { from: fromReal, to: rootReal }, familyOf())
        // To a folder a junction, which Windows makes without a privilege (elsewhere the kind is not asked); one that
        // cannot be made is dropped, as one leading outside
        const kind = there !== null && (await stat(there).then((s) => s.isDirectory(), () => false)) ? 'junction' : undefined
        if (there === null || !(await symlink(there, abs, kind).then(() => true, () => false))) removed.push(relative(rootReal, abs))
      } else if (entry.isDirectory()) {
        stack.push(abs)
      }
    }
  }
  return removed
}

/** Where a link really leads */
async function linkTarget(link: string): Promise<string> {
  /*
   * A broken link cannot be resolved by realpath. The judgment is still made on the text alone —
   * the target not existing right now only means it cannot be read right now, and a link
   * pointing at `~/.ssh/id_rsa` becomes a window the moment that file comes into existence.
   */
  return realpath(link).catch(async () => resolve(dirname(link), await readlink(link)))
}

