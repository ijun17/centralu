import type { CopyTreeOptions, LinkKind, OsDirent, OsError, OsStats } from './port.js'
import type { PlatformPath } from 'node:path'
import { retarget, type OsFamily } from './rules.js'

/**
 * The `Os`'s tree copy (`cpSync`, `promises.cp`), one definition for the real OS and the in-memory one (#1650,
 * docs/plans/os-layer.md §7.1). It never walks into a link: every link in the tree, the root too, is made again as a link.
 * Of what is behind one it asks only whether it is a folder (on Windows, to make the right kind) and, with `links`,
 * where it really leads (to tell one into the tree); of the target's parents, which entries they are (to refuse a copy
 * into itself). So a link can neither make a copy endless nor end the
 * process, whatever it leads to. Changes made while it copies cannot either: an entry is copied as what `lstat` or the
 * listing says it is, whichever says link; only a folder swapped for a link in the instant between its `lstat` and its
 * listing is listed through that link, once, and its entries are copied by the same rules.
 *
 * Node's own `cpSync` follows links in places and ended the host on a tree with a link in a circle (`a -> b -> a`,
 * `x -> x`: exit 0xC0000409 on Windows, an uncaught C++ `filesystem_error`, abort, on Linux) and on Windows on any
 * junction back into the tree, which it copied as the folder it leads to. Checking the tree first could not close it: a
 * link changed between the check and the copy still ended the process (10 of 40 copies on Windows, #1650 review).
 *
 * The copy is written once, as the steps it takes (`copySteps`); `copyTreeSync` and `copyTreeAsync` carry them out
 * with an `Os`'s own sync or promise calls, so the asynchronous copy never blocks the event loop.
 */

/** What the copy asks of the files, sync or not: the `Os`'s own calls of the same names */
export type CopyStep =
  | { op: 'lstat'; path: string }
  | { op: 'stat'; path: string }
  | { op: 'list'; path: string }
  | { op: 'leadsToFolder'; path: string }
  | { op: 'real'; path: string }
  | { op: 'readlink'; path: string }
  | { op: 'mkdir'; path: string; parents: boolean }
  | { op: 'copyFile'; from: string; to: string }
  | { op: 'symlink'; target: string; path: string; kind: LinkKind | undefined }
  | { op: 'unlink'; path: string }
  | { op: 'chmod'; path: string; mode: number }
  | { op: 'utimes'; path: string; atimeMs: number; mtimeMs: number }

/** The answer to a step: what was read, or `done` */
export type CopyAnswer =
  | { op: 'lstat'; stat: OsStats | undefined }
  | { op: 'stat'; stat: OsStats | undefined }
  | { op: 'list'; entries: readonly OsDirent[] }
  | { op: 'leadsToFolder'; yes: boolean }
  | { op: 'real'; path: string | null }
  | { op: 'readlink'; text: string }
  | { op: 'done' }

type Steps<T> = Generator<CopyStep, T, CopyAnswer>

const unexpected = (step: CopyStep['op'], answer: CopyAnswer): Error => new Error(`copy: ${answer.op} given for ${step}`)

function* lstat(path: string): Steps<OsStats | undefined> {
  const a = yield { op: 'lstat', path }
  if (a.op !== 'lstat') throw unexpected('lstat', a)
  return a.stat
}
/** Through links; no entry is undefined (as `throwIfNoEntry: false`), any other refusal throws */
function* stat(path: string): Steps<OsStats | undefined> {
  const a = yield { op: 'stat', path }
  if (a.op !== 'stat') throw unexpected('stat', a)
  return a.stat
}
function* list(path: string): Steps<readonly OsDirent[]> {
  const a = yield { op: 'list', path }
  if (a.op !== 'list') throw unexpected('list', a)
  return a.entries
}
function* leadsToFolder(path: string): Steps<boolean> {
  const a = yield { op: 'leadsToFolder', path }
  if (a.op !== 'leadsToFolder') throw unexpected('leadsToFolder', a)
  return a.yes
}
function* real(path: string): Steps<string | null> {
  const a = yield { op: 'real', path }
  if (a.op !== 'real') throw unexpected('real', a)
  return a.path
}
function* readlink(path: string): Steps<string> {
  const a = yield { op: 'readlink', path }
  if (a.op !== 'readlink') throw unexpected('readlink', a)
  return a.text
}

/** One of Node's own copy errors, by its code and message */
function cpError(code: string, message: string, path: string): OsError {
  return Object.assign(new Error(message), { code, syscall: 'cp', path })
}

/** One entry by `dev` and `ino`, as Node's `areIdentical`: one the volume gives no number (`ino` or `dev` 0) is no other */
const sameEntry = (a: OsStats, b: OsStats) => !!a.ino && !!a.dev && a.ino === b.ino && a.dev === b.dev

type Kind = 'file' | 'dir' | 'link' | 'other'
const kindOf = (e: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): Kind =>
  e.isSymbolicLink() ? 'link' : e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other'

/**
 * The kind of link a copy makes on Windows for a link whose target is `target`, by what it leads to: to a folder, a
 * junction when the target is a whole path on a drive (it needs no right, where a directory symlink needs Developer
 * Mode or an administrator, as a file symlink does), else a directory symlink (a relative target, or a share, which a
 * junction cannot hold); to a file or to nothing, a file symlink. Node's APIs cannot tell a junction from a directory symlink to a whole path
 * (`readlink`, `lstat` and the listing answer the same), and both lead to the same place for the host, so the copy
 * keeps what they have in common. POSIX has one kind of link: no kind is given there.
 */
export function copiedLinkKind(target: string, toFolder: boolean, family: OsFamily): LinkKind | undefined {
  if (family !== 'windows') return undefined
  if (!toFolder) return 'file'
  return /^(\\\\\?\\)?[A-Za-z]:[\\/]/.test(target) ? 'junction' : 'dir'
}

/**
 * The steps of copying `from` to `to`, Node's `cp` with the options the `Os` offers:
 * - Node's refusals first: the same file (`ERR_FS_CP_EINVAL`), a folder into itself (`ERR_FS_CP_EINVAL`: a parent of
 *   `to` that is `from` by `dev` and `ino`, as Node's `checkParentPaths`, so through a link, a share to the same disk
 *   (`\\localhost\C$\…`) or a bind mount too; parents not made yet are passed over, where Node stops at the first),
 *   a folder onto a non-folder and back (`ERR_FS_CP_DIR_TO_NON_DIR`, `ERR_FS_CP_NON_DIR_TO_DIR`, at the root and
 *   below it), a folder without `recursive` (`ERR_FS_EISDIR`), anything not a file, folder or link
 *   (`ERR_FS_CP_UNKNOWN`: a FIFO, which `copyFile` would wait on for ever). The parent of `to` is made.
 * - A folder is made with its source's mode once its entries are in; one already there is copied into, its mode kept.
 * - A file: one there is replaced (`force`, the default), or kept, or `ERR_FS_CP_EEXIST` with `errorOnExist`; the copy
 *   takes the source's mode, and with `preserveTimestamps` its access and change times.
 * - A link (by the listing or `lstat`, whichever says link, so a reparse point `lstat` cannot read is never walked
 *   into): made again with its target as written with `verbatimSymlinks`, else a relative one read from the link's
 *   folder (Node's rule). With `links`, a whole target inside `links.from`, as written or where the link really leads,
 *   is made leading to the same place inside `links.to` (`retarget`); a relative one is kept as written, which leads
 *   into the copy already if it led into the tree. One there that is a link is replaced; anything else is `EEXIST`.
 * - An entry gone since its folder was listed is not copied.
 */
export function* copySteps(from: string, to: string, o: CopyTreeOptions, family: OsFamily, P: PlatformPath): Steps<void> {
  const src = yield* lstat(from)
  if (!src) throw Object.assign(new Error(`ENOENT: no such file or directory, lstat '${from}'`), { code: 'ENOENT', syscall: 'lstat', path: from })
  const dest = yield* lstat(to)
  const srcKind = kindOf(src)
  if (dest && sameEntry(dest, src)) throw cpError('ERR_FS_CP_EINVAL', `Invalid src or dest: cp returned EINVAL (src and dest cannot be the same) ${to}`, to)
  if (srcKind === 'dir' && dest && !dest.isDirectory()) throw cpError('ERR_FS_CP_DIR_TO_NON_DIR', `Cannot overwrite non-directory ${to} with directory ${from}`, to)
  if (srcKind !== 'dir' && dest?.isDirectory()) throw cpError('ERR_FS_CP_NON_DIR_TO_DIR', `Cannot overwrite directory ${to} with non-directory ${from}`, to)
  if (srcKind === 'dir') {
    // Every parent of `to` up to the root, through links; one not there yet is passed over
    for (let above = P.dirname(P.resolve(to)), last = ''; above !== last; last = above, above = P.dirname(above)) {
      const parent = yield* stat(above)
      if (parent && sameEntry(parent, src)) {
        throw cpError('ERR_FS_CP_EINVAL', `Invalid src or dest: cp returned EINVAL (cannot copy ${from} to a subdirectory of self ${to}) ${to}`, to)
      }
    }
  }
  yield { op: 'mkdir', path: P.dirname(P.resolve(to)), parents: true }

  // Where the tree `links.from` really is, asked once and only for a link lexically outside it
  let realFrom: string | null | undefined

  // Depth first in listing order, as Node's; a folder's mode is set once what is in it is copied
  type Task = { kind: Kind; from: string; to: string; stat: OsStats | undefined } | { kind: 'mode'; to: string; mode: number }
  const tasks: Task[] = [{ kind: srcKind, from, to, stat: src }]
  for (let t = tasks.pop(); t; t = tasks.pop()) {
    if (t.kind === 'mode') {
      yield { op: 'chmod', path: t.to, mode: t.mode }
      continue
    }
    if (t.kind === 'other') throw cpError('ERR_FS_CP_UNKNOWN', `Cannot copy an unknown file type: ${t.from}`, t.from)
    const there = yield* lstat(t.to)
    // A link by the listing or by `lstat` is a link: the listing sees a reparse point `lstat` cannot read, and `lstat`
    // a folder swapped for a link since the listing. An entry gone since then is not copied
    const stat = t.kind === 'link' ? undefined : (t.stat ?? (yield* lstat(t.from)))
    if (t.kind !== 'link' && !stat) continue
    if (!stat || stat.isSymbolicLink()) {
      const written = yield* readlink(t.from)
      let target = o.verbatimSymlinks || P.isAbsolute(written) ? written : P.resolve(P.dirname(t.from), written)
      if (o.links && P.isAbsolute(target)) {
        let moved = retarget(target, o.links, family)
        // Outside by name, it may still lead inside: another case or a short name of the tree, a link on the way
        if (moved === null) {
          if (realFrom === undefined) realFrom = yield* real(o.links.from)
          const leads = realFrom === null ? null : yield* real(t.from)
          if (realFrom !== null && leads !== null) moved = retarget(leads, { from: realFrom, to: o.links.to }, family)
        }
        if (moved !== null) target = moved
      }
      const kind = family === 'windows' ? copiedLinkKind(target, yield* leadsToFolder(t.from), family) : undefined
      if (there?.isSymbolicLink()) yield { op: 'unlink', path: t.to }
      yield { op: 'symlink', target, path: t.to, kind }
      continue
    }
    if (t.kind === 'dir') {
      if (!o.recursive) throw cpError('ERR_FS_EISDIR', `Recursive option is required to copy a directory: ${t.from}`, t.from)
      if (there && !there.isDirectory()) throw cpError('ERR_FS_CP_DIR_TO_NON_DIR', `Cannot overwrite non-directory ${t.to} with directory ${t.from}`, t.to)
      if (!there) {
        yield { op: 'mkdir', path: t.to, parents: false }
        tasks.push({ kind: 'mode', to: t.to, mode: stat.mode })
      }
      const entries = yield* list(t.from)
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i]
        if (e) tasks.push({ kind: kindOf(e), from: P.join(t.from, e.name), to: P.join(t.to, e.name), stat: undefined })
      }
      continue
    }
    if (there?.isDirectory()) throw cpError('ERR_FS_CP_NON_DIR_TO_DIR', `Cannot overwrite directory ${t.to} with non-directory ${t.from}`, t.to)
    if (there) {
      if (o.force === false) {
        if (o.errorOnExist) throw cpError('ERR_FS_CP_EEXIST', `Target already exists: cp returned EEXIST (${t.to} already exists)`, t.to)
        continue
      }
      yield { op: 'unlink', path: t.to }
    }
    yield { op: 'copyFile', from: t.from, to: t.to }
    // A read-only file takes its times before its mode (measured: utimes of one is no refusal on Windows or Linux)
    if (o.preserveTimestamps) yield { op: 'utimes', path: t.to, atimeMs: stat.atimeMs, mtimeMs: stat.mtimeMs }
    yield { op: 'chmod', path: t.to, mode: stat.mode }
  }
}

/** The calls `copyTreeSync` makes: an `Os`'s `files` */
export type CopyFilesSync = {
  lstatSync(path: string, options: { throwIfNoEntry: false }): OsStats | undefined
  statSync(path: string, options: { throwIfNoEntry: false }): OsStats | undefined
  readdirSync(path: string, options: { withFileTypes: true }): OsDirent[]
  realpathNativeSync(path: string): string
  readlinkSync(path: string): string
  mkdirSync(path: string, options?: { recursive?: boolean }): void
  copyFileSync(from: string, to: string): void
  symlinkSync(target: string, path: string, kind?: LinkKind): void
  unlinkSync(path: string): void
  chmodSync(path: string, mode: number): void
  utimesSync(path: string, atime: number | Date, mtime: number | Date): void
}

/** The calls `copyTreeAsync` makes: an `Os`'s `files.promises` */
export type CopyFilesAsync = {
  lstat(path: string): Promise<OsStats>
  stat(path: string): Promise<OsStats>
  readdir(path: string, options: { withFileTypes: true }): Promise<OsDirent[]>
  realpath(path: string): Promise<string>
  readlink(path: string): Promise<string>
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
  copyFile(from: string, to: string): Promise<void>
  symlink(target: string, path: string, kind?: LinkKind): Promise<void>
  unlink(path: string): Promise<void>
  chmod(path: string, mode: number): Promise<void>
  utimes(path: string, atime: number | Date, mtime: number | Date): Promise<void>
}

const DONE: CopyAnswer = { op: 'done' }
/** What `throwIfNoEntry: false` answers as no entry: ENOENT only (a path through a file throws ENOTDIR on POSIX) */
const isMissing = (e: unknown) => e instanceof Error && 'code' in e && e.code === 'ENOENT'

function answerSync(f: CopyFilesSync, s: CopyStep): CopyAnswer {
  switch (s.op) {
    case 'lstat':
      return { op: 'lstat', stat: f.lstatSync(s.path, { throwIfNoEntry: false }) }
    case 'stat':
      return { op: 'stat', stat: f.statSync(s.path, { throwIfNoEntry: false }) }
    case 'list':
      return { op: 'list', entries: f.readdirSync(s.path, { withFileTypes: true }) }
    case 'leadsToFolder':
      try {
        return { op: 'leadsToFolder', yes: f.statSync(s.path, { throwIfNoEntry: false })?.isDirectory() ?? false }
      } catch {
        return { op: 'leadsToFolder', yes: false }
      }
    case 'real':
      try {
        return { op: 'real', path: f.realpathNativeSync(s.path) }
      } catch {
        return { op: 'real', path: null }
      }
    case 'readlink':
      return { op: 'readlink', text: f.readlinkSync(s.path) }
    case 'mkdir':
      f.mkdirSync(s.path, { recursive: s.parents })
      return DONE
    case 'copyFile':
      f.copyFileSync(s.from, s.to)
      return DONE
    case 'symlink':
      f.symlinkSync(s.target, s.path, s.kind)
      return DONE
    case 'unlink':
      f.unlinkSync(s.path)
      return DONE
    case 'chmod':
      f.chmodSync(s.path, s.mode)
      return DONE
    case 'utimes':
      f.utimesSync(s.path, s.atimeMs / 1000, s.mtimeMs / 1000)
      return DONE
  }
}

async function answerAsync(f: CopyFilesAsync, s: CopyStep): Promise<CopyAnswer> {
  switch (s.op) {
    case 'lstat':
      try {
        return { op: 'lstat', stat: await f.lstat(s.path) }
      } catch (e) {
        if (isMissing(e)) return { op: 'lstat', stat: undefined }
        throw e
      }
    case 'stat':
      try {
        return { op: 'stat', stat: await f.stat(s.path) }
      } catch (e) {
        if (isMissing(e)) return { op: 'stat', stat: undefined }
        throw e
      }
    case 'list':
      return { op: 'list', entries: await f.readdir(s.path, { withFileTypes: true }) }
    case 'leadsToFolder':
      return { op: 'leadsToFolder', yes: await f.stat(s.path).then((st) => st.isDirectory(), () => false) }
    case 'real':
      return { op: 'real', path: await f.realpath(s.path).catch(() => null) }
    case 'readlink':
      return { op: 'readlink', text: await f.readlink(s.path) }
    case 'mkdir':
      await f.mkdir(s.path, { recursive: s.parents })
      return DONE
    case 'copyFile':
      await f.copyFile(s.from, s.to)
      return DONE
    case 'symlink':
      await f.symlink(s.target, s.path, s.kind)
      return DONE
    case 'unlink':
      await f.unlink(s.path)
      return DONE
    case 'chmod':
      await f.chmod(s.path, s.mode)
      return DONE
    case 'utimes':
      await f.utimes(s.path, s.atimeMs / 1000, s.mtimeMs / 1000)
      return DONE
  }
}

/** `copySteps` with sync calls */
export function copyTreeSync(f: CopyFilesSync, from: string, to: string, o: CopyTreeOptions | undefined, family: OsFamily, P: PlatformPath): void {
  const steps = copySteps(from, to, o ?? {}, family, P)
  for (let s = steps.next(); !s.done; ) s = steps.next(answerSync(f, s.value))
}

/** `copySteps` with promise calls: nothing in it blocks the event loop */
export async function copyTreeAsync(f: CopyFilesAsync, from: string, to: string, o: CopyTreeOptions | undefined, family: OsFamily, P: PlatformPath): Promise<void> {
  const steps = copySteps(from, to, o ?? {}, family, P)
  for (let s = steps.next(); !s.done; ) s = steps.next(await answerAsync(f, s.value))
}
