import { spawn } from 'node:child_process'
import { readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, relative, resolve, sep } from 'node:path'
import { wireBaseName, wireJoin } from '@cc/protocol'

/**
 * 파일 트리·뷰어 서비스 (C-1).
 *
 * 원칙 둘:
 *   1. **한 단계만 읽는다** — 10k+ 파일 저장소에서도 첫 렌더가 빨라야 한다.
 *   2. **프로젝트 밖으로 나가지 않는다** — 경로 탈출(`../../etc/passwd`)을 막는다.
 *
 * Issues #18/#19 added writing to that list, and writing is where rule 2 stops being a
 * tidiness rule: reading the wrong file leaks it, but *moving* or *trashing* the wrong one
 * destroys something the person never pointed at. So every operation below resolves both
 * ends through `safeJoin` before it touches anything, and the checks are exported as plain
 * functions so they can be tested without a filesystem.
 */

export type FsEntry = { name: string; path: string; isDir: boolean; ignored: boolean }
export type FsFile = { text: string; truncated: boolean; binary: boolean; bytes: number }

const MAX_TEXT = 2_000_000 // 2MB 넘으면 잘라 보여준다 (뷰어는 어차피 가상 스크롤)

/** 프로젝트 루트를 벗어나는 경로를 막는다 */
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

async function exists(abs: string): Promise<boolean> {
  return stat(abs).then(
    () => true,
    () => false,
  )
}

/**
 * Move a file or folder inside the project (#19).
 *
 * **Never overwrites.** A collision is reported, not resolved: the app cannot know whether
 * the file already sitting there is the one an agent is mid-edit on, and quietly replacing
 * it is the one outcome nobody can undo. `moved: false` means the drop landed where the
 * entry already was — a miss, not a failure, so the caller stays quiet about it.
 *
 * The `exists` check ahead of `rename` is not atomic (POSIX `rename` replaces the
 * destination and Node exposes no `RENAME_NOREPLACE`). The window is between two calls in
 * one process driven by one person's drag, so the realistic collision is the one this does
 * catch: a file that was already there.
 */
export async function moveEntry(root: string, from: string, toDir: string): Promise<{ path: string; moved: boolean }> {
  const src = safeJoin(root, from)
  if (src === resolve(root)) fail('Cannot move the project itself')
  const rel = moveTarget(from, toDir)
  const dst = safeJoin(root, rel)
  if (src === dst) return { path: rel, moved: false }
  // A folder cannot be moved inside itself — `rename` would fail, but with EINVAL, which
  // reaches the person as noise rather than as the reason.
  if (dst.startsWith(src + sep)) fail(`Cannot move ${baseName(from)} into itself`)
  if (await exists(dst)) fail(`${rel} already exists — nothing was moved`)
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
  const dir = safeJoin(root, toDir)
  if (!(await stat(dir).then((s) => s.isDirectory(), () => false))) fail(`${toDir || '.'} is not a folder`)
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
  await stat(abs).catch(() => fail(`${rel || '.'} is no longer there`))
  return abs
}

/**
 * .gitignore 판정은 git에게 맡긴다.
 * check-ignore를 파일마다 부르면 프로세스가 폭발하므로, **디렉토리 단위로 한 번** 묻는다.
 * git이 없거나 저장소가 아니면 전부 not-ignored로 본다.
 */
async function ignoredIn(root: string, names: string[], dir: string): Promise<Set<string>> {
  if (names.length === 0) return new Set()
  /*
   * git speaks POSIX (#47). Its index stores `/` on every platform, and `check-ignore` reads and
   * prints paths that way — so the native separator `relative` just produced has to go before
   * the pathspec does, and what comes back needs no conversion at all. On macOS and Linux `sep`
   * is already `/` and this replacement does nothing, which is the whole reason it was missing.
   */
  const rel = relative(root, dir).replaceAll(sep, '/')
  const input = names.map((n) => wireJoin(rel, n)).join('\n')
  const stdout = await new Promise<string>((resolveOut) => {
    const child = spawn('git', ['check-ignore', '--stdin'], { cwd: root })
    let out = ''
    child.stdout.on('data', (d) => (out += String(d)))
    child.on('error', () => resolveOut(''))
    // check-ignore는 매치가 없으면 exit 1 — 오류가 아니다
    child.on('close', () => resolveOut(out))
    /*
     * A project does not have to be a git repository — the first-run screen says so in as
     * many words. When it isn't one, git prints `fatal: not a git repository` and exits
     * *before reading anything*, and the list we are writing lands on a closed pipe.
     *
     * The answer we want is already the right one: nothing is ignored, which is what the
     * `close` above resolves. The danger is the EPIPE itself. A stream 'error' with no
     * listener is an uncaught exception, and this runs inside the host — the process every
     * session in the app is living in. Opening the file tree in a plain directory would take
     * all of them down together.
     *
     * `child.on('error')` does not cover this. That one is about spawning; this one is the
     * pipe. The Codex client learned the same thing at its own stdin (client.ts).
     *
     * Whether it fires is a race between our write and git's exit, which is why this stood
     * for weeks: on a small directory the whole list fits in the pipe buffer and lands before
     * git is gone. Past the buffer — measured at 65,536 bytes here, about four thousand
     * files, or fewer with long names — the write blocks and the EPIPE is certain. CI hit it
     * on both Linux runners at a fraction of that size, on timing alone.
     */
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
  const set = new Set<string>()
  for (const line of stdout.split('\n')) {
    const name = wireBaseName(line.trim())
    if (name) set.add(name)
  }
  return set
}

export async function listDir(root: string, rel: string): Promise<FsEntry[]> {
  const dir = safeJoin(root, rel)
  const entries = await readdir(dir, { withFileTypes: true })
  const visible = entries.filter((e) => e.name !== '.git')
  const ignored = await ignoredIn(root, visible.map((e) => e.name), dir)

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
  const file = safeJoin(root, rel)
  const info = await stat(file)
  if (info.isDirectory()) throw Object.assign(new Error('Path is a directory'), { code: 'internal' })

  const buf = await readFile(file)
  // 널 바이트가 있으면 바이너리로 본다 (git과 같은 휴리스틱)
  const head = buf.subarray(0, 8000)
  if (head.includes(0)) return { text: '', truncated: false, binary: true, bytes: info.size }

  const truncated = buf.length > MAX_TEXT
  return {
    text: (truncated ? buf.subarray(0, MAX_TEXT) : buf).toString('utf8'),
    truncated,
    binary: false,
    bytes: info.size,
  }
}
