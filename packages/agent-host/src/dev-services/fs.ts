import { spawn } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

/**
 * 파일 트리·뷰어 서비스 (C-1).
 *
 * 원칙 둘:
 *   1. **한 단계만 읽는다** — 10k+ 파일 저장소에서도 첫 렌더가 빨라야 한다.
 *   2. **프로젝트 밖으로 나가지 않는다** — 경로 탈출(`../../etc/passwd`)을 막는다.
 */

export type FsEntry = { name: string; path: string; isDir: boolean; ignored: boolean }
export type FsFile = { text: string; truncated: boolean; binary: boolean; bytes: number }

const MAX_TEXT = 2_000_000 // 2MB 넘으면 잘라 보여준다 (뷰어는 어차피 가상 스크롤)

/** 프로젝트 루트를 벗어나는 경로를 막는다 */
function safeJoin(root: string, rel: string): string {
  const target = resolve(root, rel || '.')
  const rootResolved = resolve(root)
  if (target !== rootResolved && !target.startsWith(rootResolved + sep)) {
    throw Object.assign(new Error('Path is outside the project'), { code: 'internal' })
  }
  return target
}

/**
 * .gitignore 판정은 git에게 맡긴다.
 * check-ignore를 파일마다 부르면 프로세스가 폭발하므로, **디렉토리 단위로 한 번** 묻는다.
 * git이 없거나 저장소가 아니면 전부 not-ignored로 본다.
 */
async function ignoredIn(root: string, names: string[], dir: string): Promise<Set<string>> {
  if (names.length === 0) return new Set()
  const rel = relative(root, dir)
  const input = names.map((n) => (rel ? join(rel, n) : n)).join('\n')
  const stdout = await new Promise<string>((resolveOut) => {
    const child = spawn('git', ['check-ignore', '--stdin'], { cwd: root })
    let out = ''
    child.stdout.on('data', (d) => (out += String(d)))
    child.on('error', () => resolveOut(''))
    // check-ignore는 매치가 없으면 exit 1 — 오류가 아니다
    child.on('close', () => resolveOut(out))
    child.stdin.end(input)
  })
  const set = new Set<string>()
  for (const line of stdout.split('\n')) {
    const name = line.trim().split('/').pop()
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
      path: rel ? `${rel}/${e.name}` : e.name,
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
