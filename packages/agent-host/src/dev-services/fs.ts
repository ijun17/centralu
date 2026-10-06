import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, readlink, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { wireBaseName, wireJoin } from '@cc/protocol'
import { assertCreatePath, assertExistingPath, UnsafePathError } from './path-guard.js'
import { runGit, type GitTrust } from './git-exec.js'

/**
 * The file tree and viewer service (C-1).
 *
 * Two principles:
 *   1. **Read only one level at a time** — the first render has to be fast even on a repository
 *      with 10k+ files.
 *   2. **Never leave the project** — blocks a path escape (`../../etc/passwd`).
 *
 * Issues #18/#19 added writing to that list, and writing is where rule 2 stops being a
 * tidiness rule: reading the wrong file leaks it, but *moving* or *trashing* the wrong one
 * destroys something the person never pointed at. Operations reject traversal, canonicalize
 * symlinks that stay under the project root, and reject symlink escapes before use; reads
 * also check the opened object's identity. These pathname guards are not an atomic sandbox
 * against concurrent same-user filesystem mutations.
 */

export type FsEntry = { name: string; path: string; isDir: boolean; ignored: boolean }
export type FsImage = { mime: string; data: string }
export type FsFile = {
  text: string
  truncated: boolean
  binary: boolean
  bytes: number
  /** Raster image bytes for the read-only viewer. Never present for arbitrary binary files. */
  image?: FsImage
  /** Why an otherwise recognized image cannot be previewed (for example, its size). */
  previewError?: string
}

const MAX_TEXT = 2_000_000 // past 2MB this is truncated for display (the viewer virtual-scrolls anyway)
const MAX_IMAGE_PREVIEW = 10_000_000 // 10MB — a cap that can absorb the base64 and WebSocket copy too
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
  const rootResolved = resolve(root)
  if (target !== rootResolved && !target.startsWith(rootResolved + sep)) {
    throw Object.assign(new Error('Path is outside the project'), { code: 'internal' })
  }
  return target
}

function fail(message: string): never {
  throw Object.assign(new Error(message), { code: 'internal' })
}

/**
 * The last segment of a path, and nothing else.
 *
 * Both writing operations take a *name* from somewhere we do not control — the source
 * entry for a move, the OS for a drop — and paste it onto a destination directory. Taking
 * only the last segment is what stops `../../.ssh/authorized_keys` from being a name that
 * climbs out of the destination. `safeJoin` would catch it too; this catches it earlier and
 * says so.
 *
 * Which characters *are* separators is therefore a security question, not a tidiness one, and
 * it has two different answers here (#47). The incoming string is a wire path, so `/` is the
 * only separator in it — that part is settled by the protocol. `\` is settled by the machine:
 * an ordinary character in a file name on macOS and Linux, a separator on Windows. So the
 * platform is asked, and a name it would read as a path is **refused** rather than reduced to
 * its last piece. Reducing it would rename the thing being moved, which is the one outcome
 * nobody can undo — and refusing costs nothing, because a name with a separator in it was never
 * a name.
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
 * **Never overwrites.** A collision is reported, not resolved: the app cannot know whether
 * the file already sitting there is the one an agent is mid-edit on, and quietly replacing
 * it is the one outcome nobody can undo. `moved: false` means the drop landed where the
 * entry already was — a miss, not a failure, so the caller stays quiet about it.
 *
 * The destination guard ahead of `rename` is not atomic (POSIX `rename` replaces the
 * destination and Node exposes no `RENAME_NOREPLACE`). The window is between two calls in
 * one process driven by one person's drag, so the realistic collision is the one this does
 * catch: a file that was already there.
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
  await rename(src, dst)
  return { path: rel, moved: true }
}

/**
 * Write a file the OS handed us into the project (#19, dragging in from Finder).
 *
 * This takes bytes rather than a source path on purpose: the webview does not tell the page
 * where a dropped file came from (which is why pasted and dropped attachments already
 * travel as bytes). So the original stays where it was — the one direction that cannot
 * destroy something outside the project.
 *
 * `wx` makes the no-overwrite rule atomic here, unlike the move above: the create fails if
 * anything is at that path already.
 */
export async function importFile(root: string, toDir: string, name: string, data: Buffer): Promise<{ path: string }> {
  const rel = wireJoin(toDir, baseName(name))
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
 * Trashing and revealing happen in the desktop shell (Rust), which knows nothing about
 * projects — so it has to be handed a full path, and this is the only place allowed to make
 * one. The existence check is part of the contract: "reveal a file that is no longer there"
 * has to fail out loud, because the shell's answer to a missing path is to do nothing.
 */
export async function resolveExisting(root: string, rel: string): Promise<string> {
  const abs = safeJoin(root, rel)
  const rootReal = await realpath(root)
  const expected = await assertExistingPath(root, rel)
  const canonical = await realpath(abs)
  /*
   * **No test exercises this line** — removing it and running the whole suite still passes all
   * 1,284 tests (measured). Not because it is dead code, but because the window it covers cannot
   * be opened by a test: the assertExistingPath just above already confirmed containment by
   * walking it piece by piece, so this only trips when **the filesystem changed** between that
   * check and this realpath.
   *
   * The dev/ino comparison below catches the same race more precisely, but that asks "is this
   * the same file," while this asks "is this inside." They are different questions, so both stay.
   *
   * Do not remove this for lacking a test (#86). A test that could never fail was removed
   * (#121), but a safeguard that cannot be observed is a different matter.
   */
  safeJoin(rootReal, relative(rootReal, canonical))
  const current = await lstat(canonical, { bigint: true })
  if (current.isSymbolicLink() || current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new UnsafePathError('Path changed while resolving the file')
  }
  return canonical
}

/**
 * The .gitignore decision is left to git itself.
 * Calling check-ignore per file would spawn a process per file, so this asks **once per
 * directory** instead. If git is missing or this is not a repository, everything is treated as
 * not ignored.
 */
async function ignoredIn(root: string, names: string[], dir: string, trust: GitTrust): Promise<Set<string>> {
  if (names.length === 0) return new Set()
  /*
   * git speaks POSIX (#47). Its index stores `/` on every platform, and `check-ignore` reads and
   * prints paths that way — so the native separator `relative` just produced has to go before
   * the pathspec does, and what comes back needs no conversion at all. On macOS and Linux `sep`
   * is already `/` and this replacement does nothing, which is the whole reason it was missing.
   */
  const rel = relative(root, dir).replaceAll(sep, '/')
  /*
   * Both input and output are NUL-separated (`-z`, #176). Line-based output, depending on
   * `core.quotePath`, wrapped a Korean name as `"\355\225\234…"`, which no longer matched the
   * original name below — an ignored Korean file was never shown dimmed. Under `-z`, git returns
   * exactly the string it was given, with no quoting.
   */
  const input = names.map((n) => wireJoin(rel, n)).join('\0')
  /*
   * A project does not have to be a git repository — the first-run screen says so in as many
   * words. When it isn't one, git prints `fatal: not a git repository` and exits *before reading
   * anything*, and the list we are writing lands on a closed pipe. The answer we want is already
   * the right one: nothing is ignored. The danger is the EPIPE itself: a stream 'error' with no
   * listener is an uncaught exception inside the host, the process every session lives in.
   * `runGit` swallows that pipe error (on a small directory the list fits in the pipe buffer and
   * lands before git is gone; past 65,536 bytes, about four thousand names, the EPIPE is
   * certain, and CI hit it on both Linux runners on timing alone).
   *
   * check-ignore exits 1 when nothing matched, which is not an error: what it printed is kept.
   * Before trust, the call runs none of the repository's programs (`core.fsmonitor` ran here,
   * #407).
   */
  let stdout: string
  try {
    stdout = await runGit(root, ['check-ignore', '--stdin', '-z'], { input, allowRepoPrograms: trust.trusted === true })
  } catch (e) {
    stdout = String((e as { stdout?: unknown }).stdout ?? '')
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
        previewError: `Image is too large to preview (${(size / 1_000_000).toFixed(1)}MB; limit is ${MAX_IMAGE_PREVIEW / 1_000_000}MB)`,
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
      /*
       * SVG is both an image and its own source. Dropping text like a raster image would lose
       * the existing code-reading path, and keeping only text would leave no way to check the
       * picture. Both are returned so the viewer can offer Text/Preview. It is drawn only as an
       * `<img>`, so an SVG is never injected into or executed in the app's own DOM.
       */
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
 * APFS's clonefile creates a reference that shares data blocks: not a single byte is written at
 * creation time, and afterward, whichever side is edited only forks off the part that changed
 * (copy-on-write). This means worktree isolation is never broken — the decisive difference from
 * a symlink, and why node_modules is cloned rather than linked (one install must never change
 * the other's).
 *
 * Measured (this repository, APFS):
 *   Rust target, 8.5GB — clone 3.98s, 10MB on disk, vs. an ordinary copy at 14.7s, 8.5GB on disk
 *   node_modules, 637MB (pnpm's forest of symlinks) — 4.18s vs. 4.44s (no real difference, and no penalty either)
 * The gain comes from **content with actual bytes.** For a pile of small files the cost is all
 * metadata, so it is the same either way.
 *
 * There are several places cloning cannot happen — a different filesystem, a different volume,
 * not APFS, not macOS. All of them are handled the same way: **it silently falls back to an
 * ordinary copy.** Throwing here would block session creation over one failed copy, which is
 * exactly the situation this feature exists to prevent.
 */
export async function copyTree(
  src: string,
  dst: string,
  clone: (src: string, dst: string) => Promise<boolean> = cloneTree,
): Promise<void> {
  const existed = await lstat(dst).then(
    () => true,
    () => false,
  )
  if (await clone(src, dst)) return
  /*
   * `cp` already creates part of the result before it fails (#167). Running an ordinary copy on
   * top of that died with `ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY` trying to overwrite a directory
   * symlink that had already come across — the fallback path failed to actually fall back. So
   * the half-finished result is deleted and the copy starts fresh. A destination that already
   * existed before the copy started is left untouched, since it was never ours to begin with.
   */
  if (!existed) await rm(dst, { recursive: true, force: true })
  const { cpSync } = await import('node:fs')
  // verbatimSymlinks: without it Node rewrites a relative link into an absolute one pointing back into the
  // source, so dropEscapingLinks then removed every pnpm link in a Linux worktree as leaving it (seen on CI,
  // 2026-10-04). macOS took the clone path above, which keeps links as they are.
  cpSync(src, dst, { recursive: true, verbatimSymlinks: true })
}

/** A macOS clonefile copy. Returns false wherever it cannot happen (a different volume, not APFS, not macOS) */
async function cloneTree(src: string, dst: string): Promise<boolean> {
  if (process.platform !== 'darwin') return false
  return new Promise<boolean>((done) => {
    // -c demands clonefile (used if it can be, failed otherwise — it never quietly falls back to a copy on its own)
    const p = spawn('/bin/cp', ['-Rc', src, dst], { stdio: 'ignore' })
    p.on('error', () => done(false))
    p.on('close', (code) => done(code === 0))
  })
}

/**
 * Creates the spot a copy will land in and returns its absolute path — **asking the guard one
 * level at a time.**
 *
 * `mkdirSync(dirname(dst), { recursive: true })` silently follows a symlink along the way.
 * If a worktree's checked-out tracked files include `logs -> /somewhere`, a request to copy
 * `logs/.env` would write the user's secret into someone else's directory. Asking the guard for
 * every level, instead of creating the whole path at once, stops exactly at the level where a
 * symlink is found — leaving not even an empty directory outside.
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
 * Why links are kept at all: pnpm's node_modules is a forest of symlinks (1,368 of them in this
 * repository). Following every one and flattening it into a real file would blow up the size,
 * run into circular links, and above all, stop being the shape pnpm expects. Rejecting links
 * outright would make this feature's most common use (bringing over node_modules) simply
 * unusable. Those links point, by relative path, into their own tree, so when placed at the same
 * spot in the worktree they point into the worktree — leaving them as-is is the correct answer.
 *
 * Why only the ones pointing outside are removed: that is the window through which something
 * looks to an agent like an ordinary file inside its own tree (#95). Rejecting the whole tree
 * because one entry looks off would hand the user a workbench with no node_modules at all, which
 * is worse than one missing link. So only the window is closed, and the rest is kept.
 *
 * The read itself is cheap — 177ms (measured) to walk the whole forest above, next to the 4
 * seconds it takes to copy the same tree. This does not follow a link inward: it never gets
 * caught in a cycle, and never walks the same tree twice.
 */
export async function dropEscapingLinks(root: string, start: string): Promise<string[]> {
  const rootReal = await realpath(root)
  const startReal = await realpath(start)
  if (!staysInside(rootReal, startReal)) throw new UnsafePathError('Path is outside the project')

  const removed: string[] = []
  const stack = [startReal]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue // covers copying a single file (ENOTDIR) and something that vanished in the meantime — nothing to see in either case
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        if (await linkStaysInside(rootReal, abs)) continue
        await rm(abs, { force: true })
        removed.push(relative(rootReal, abs))
      } else if (entry.isDirectory()) {
        stack.push(abs)
      }
    }
  }
  return removed
}

async function linkStaysInside(rootReal: string, link: string): Promise<boolean> {
  /*
   * A broken link cannot be resolved by realpath. The judgment is still made on the text alone —
   * the target not existing right now only means it cannot be read right now, and a link
   * pointing at `~/.ssh/id_rsa` becomes a window the moment that file comes into existence.
   */
  const target = await realpath(link).catch(async () => resolve(dirname(link), await readlink(link)))
  return staysInside(rootReal, target)
}

function staysInside(rootReal: string, candidate: string): boolean {
  const rel = relative(rootReal, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}
