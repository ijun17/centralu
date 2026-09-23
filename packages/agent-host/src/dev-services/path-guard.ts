import { lstatSync, realpathSync, statSync, type Stats } from 'node:fs'
import { lstat, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export class UnsafePathError extends Error {
  override readonly name = 'UnsafePathError'
  readonly code = 'internal'

  constructor(message: string) {
    super(message)
  }
}

export class MissingPathError extends Error {
  override readonly name = 'MissingPathError'
  readonly code = 'internal'

  constructor(readonly rel: string) {
    super(`${rel || '.'} is no longer there`)
  }
}

export type CreatePathState = { readonly exists: boolean }

type WalkMode = 'existing' | 'create-leaf'

type WalkResult = { readonly stats: Stats; readonly exists: true } | { readonly exists: false }

export function isMissingPathError(error: unknown): error is MissingPathError {
  return error instanceof MissingPathError
}

export async function assertExistingPath(root: string, rel: string): Promise<Stats> {
  const result = await walkPath(root, rel, 'existing')
  if (!result.exists) throw new MissingPathError(rel)
  return result.stats
}

export async function assertCreatePath(root: string, rel: string): Promise<CreatePathState> {
  const result = await walkPath(root, rel, 'create-leaf')
  return { exists: result.exists }
}

export function assertExistingPathSync(root: string, rel: string): Stats {
  const result = walkPathSync(root, rel, 'existing')
  if (!result.exists) throw new MissingPathError(rel)
  return result.stats
}

async function walkPath(root: string, rel: string, mode: WalkMode): Promise<WalkResult> {
  const rootReal = await realpath(root)
  let current = rootReal
  const parts = pathParts(root, rel)
  if (parts.length === 0) return { stats: await stat(rootReal), exists: true }

  for (const [index, part] of parts.entries()) {
    if (part === '..') {
      current = checkedParent(rootReal, current)
      continue
    }

    const candidate = join(current, part)
    assertInside(rootReal, candidate)
    let stats: Stats
    try {
      const linkStats = await lstat(candidate)
      if (linkStats.isSymbolicLink()) {
        const target = await realpath(candidate).catch((error: NodeJS.ErrnoException) => {
          if (isMissingFsPath(error)) throw new MissingPathError(rel)
          throw error
        })
        assertInside(rootReal, target)
        stats = await stat(target)
        current = target
      } else {
        stats = linkStats
        current = candidate
      }
    } catch (error) {
      if (isMissingFsPath(error) && mode === 'create-leaf' && index === parts.length - 1) return { exists: false }
      if (isMissingFsPath(error)) throw new MissingPathError(rel)
      throw error
    }
    if (index < parts.length - 1 && !stats.isDirectory()) throw new UnsafePathError(`${rel || '.'} is not a folder`)
    if (index === parts.length - 1) return { stats, exists: true }
  }

  return { stats: await stat(current), exists: true }
}

function walkPathSync(root: string, rel: string, mode: WalkMode): WalkResult {
  const rootReal = realpathSync(root)
  let current = rootReal
  const parts = pathParts(root, rel)
  if (parts.length === 0) return { stats: statSync(rootReal), exists: true }

  for (const [index, part] of parts.entries()) {
    if (part === '..') {
      current = checkedParent(rootReal, current)
      continue
    }

    const candidate = join(current, part)
    assertInside(rootReal, candidate)
    let stats: Stats
    try {
      const linkStats = lstatSync(candidate)
      if (linkStats.isSymbolicLink()) {
        const target = realpathSync(candidate)
        assertInside(rootReal, target)
        stats = statSync(target)
        current = target
      } else {
        stats = linkStats
        current = candidate
      }
    } catch (error) {
      if (isMissingFsPath(error) && mode === 'create-leaf' && index === parts.length - 1) return { exists: false }
      if (isMissingFsPath(error)) throw new MissingPathError(rel)
      throw error
    }
    if (index < parts.length - 1 && !stats.isDirectory()) throw new UnsafePathError(`${rel || '.'} is not a folder`)
    if (index === parts.length - 1) return { stats, exists: true }
  }

  return { stats: statSync(current), exists: true }
}

/**
 * 걸어갈 조각들. **`..`를 먼저 접는다 — 이것이 이 함수의 요점이다.**
 *
 * 예전에는 절대 경로일 때만 접고, 상대 경로는 받은 모양 그대로 쪼갰다. 그래서 `..`가
 * 조각으로 남았고, 걷는 도중 심볼릭 링크를 따라간 **뒤에** 부모로 올라갔다. 반면 실제
 * syscall이 쓰는 경로는 `safeJoin`이 `resolve()`로 **먼저** 접어서 만든다. 링크의 대상이
 * 링크 자신보다 깊으면 두 경로가 갈라지고, 가드는 안쪽을 보고 통과시키는데 syscall은
 * 바깥으로 나갔다.
 *
 *   root/link -> root/sub/deep      링크의 대상이 자신보다 깊다
 *   root/sub/evil/                  가드가 걸어가 보는 미끼
 *   root/evil -> /어디든            실제로 열리는 곳
 *
 * `link/../evil`을 주면 가드는 `root/sub/evil`을 확인하고 허락했고, `safeJoin`은
 * `root/evil`을 돌려줬다. 실측으로 프로젝트 밖 디렉토리 나열, 임의 위치 파일 생성,
 * 프로젝트 파일 반출, 바깥 디렉토리 감시가 전부 가능했다.
 *
 * 그래서 규칙을 한 줄로 못박는다: **검사한 문자열이 곧 사용되는 문자열이어야 한다.**
 * `safeJoin`과 같은 `resolve()`를 쓰는 이유가 그것이다.
 *
 * 접은 뒤에도 `..`가 남는 경우가 있다. 루트 밖으로 나가는 경로(`../바깥`)가 그렇고,
 * 그때는 걷는 쪽의 `checkedParent`가 거부한다.
 */
function pathParts(root: string, rel: string): readonly string[] {
  const rootResolved = resolve(root)
  const path = relative(rootResolved, resolve(rootResolved, rel || '.'))
  const separator = process.platform === 'win32' ? /[/\\]+/ : '/'
  return path.split(separator).filter((part) => part.length > 0 && part !== '.')
}

function checkedParent(rootReal: string, current: string): string {
  const parent = dirname(current)
  assertInside(rootReal, parent)
  return parent
}

function assertInside(rootReal: string, candidate: string): void {
  const rel = relative(rootReal, candidate)
  if (rel === '') return
  if (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return
  throw new UnsafePathError('Path is outside the project')
}

function isMissingFsPath(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}
