import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/**
 * git 조회·조작 (B-1).
 *
 * 문서 정정(G): 예전 주석은 "Tauri 4단계에서 Rust git2로 교체될 버릴 코드"라고 적었으나,
 * M1.5에서 Node 사이드카가 prod 경로가 되면서 그 계획은 **보류**됐다.
 * git2 이관은 측정으로 병목이 확인될 때까지 하지 않는다 (m2-plan 결정 3).
 * 포트 인터페이스가 같으므로 나중에 옮겨도 UI는 그대로다.
 */

/**
 * `denied`: 저장소이긴 한데 OS가 접근을 막았다 (서명되지 않은 앱이 ~/Desktop 같은 보호 폴더를 읽을 때).
 * '저장소 아님'과 반드시 구분한다 — 사용자가 할 일이 정반대다 (권한 부여 vs 아무것도 아님).
 * 배포 `.app` 실측에서 실제로 겪은 상황이다 (F-1).
 */
export type GitSummary = { isRepo: boolean; branch: string; changedFiles: number; denied?: boolean }
export type GitFileStatus = { path: string; staged: boolean; status: 'M' | 'A' | 'D' | 'R' | 'U' | '?' }
export type GitCommit = { sha: string; shortSha: string; subject: string; author: string; when: number; parents: string[] }
export type GitBranch = { name: string; current: boolean; remote: boolean; upstream?: string }

const OK = { timeout: 10_000, maxBuffer: 32 * 1024 * 1024 }

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, ...OK })
  return stdout
}

/** git 저장소가 아니면 조회 계열은 전부 빈 결과를 준다 — 호출자가 매번 방어하지 않도록 */
async function isRepo(cwd: string): Promise<boolean> {
  try {
    await git(cwd, ['rev-parse', '--git-dir'])
    return true
  } catch {
    return false
  }
}

export async function gitSummary(cwd: string): Promise<GitSummary> {
  try {
    const stdout = await git(cwd, ['status', '--porcelain=v2', '--branch'])
    let branch = '(detached)'
    let changed = 0
    for (const line of stdout.split('\n')) {
      if (line.startsWith('# branch.head ')) branch = line.slice('# branch.head '.length).trim()
      else if (line && !line.startsWith('#')) changed++
    }
    return { isRepo: true, branch, changedFiles: changed }
  } catch (e) {
    const msg = String((e as { stderr?: string; message?: string }).stderr ?? (e as Error).message ?? '')
    // macOS TCC: 서명되지 않은 앱이 보호 폴더를 읽으면 여기로 온다
    const denied = /Operation not permitted|EPERM|EACCES|permission denied/i.test(msg)
    return { isRepo: denied, branch: '', changedFiles: 0, denied }
  }
}

/** 변경 파일 목록. porcelain v2를 쓰는 이유: 이름에 공백·유니코드가 있어도 안전하다 */
export async function gitStatusFiles(cwd: string): Promise<GitFileStatus[]> {
  if (!(await isRepo(cwd))) return []
  const stdout = await git(cwd, ['status', '--porcelain=v2', '-z', '--untracked-files=all'])
  const out: GitFileStatus[] = []

  for (const entry of stdout.split('\0')) {
    if (!entry) continue
    if (entry.startsWith('1 ') || entry.startsWith('2 ')) {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const parts = entry.split(' ')
      const xy = parts[1] ?? '..'
      const path = parts.slice(8).join(' ')
      if (!path) continue
      const [x, y] = [xy[0] ?? '.', xy[1] ?? '.']
      if (x !== '.') out.push({ path, staged: true, status: mapStatus(x) })
      if (y !== '.') out.push({ path, staged: false, status: mapStatus(y) })
    } else if (entry.startsWith('? ')) {
      out.push({ path: entry.slice(2), staged: false, status: '?' })
    } else if (entry.startsWith('u ')) {
      const path = entry.split(' ').slice(10).join(' ')
      if (path) out.push({ path, staged: false, status: 'U' })
    }
  }
  return out
}

function mapStatus(c: string): GitFileStatus['status'] {
  if (c === 'A') return 'A'
  if (c === 'D') return 'D'
  if (c === 'R' || c === 'C') return 'R'
  if (c === 'U') return 'U'
  return 'M'
}

/** 파일 diff. 큰 diff는 앞부분만 — 화면은 어차피 가상 스크롤로 자른다 */
export async function gitDiff(
  cwd: string,
  path: string,
  opts: { staged?: boolean; maxBytes?: number } = {},
): Promise<{ diff: string; truncated: boolean; binary: boolean }> {
  if (!(await isRepo(cwd))) return { diff: '', truncated: false, binary: false }
  const args = ['diff', '--no-color', '--no-ext-diff']
  if (opts.staged) args.push('--cached')
  args.push('--', path)

  let stdout: string
  try {
    stdout = await git(cwd, args)
  } catch {
    return { diff: '', truncated: false, binary: false }
  }
  // 추적되지 않은 파일은 diff가 비어 있다 — 내용을 직접 보여준다
  if (!stdout.trim() && !opts.staged) {
    try {
      stdout = await git(cwd, ['diff', '--no-color', '--no-index', '/dev/null', path])
    } catch (e) {
      // --no-index는 차이가 있으면 exit 1이라 stdout이 error에 실려 온다
      stdout = String((e as { stdout?: string }).stdout ?? '')
    }
  }

  const binary = /^Binary files /m.test(stdout) || stdout.includes('\0')
  const max = opts.maxBytes ?? 400_000
  const truncated = stdout.length > max
  return { diff: binary ? '' : truncated ? stdout.slice(0, max) : stdout, truncated, binary }
}

export async function gitLog(cwd: string, limit = 50): Promise<GitCommit[]> {
  if (!(await isRepo(cwd))) return []
  const SEP = '\x1f'
  const stdout = await git(cwd, [
    'log',
    `-n${limit}`,
    `--pretty=format:%H${SEP}%h${SEP}%s${SEP}%an${SEP}%at${SEP}%P`,
  ])
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha = '', shortSha = '', subject = '', author = '', when = '0', parents = ''] = line.split(SEP)
      return { sha, shortSha, subject, author, when: Number(when) * 1000, parents: parents.split(' ').filter(Boolean) }
    })
}

export async function gitCommitDetail(cwd: string, sha: string): Promise<{ files: string[]; diff: string; truncated: boolean }> {
  if (!(await isRepo(cwd))) return { files: [], diff: '', truncated: false }
  const files = (await git(cwd, ['show', '--pretty=format:', '--name-only', sha])).split('\n').filter(Boolean)
  const raw = await git(cwd, ['show', '--no-color', '--pretty=format:', sha])
  const max = 400_000
  return { files, diff: raw.slice(0, max), truncated: raw.length > max }
}

export async function gitBranches(cwd: string): Promise<GitBranch[]> {
  if (!(await isRepo(cwd))) return []
  const stdout = await git(cwd, [
    'branch',
    '--all',
    '--format=%(refname:short)\x1f%(HEAD)\x1f%(upstream:short)',
  ])
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name = '', head = '', upstream = ''] = line.split('\x1f')
      return {
        name,
        current: head.trim() === '*',
        remote: name.startsWith('remotes/') || name.includes('/'),
        upstream: upstream || undefined,
      }
    })
    .filter((b) => !b.name.endsWith('/HEAD'))
}

/**
 * 체크아웃. 더티 상태여도 **막지 않고** 결과를 먼저 보여준다 (제품 철학: 막지 말고 보이게).
 * dryRun이면 무엇이 충돌하는지만 알려준다.
 */
export async function gitCheckout(
  cwd: string,
  branch: string,
  opts: { dryRun?: boolean } = {},
): Promise<{ ok: boolean; conflicts: string[]; message?: string }> {
  if (!(await isRepo(cwd))) return { ok: false, conflicts: [], message: 'git 저장소가 아닙니다' }
  if (opts.dryRun) {
    const dirty = (await gitStatusFiles(cwd)).filter((f) => f.status !== '?').map((f) => f.path)
    return { ok: dirty.length === 0, conflicts: [...new Set(dirty)] }
  }
  try {
    await git(cwd, ['checkout', branch.replace(/^remotes\/[^/]+\//, '')])
    return { ok: true, conflicts: [] }
  } catch (e) {
    return { ok: false, conflicts: [], message: cleanGitError(e) }
  }
}

export async function gitStage(cwd: string, paths: string[], unstage = false): Promise<void> {
  if (paths.length === 0) return
  await git(cwd, unstage ? ['restore', '--staged', '--', ...paths] : ['add', '--', ...paths])
}

export async function gitCommit(cwd: string, message: string): Promise<{ ok: boolean; message?: string }> {
  try {
    await git(cwd, ['commit', '-m', message])
    return { ok: true }
  } catch (e) {
    return { ok: false, message: cleanGitError(e) }
  }
}

/** 푸시 (product-spec §8 M2의 v1.5 확정분). 업스트림이 없으면 만들어 준다 */
export async function gitPush(cwd: string): Promise<{ ok: boolean; message?: string }> {
  try {
    const branches = await gitBranches(cwd)
    const current = branches.find((b) => b.current)
    if (!current) return { ok: false, message: '현재 브랜치를 알 수 없습니다 (detached HEAD)' }
    const args = current.upstream ? ['push'] : ['push', '--set-upstream', 'origin', current.name]
    await git(cwd, args)
    return { ok: true }
  } catch (e) {
    return { ok: false, message: cleanGitError(e) }
  }
}

/** git의 원문 오류를 그대로 보여준다 — 요약하면 사용자가 다음 행동을 못 정한다 */
function cleanGitError(e: unknown): string {
  const err = e as { stderr?: string; message?: string }
  return (err.stderr || err.message || '알 수 없는 오류').trim().split('\n').slice(0, 6).join('\n')
}
