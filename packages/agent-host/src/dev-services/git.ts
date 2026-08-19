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

  const tokens = stdout.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i]!
    if (!entry) continue
    if (entry.startsWith('1 ') || entry.startsWith('2 ')) {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>␀<origPath>
      const parts = entry.split(' ')
      const xy = parts[1] ?? '..'
      /*
       * 이름 바뀜(2)은 경로 앞에 필드가 하나 더 있다(<X><score>, 예: R100).
       * 1과 같은 자리(8)로 읽으면 경로가 "R100 새이름"이 되어 — 존재하지 않는 파일이라 —
       * 스테이징이 조용히 실패했다. -z에서는 원래 이름이 **다음 NUL 토큰**으로
       * 따라오므로, 그 토큰을 항목으로 오해하지 않게 건너뛴다.
       */
      const rename = entry.startsWith('2 ')
      const path = parts.slice(rename ? 9 : 8).join(' ')
      if (rename) i++
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
    /*
     * **자식이 부모보다 먼저 오도록** 정렬을 못박는다.
     *
     * 기본 정렬은 커밋 시각이라, rebase·cherry-pick으로 시각이 뒤집힌 커밋은
     * 부모가 자식보다 먼저 나올 수 있다. 그래프 배치(core git/graph.ts)는 그런 입력에서
     * 위로 올라가는 선을 그릴 수 없어 간선을 빼는데, 여기서 순서를 보장하면
     * 애초에 뺄 간선이 생기지 않는다 (유령 레인의 원인이었다).
     */
    '--topo-order',
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
  if (!(await isRepo(cwd))) return { ok: false, conflicts: [], message: 'Not a git repository' }
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
    if (!current) return { ok: false, message: 'Current branch is unknown (detached HEAD)' }
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
  return (err.stderr || err.message || 'Unknown error').trim().split('\n').slice(0, 6).join('\n')
}

/*
 * ── 워크트리 (FR-2의 후순위 옵션) ─────────────────────────────────────
 *
 * **원본 디렉토리에서 직접 작업하는 것이 기본이다.** 워크트리는 원하는 사람만 켜는 격리 수단이고,
 * 여기 있는 함수들은 그 체크박스 하나를 위해 존재한다.
 *
 * 위치는 **저장소 밖**이다 (`~/.centralu/worktrees/…`). 저장소 안에 두면 `.gitignore`에
 * 줄을 넣어야 하고 — 사용자 파일을 우리가 고치는 것이다 — 안 넣으면 `git status`가 지저분해진다.
 */

export type Worktree = { path: string; branch: string }

/**
 * 새 워크트리와 브랜치를 만든다. 브랜치는 **지금 HEAD에서** 갈라진다.
 *
 * 실패를 삼키지 않는다: 워크트리를 못 만들었는데 세션이 원본 디렉토리에서 조용히 돌면
 * 사용자는 격리된 줄 알고 있다 — 그게 이 기능에서 가장 나쁜 결말이다.
 */
export async function gitWorktreeAdd(repoCwd: string, path: string, branch: string): Promise<Worktree> {
  await git(repoCwd, ['worktree', 'add', '-b', branch, path])
  return { path, branch }
}

/**
 * 워크트리를 지운다. `force`는 커밋 안 된 변경까지 버린다.
 *
 * 지우기 전에 `gitWorktreeDirty`로 물어보는 것은 **호출자의 몫**이다 — 여기서 임의로
 * 판단하면 "조용히 지웠다"가 된다. 에이전트가 몇 시간 작업한 결과가 들어 있을 수 있는 곳이다.
 */
export async function gitWorktreeRemove(repoCwd: string, path: string, force = false): Promise<void> {
  await git(repoCwd, ['worktree', 'remove', ...(force ? ['--force'] : []), path])
}

/** 커밋되지 않은 변경이 남아 있는가 — 지워도 되는지 묻기 위한 것 */
export async function gitWorktreeDirty(path: string): Promise<{ dirty: boolean; changedFiles: number }> {
  const summary = await gitSummary(path)
  return { dirty: summary.changedFiles > 0, changedFiles: summary.changedFiles }
}

/**
 * 등록된 워크트리 목록. 사람이 Finder에서 지워버린 것을 걸러내는 데 쓴다
 * (git은 그런 것도 목록에 남겨둔다 — `prune`이 필요한 상태다).
 */
export async function gitWorktreeList(repoCwd: string): Promise<Worktree[]> {
  if (!(await isRepo(repoCwd))) return []
  const out = await git(repoCwd, ['worktree', 'list', '--porcelain'])
  const list: Worktree[] = []
  let path = ''
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length).trim()
    else if (line.startsWith('branch ') && path) {
      list.push({ path, branch: line.slice('branch refs/heads/'.length).trim() })
      path = ''
    }
  }
  return list
}

/** 사라진 워크트리의 등록만 정리한다 (디렉토리를 지우지는 않는다) */
export async function gitWorktreePrune(repoCwd: string): Promise<void> {
  await git(repoCwd, ['worktree', 'prune'])
}
