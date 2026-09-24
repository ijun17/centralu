import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, readlink, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { wireBaseName, wireJoin } from '@cc/protocol'
import { assertCreatePath, assertExistingPath, UnsafePathError } from './path-guard.js'

/**
 * 파일 트리·뷰어 서비스 (C-1).
 *
 * 원칙 둘:
 *   1. **한 단계만 읽는다** — 10k+ 파일 저장소에서도 첫 렌더가 빨라야 한다.
 *   2. **프로젝트 밖으로 나가지 않는다** — 경로 탈출(`../../etc/passwd`)을 막는다.
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

const MAX_TEXT = 2_000_000 // 2MB 넘으면 잘라 보여준다 (뷰어는 어차피 가상 스크롤)
const MAX_IMAGE_PREVIEW = 10_000_000 // 10MB — base64와 WebSocket 복사까지 감당할 상한
const READ_TEXT_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW

/** 뷰어가 `img`로 안전하게 표시할 래스터 형식. SVG는 텍스트 뷰어에 남긴다. */
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
  safeJoin(rootReal, relative(rootReal, canonical))
  const current = await lstat(canonical)
  if (current.isSymbolicLink() || current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new UnsafePathError('Path changed while resolving the file')
  }
  return canonical
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
  const dirInfo = await assertExistingPath(root, rel)
  if (!dirInfo.isDirectory()) fail(`${rel || '.'} is not a folder`)
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
  const file = await resolveExisting(root, rel)
  const pathInfo = await stat(file)
  if (!pathInfo.isFile()) fail('Path is not a regular file')

  const handle = await open(file, READ_TEXT_FLAGS)
  try {
    const info = await handle.stat()
    if (!info.isFile()) fail('Path is not a regular file')
    if (info.dev !== pathInfo.dev || info.ino !== pathInfo.ino) {
      throw new UnsafePathError('Path changed while opening the file')
    }

    const mime = imageMime(rel)
    if (mime && mime !== 'image/svg+xml' && info.size > MAX_IMAGE_PREVIEW) {
      return {
        text: '',
        truncated: false,
        binary: true,
        bytes: info.size,
        previewError: `Image is too large to preview (${(info.size / 1_000_000).toFixed(1)}MB; limit is ${MAX_IMAGE_PREVIEW / 1_000_000}MB)`,
      }
    }

    const readLimit = mime && mime !== 'image/svg+xml' ? MAX_IMAGE_PREVIEW : MAX_TEXT
    const buf = Buffer.allocUnsafe(Math.min(info.size, readLimit) + 1)
    let total = 0
    while (total < buf.length) {
      const { bytesRead } = await handle.read(buf, total, buf.length - total, total)
      if (bytesRead === 0) break
      total += bytesRead
    }
    const bytes = buf.subarray(0, total)

    if (mime) {
      /*
       * SVG는 이미지이면서 소스이기도 하다. raster처럼 text를 버리면 기존의 코드 읽기
       * 길을 잃고, text로만 두면 그림을 확인할 수 없다. 둘 다 돌려 뷰어가 Text/Preview를
       * 고르게 한다. `<img>`로만 그리므로 SVG를 앱 DOM에 주입하거나 실행하지 않는다.
       */
      if (mime === 'image/svg+xml') {
        const truncated = total > MAX_TEXT
        return {
          text: (truncated ? bytes.subarray(0, MAX_TEXT) : bytes).toString('utf8'),
          truncated,
          binary: false,
          bytes: info.size,
          image: { mime, data: bytes.toString('base64') },
        }
      }
      return { text: '', truncated: false, binary: true, bytes: info.size, image: { mime, data: bytes.toString('base64') } }
    }

    // 널 바이트가 있으면 바이너리로 본다 (git과 같은 휴리스틱)
    const head = bytes.subarray(0, 8000)
    if (head.includes(0)) return { text: '', truncated: false, binary: true, bytes: info.size }

    const truncated = total > MAX_TEXT
    return {
      text: (truncated ? bytes.subarray(0, MAX_TEXT) : bytes).toString('utf8'),
      truncated,
      binary: false,
      bytes: info.size,
    }
  } finally {
    await handle.close()
  }
}
/**
 * 파일·디렉토리를 통째로 옮긴다 — **가능하면 복사가 아니라 clone으로** (#76).
 *
 * APFS의 clonefile은 데이터 블록을 공유하는 참조를 만든다: 만드는 순간에는 바이트를
 * 하나도 쓰지 않고, 이후 어느 쪽이 고쳐도 그 부분만 갈라진다(copy-on-write). 워크트리
 * 격리가 깨지지 않는다는 뜻이다 — 심볼릭 링크와 결정적으로 다른 점이 이것이고, 그래서
 * node_modules를 링크하지 않고 clone한다 (한쪽 설치가 다른 쪽을 바꾸면 안 된다).
 *
 * 실측 (이 저장소, APFS):
 *   Rust target 8.5GB — clone 3.98초·디스크 10MB  vs  일반 복사 14.7초·디스크 8.5GB
 *   node_modules 637MB (pnpm 심볼릭 숲) — 4.18초 vs 4.44초 (차이 없음, 손해도 없음)
 * 이득은 **실제 바이트가 있는 것**에서 나온다. 작은 파일 더미에서는 비용이 메타데이터라
 * 어느 쪽이든 같다.
 *
 * clone이 안 되는 자리가 여럿이다 — 다른 파일시스템, 다른 볼륨, APFS 아님, macOS 아님.
 * 전부 같은 처리를 한다: **조용히 일반 복사로 돌아간다.** 여기서 실패를 던지면 복사
 * 하나 때문에 세션 생성이 막히는데, 그건 이 기능이 막으려던 바로 그 상황이다.
 */
export async function copyTree(src: string, dst: string): Promise<void> {
  if (process.platform === 'darwin') {
    const cloned = await new Promise<boolean>((done) => {
      // -c는 clonefile을 요구한다 (되면 쓰고 안 되면 실패한다 — 조용히 복사로 눕지 않는다)
      const p = spawn('/bin/cp', ['-Rc', src, dst], { stdio: 'ignore' })
      p.on('error', () => done(false))
      p.on('close', (code) => done(code === 0))
    })
    if (cloned) return
  }
  const { cpSync } = await import('node:fs')
  cpSync(src, dst, { recursive: true })
}

/**
 * 복사본이 놓일 자리를 만들고 그 절대 경로를 돌려준다 — **한 칸씩 가드에 물어보면서**.
 *
 * `mkdirSync(dirname(dst), { recursive: true })`는 도중의 심볼릭 링크를 말없이 따라간다.
 * 워크트리가 체크아웃한 추적 파일 중에 `logs -> /어딘가`가 있으면, `logs/.env`를 복사해
 * 달라는 요청이 남의 디렉토리에 사용자의 비밀을 쓴다. 통째로 만들지 않고 한 칸 만들 때마다
 * 물어보면 링크를 만나는 그 자리에서 멈춘다 — 밖에 빈 디렉토리 하나도 남기지 않는다.
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
 * 갓 복사된 나무에서 **워크트리 밖을 가리키는 심볼릭 링크만** 골라 지운다. 지운 것들을 돌려준다.
 *
 * 왜 링크를 남기는가: pnpm의 node_modules는 심볼릭 링크 숲이다(이 저장소 기준 1,368개).
 * 전부 따라가 실체로 펴면 용량이 폭발하고 순환 링크에 걸리며, 무엇보다 pnpm이 아는 모양이
 * 아니게 된다. 링크를 통째로 거절하면 이 기능의 제일 흔한 쓰임(node_modules 가져오기)이
 * 그냥 못 쓰게 된다. 그 링크들은 상대 경로로 자기 나무 안을 가리키므로, 워크트리의 같은
 * 자리에 놓이면 워크트리 안을 가리킨다 — 그대로가 맞는 답이다.
 *
 * 왜 밖을 가리키는 것만 지우는가: 그것이 에이전트의 눈에 자기 나무 안의 평범한 파일로
 * 보이는 창문이다(#95). 항목 하나가 이상하다고 나무 전체를 거절하면 사용자는 node_modules
 * 없는 작업대를 받는데, 그건 링크 하나 빠진 작업대보다 나쁘다. 그래서 창문만 닫고 남긴다.
 *
 * 읽기 자체는 싸다 — 위 숲 전체를 훑는 데 177ms(실측), 같은 나무를 복사하는 4초 옆에서.
 * 링크 안으로는 들어가지 않는다: 순환에 걸리지 않고, 같은 나무를 두 번 걷지도 않는다.
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
      continue // 파일 하나를 복사한 경우(ENOTDIR)와 그새 사라진 경우 — 둘 다 볼 것이 없다
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
   * 끊어진 링크는 realpath가 못 푼다. 그래도 글자만 보고 판단한다 — 지금 대상이 없다는 것은
   * 지금 못 읽는다는 뜻일 뿐이고, `~/.ssh/id_rsa`를 가리키는 링크는 그 파일이 생기는 순간
   * 창문이 된다.
   */
  const target = await realpath(link).catch(async () => resolve(dirname(link), await readlink(link)))
  return staysInside(rootReal, target)
}

function staysInside(rootReal: string, candidate: string): boolean {
  const rel = relative(rootReal, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}
