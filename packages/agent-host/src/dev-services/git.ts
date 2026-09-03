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

/** 지금 HEAD — 커밋 귀속(#50)에서 도구 출력이 잘려 해시를 못 주웠을 때의 대안 */
export async function gitHeadSha(cwd: string): Promise<string | null> {
  if (!(await isRepo(cwd))) return null
  try {
    return (await git(cwd, ['rev-parse', 'HEAD'])).trim() || null
  } catch {
    return null // 커밋이 하나도 없는 저장소 — 귀속할 것도 없다
  }
}

/**
 * 이 ref가 가리키는 sha — 없으면 null (#76).
 *
 * 존재 확인과 sha 읽기를 한 번에 한다. 줄기 브랜치가 지워졌는지 묻는 자리와 그
 * 브랜치의 sha를 기록하는 자리가 같은 질문을 두 번 하지 않게 하려는 것이다.
 */
export async function gitRevParse(cwd: string, ref: string): Promise<string | null> {
  try {
    return (await git(cwd, ['rev-parse', '--verify', `${ref}^{commit}`])).trim() || null
  } catch {
    return null
  }
}

/**
 * git이 무시하는 것들 — 새 워크트리에 **없을** 파일 목록 (#76).
 *
 * 새 워크트리에 빠지는 게 정확히 이것들이라(추적 파일은 git이 가져다 준다), "무엇을
 * 복사할까"의 후보는 이 목록이 전부다. 그래서 앱이 고르지 않고 **짚어만 준다** —
 * 여기서 "전부 복사"를 기본값으로 삼으면 이 저장소만 해도 node_modules 637MB와
 * Rust target 8.5GB가 딸려 온다.
 *
 * `--directory`가 핵심이다: 통째로 무시되는 디렉토리는 그 안을 펼치지 않고 한 줄로
 * 접어 준다 (node_modules/ 안의 파일 수만 줄이 되면 목록이 아니라 소음이다).
 *
 * .DS_Store만 빼낸다. macOS 저장소마다 수십 개씩 나오는데 옮길 이유가 하나도 없고,
 * 목록의 맨 앞자리를 늘 차지해서 정작 봐야 할 .env를 밀어낸다.
 */
export async function gitIgnoredEntries(cwd: string, limit = 50): Promise<{ path: string; bytes: number | null }[]> {
  if (!(await isRepo(cwd))) return []
  let raw: string
  try {
    raw = await git(cwd, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'])
  } catch {
    return []
  }
  const paths = raw
    .split('\0')
    .filter(Boolean)
    .filter((p) => !p.endsWith('.DS_Store'))
  if (paths.length === 0) return []

  /*
   * 크기를 함께 준다 — 이 목록에서 사람이 실제로 하는 판단이 "이건 너무 크다"라서다.
   * du 한 번에 전부 물어보고, 오래 걸리면 크기 없이 목록만 준다 (크기는 거들 뿐이라
   * 이것 때문에 창이 멈추면 주객이 바뀐다).
   */
  const sizes = new Map<string, number>()
  try {
    const out = await new Promise<string>((resolve, reject) => {
      execFile('du', ['-sk', ...paths.slice(0, limit)], { cwd, timeout: 5000, maxBuffer: 1 << 20 }, (err, stdout) =>
        // du는 읽을 수 없는 항목 하나에도 non-zero로 끝난다 — 나온 만큼은 쓴다
        stdout ? resolve(stdout) : reject(err),
      )
    })
    for (const line of out.split('\n')) {
      const [kb, ...rest] = line.split('\t')
      const p = rest.join('\t').trim()
      if (p && kb) sizes.set(p.replace(/\/$/, ''), Number(kb) * 1024)
    }
  } catch {
    // 크기 없이 간다
  }

  return paths
    .slice(0, limit)
    .map((p) => ({ path: p, bytes: sizes.get(p.replace(/\/$/, '')) ?? null }))
    .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))
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

export type Worktree = { path: string; branch: string; base?: string }

/**
 * 새 워크트리와 브랜치를 만든다. 브랜치는 **지금 HEAD에서** 갈라진다.
 *
 * 실패를 삼키지 않는다: 워크트리를 못 만들었는데 세션이 원본 디렉토리에서 조용히 돌면
 * 사용자는 격리된 줄 알고 있다 — 그게 이 기능에서 가장 나쁜 결말이다.
 */
/**
 * 워크트리를 하나 만든다.
 *
 * `from`을 주면 **그 줄기에서** 갈라진다 (#76). 안 주면 예전처럼 루트의 HEAD에서
 * 갈라지는데, 그건 사람이 루트에서 브랜치를 바꿔 둔 순간 의미가 조용히 달라지는 기준이다 —
 * 매니저가 줄기를 쥐고 있으면 "어디서 갈라지는가"의 답이 하나로 고정된다.
 *
 * 없는 줄기를 주면 git이 거절한다. 우리가 미리 검사해서 조용히 HEAD로 물러나지 않는
 * 이유: 지정한 줄기가 아닌 데서 갈라진 워크트리는 나중에 "왜 병합이 안 잡히지"로 돌아온다.
 */
export async function gitWorktreeAdd(
  repoCwd: string,
  path: string,
  branch: string,
  from?: string,
): Promise<Worktree> {
  await git(repoCwd, ['worktree', 'add', '-b', branch, path, ...(from ? [from] : [])])
  return { path, branch }
}

/**
 * 이 브랜치의 작업이 **줄기에 다 들어갔는가** (#69).
 *
 * 두 판정의 합이다:
 *   1. 브랜치 끝이 생성 시점(base)에서 움직였는가 — 안 움직였으면 "아직 일 안 함"이지
 *      "병합됨"이 아니다. 갓 만든 브랜치는 줄기의 조상이라 is-ancestor만 보면
 *      만들자마자 merged로 읽힌다 (이 함정 때문에 base를 기록한다).
 *   2. 브랜치가 줄기의 조상인가 (`merge-base --is-ancestor`) — 보통 병합과 FF 병합을 잡는다.
 *
 * **줄기가 무엇인지는 부르는 쪽이 말한다** (#76). 예전에는 언제나 루트의 HEAD였는데,
 * 그건 사람이 루트에서 브랜치를 갈아탄 순간 뜻이 조용히 바뀌는 기준이었다: main에
 * 병합했는데 루트가 딴 브랜치에 있으면 안 잡히고, 반대로 루트의 HEAD가 우연히 그
 * 브랜치를 품고 있으면 병합된 적 없는 브랜치가 merged로 읽혔다. 매니저가 줄기를 쥐면
 * (worktreeManager.baseBranch) 이 질문의 답이 하나로 고정된다. 줄기가 없으면 HEAD로
 * 물러난다 — 매니저를 만들기 전에 생긴 워크트리들이 그 경우다.
 *
 * **못 잡는 것 (실측, 2026-08-29):** 스쿼시 병합은 로컬에서 감지 불가다 — is-ancestor
 * NO, `branch --merged` NO, `git cherry`조차 미병합으로 답했다. 리베이스 병합도 sha가
 * 바뀌면 놓친다. 그런 브랜치는 자동 표식 없이 남고, 사람이 지우는 길(삭제 대화)은
 * 언제나 열려 있다 — 놓침의 비용은 배지 하나지, 데이터가 아니다.
 */
export async function gitBranchMerged(
  projectCwd: string,
  branch: string,
  baseSha: string,
  trunk = 'HEAD',
): Promise<boolean> {
  try {
    const tip = (await git(projectCwd, ['rev-parse', '--verify', `refs/heads/${branch}`])).trim()
    if (!tip || tip === baseSha) return false
    await git(projectCwd, ['merge-base', '--is-ancestor', tip, trunk])
    return true
  } catch {
    return false // 브랜치가 없거나 조상이 아니다 — 어느 쪽이든 "병합됨"은 아니다
  }
}

export type BranchPr = {
  number: number
  state: 'open' | 'merged' | 'closed'
  url: string
  /**
   * PR 머리의 커밋 sha. 하드 게이트(#76)의 "최신화" 판정 근거다: 로컬 팁이 이것과
   * 같아야 "브랜치의 전부가 그 PR로 들어갔다"가 증명된다 — 스쿼시 병합 뒤 얹힌
   * 새 커밋은 is-ancestor로도 PR 상태로도 안 보이는 유일한 손실 경로라서다.
   */
  headOid?: string
}

/**
 * 이 브랜치의 풀 리퀘스트 상태 — **gh에게 묻는다** (#76 stage 3).
 *
 * gitBranchMerged가 못 보는 것(스쿼시·리베이스 병합 — GitHub PR의 지배적 결말)을
 * PR 상태는 정확히 안다: MERGED는 추론이 아니라 서버가 기록한 사실이다.
 *
 * 조용히 물러나는 함수다. 실패의 두 갈래를 구분해서 돌려준다:
 *   - `'unavailable'` — gh 자체가 없다(ENOENT). 다시 물어도 답이 안 변하니
 *     호출자는 이 프로세스에서 그만 묻는 게 맞다.
 *   - `null` — 지금은 모른다(PR 없음·오프라인·GitHub 저장소 아님·인증 안 됨).
 *     다음에 물으면 답이 있을 수 있다.
 * 어느 쪽도 던지지 않는다 — 이 신호는 배지 하나의 근거이지 세션 목록의 전제가 아니다.
 */
export async function gitBranchPr(projectCwd: string, branch: string): Promise<BranchPr | 'unavailable' | null> {
  try {
    const { stdout } = await exec('gh', ['pr', 'view', branch, '--json', 'number,state,url,headRefOid'], { cwd: projectCwd, ...OK })
    const j = JSON.parse(stdout) as { number?: unknown; state?: unknown; url?: unknown; headRefOid?: unknown }
    if (typeof j.number !== 'number' || typeof j.state !== 'string' || typeof j.url !== 'string') return null
    return {
      number: j.number,
      state: j.state === 'MERGED' ? 'merged' : j.state === 'CLOSED' ? 'closed' : 'open',
      url: j.url,
      ...(typeof j.headRefOid === 'string' && j.headRefOid ? { headOid: j.headRefOid } : {}),
    }
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'unavailable' : null
  }
}

/**
 * 브랜치 이름이 될 수 있는가 (#69) — 판정은 git 자신에게 시킨다.
 *
 * ref 이름 규칙(잠금 접미사, 연속 점, 제어 문자, `@{`…)을 우리가 다시 적으면
 * git이 규칙을 고칠 때 우리 것만 낡는다. `check-ref-format --branch`가 그 판정의
 * 원본이고, 종료 코드가 곧 답이다. 저장소가 필요 없는 명령이라 cwd는 아무 데나 된다.
 */
export async function gitValidBranchName(name: string): Promise<boolean> {
  try {
    await git(process.cwd(), ['check-ref-format', '--branch', name])
    return true
  } catch {
    return false
  }
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

/**
 * 브랜치 ref를 지운다 (#76 하드 게이트 전용).
 *
 * `-D`인 이유: `-d`의 자체 안전판(병합 확인)은 스쿼시 병합을 못 본다 — 정확히 그
 * 사각지대를 메우려고 게이트가 있는 것이라, git의 확인 대신 **호출자의 증명**이
 * 안전판이다. 게이트를 통과하지 않은 코드가 이 함수를 부르면 안 된다.
 * 지워도 커밋은 reflog에 남는다 — 호출자가 팁 sha를 로그로 남겨 복구 길을 표시한다.
 */
export async function gitBranchDelete(repoCwd: string, branch: string): Promise<void> {
  await git(repoCwd, ['branch', '-D', branch])
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
