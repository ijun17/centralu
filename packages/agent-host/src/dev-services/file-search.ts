import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/**
 * `@` 자동완성용 파일 검색.
 *
 * **왜 우리가 만드나:** Claude SDK는 파일 제안을 공개 API로 열어두지 않았고,
 * Codex의 fuzzyFileSearch는 app-server를 띄워야 한다 — 글자마다 프로세스를 띄우는 건
 * 타이핑 응답으로 쓸 수 없다. 게다가 도구마다 결과가 다르면 같은 프로젝트인데
 * 세션에 따라 다른 파일이 뜨는 셈이라 더 헷갈린다. 그래서 한 벌로 통일한다.
 *
 * 목록은 git에게 받는다(`ls-files`) — .gitignore를 그대로 따르므로
 * node_modules나 빌드 산출물이 섞이지 않는다. 저장소가 아니면 얕게 걷는다.
 */

/** 한 번에 들고 있을 최대 파일 수. 이보다 큰 저장소는 앞쪽만 본다 */
const MAX_FILES = 20_000
/** 목록을 다시 읽기까지의 시간. 타이핑 중에는 다시 읽지 않는다 */
const TTL_MS = 15_000
/** 저장소가 아닐 때 걷는 최대 깊이 */
const WALK_DEPTH = 6

type Index = { files: string[]; at: number }
const cache = new Map<string, Index>()

/** 테스트·프로젝트 변경 시 색인을 버린다 */
export function invalidateFileIndex(root?: string): void {
  if (root) cache.delete(root)
  else cache.clear()
}

async function gitFiles(root: string): Promise<string[] | null> {
  try {
    // 추적 중인 파일 + 무시되지 않은 새 파일 = 사람이 열 만한 것 전부
    const { stdout } = await exec('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: root,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 10_000,
    })
    const files = stdout.split('\n').filter(Boolean)
    return files.length > 0 ? files.slice(0, MAX_FILES) : null
  } catch {
    return null
  }
}

/** 저장소가 아닐 때의 폴백. 흔한 잡음 디렉토리만 건너뛴다 */
const SKIP = new Set(['.git', 'node_modules', 'dist', 'build', 'target', '.next', '.venv', '__pycache__'])

async function walk(root: string): Promise<string[]> {
  const out: string[] = []
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }]
  while (queue.length > 0 && out.length < MAX_FILES) {
    const { dir, depth } = queue.shift()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.env') continue
      if (e.isDirectory()) {
        if (SKIP.has(e.name) || depth >= WALK_DEPTH) continue
        queue.push({ dir: join(dir, e.name), depth: depth + 1 })
      } else {
        out.push(relative(root, join(dir, e.name)))
        if (out.length >= MAX_FILES) break
      }
    }
  }
  return out
}

async function indexOf(root: string): Promise<string[]> {
  const hit = cache.get(root)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.files
  const files = (await gitFiles(root)) ?? (await walk(root))
  cache.set(root, { files, at: Date.now() })
  return files
}

export type FileHit = { path: string; name: string }

/**
 * 퍼지 매칭 점수. 높을수록 위에 온다. 매치가 없으면 null.
 *
 * 사람이 `@ses`라고 칠 때 찾는 건 대개 `SessionView.tsx`이지
 * `packages/…/s…e…s` 처럼 경로 여기저기 흩어진 글자가 아니다.
 * 그래서 **파일 이름에서의 매치를 경로 매치보다 훨씬 높게** 친다.
 */
export function score(path: string, query: string): number | null {
  if (!query) return 0
  const lowerPath = path.toLowerCase()
  const q = query.toLowerCase()
  const name = path.slice(path.lastIndexOf('/') + 1)
  const lowerName = name.toLowerCase()

  // 1) 이름이 그대로 들어있으면 최상위. 앞에서 시작할수록 더 높다
  const inName = lowerName.indexOf(q)
  if (inName >= 0) return 1000 - inName * 10 - depthPenalty(path)

  // 2) 경로 어딘가에 그대로 들어있으면 그다음
  const inPath = lowerPath.indexOf(q)
  if (inPath >= 0) return 600 - Math.min(inPath, 40) - depthPenalty(path)

  // 3) 이름에 흩어져 있어도(부분 수열) 받아준다 — 연속될수록 높게
  const sub = subsequenceScore(lowerName, q)
  if (sub !== null) return 400 + sub - depthPenalty(path)

  const subPath = subsequenceScore(lowerPath, q)
  if (subPath !== null) return 100 + subPath - depthPenalty(path)

  return null
}

/** 깊은 경로는 살짝 뒤로 — 대개 얕은 쪽이 찾던 것이다 */
function depthPenalty(path: string): number {
  let slashes = 0
  for (const c of path) if (c === '/') slashes++
  return Math.min(slashes * 2, 30)
}

function subsequenceScore(haystack: string, needle: string): number | null {
  let hi = 0
  let streak = 0
  let best = 0
  for (const ch of needle) {
    const found = haystack.indexOf(ch, hi)
    if (found === -1) return null
    streak = found === hi ? streak + 1 : 1
    best += streak
    hi = found + 1
  }
  return Math.min(best * 4, 150)
}

export async function searchFiles(root: string, query: string, limit = 20): Promise<FileHit[]> {
  const files = await indexOf(root)
  const q = query.trim()

  // 빈 질의는 '최근 느낌'을 낼 수 없으니 얕은 것부터 보여준다
  const scored: { path: string; s: number }[] = []
  for (const path of files) {
    const s = score(path, q)
    if (s !== null) scored.push({ path, s })
  }
  scored.sort((a, b) => (b.s === a.s ? a.path.length - b.path.length : b.s - a.s))
  return scored.slice(0, limit).map(({ path }) => ({ path, name: path.slice(path.lastIndexOf('/') + 1) }))
}
