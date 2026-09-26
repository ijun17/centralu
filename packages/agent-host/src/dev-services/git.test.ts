import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitBranches, gitCheckout, gitCommit, gitCommitDetail, gitDiff, gitStage, gitStatusFiles } from './git.js'

/**
 * porcelain v2 파싱은 실제 git 출력으로 확인한다 — 흉내낸 문자열로는
 * 정확히 우리가 틀렸던 자리(필드 개수)를 다시 틀리게 흉내낼 수 있다.
 */

const dirs: string[] = []
const repo = () => {
  const d = mkdtempSync(join(tmpdir(), 'cc-git-'))
  dirs.push(d)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: d })
  git('init', '-q')
  git('config', 'user.email', 'test@test')
  git('config', 'user.name', 'test')
  return { d, git }
}

/**
 * git이 **정말로 받은 인자**를 적어 둔다 — PATH 앞에 껍데기 git을 놓고 진짜 git으로 넘긴다.
 *
 * execFile을 가로채지 않는 이유: 가로채면 진짜 git이 돌지 않아, 같은 시험이 결과까지
 * 확인하던 힘을 잃는다. 여기서는 진짜 git이 그대로 돌고 줄만 복사된다.
 */
function recordGitArgv(): { calls: () => string[][]; restore: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'cc-git-argv-'))
  dirs.push(dir)
  const log = join(dir, 'argv.log')
  const real = execFileSync('sh', ['-c', 'command -v git']).toString().trim()
  const shim = join(dir, 'bin')
  mkdirSync(shim)
  writeFileSync(
    join(shim, 'git'),
    `#!/bin/sh\nprintf '%s\\036' "$@" >> "${log}"\nprintf '\\n' >> "${log}"\nexec "${real}" "$@"\n`,
  )
  chmodSync(join(shim, 'git'), 0o755)
  writeFileSync(log, '')

  const previousPath = process.env.PATH
  process.env.PATH = `${shim}:${previousPath ?? ''}`
  return {
    calls: () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('\u001e').slice(0, -1)),
    restore: () => {
      process.env.PATH = previousPath
    },
  }
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('gitStatusFiles — porcelain v2', () => {
  /*
   * 이름 바뀜(2) 항목은 경로 앞에 필드가 하나 더 있다(R100 등).
   * 보통 항목(1)과 같은 자리로 읽으면 경로가 "R100 새이름"이 되어 —
   * 존재하지 않는 파일이라 — 스테이징이 조용히 실패했다.
   */
  it('이름을 바꾼 파일은 새 이름으로 나온다 (점수 필드가 경로에 섞이지 않는다)', async () => {
    const { d, git } = repo()
    writeFileSync(join(d, 'old.txt'), '내용이 충분히 길어야 rename으로 인식된다\n'.repeat(5))
    git('add', '.')
    git('commit', '-q', '-m', 'init')
    // 공백 있는 이름으로 바꾼다 — 경로 복원(join)이 깨지는지도 함께 본다
    git('mv', 'old.txt', 'new name.txt')

    const files = await gitStatusFiles(d)
    expect(files).toEqual([{ path: 'new name.txt', staged: true, status: 'R' }])
    // 원래 이름(old.txt)이 별도 항목으로 새어 나오면 안 된다 (-z에서는 다음 NUL 토큰으로 온다)
    expect(files.some((f) => f.path.includes('old.txt'))).toBe(false)
    // 파싱된 경로가 진짜 파일이어야 스테이징이 된다 — 여기가 원래 조용히 죽던 자리다
    await expect(gitStage(d, files.map((f) => f.path))).resolves.toBeUndefined()
  })

  it('보통 변경(1)은 그대로 나온다', async () => {
    const { d, git } = repo()
    writeFileSync(join(d, 'a.txt'), 'v1\n')
    git('add', '.')
    git('commit', '-q', '-m', 'init')
    writeFileSync(join(d, 'a.txt'), 'v2\n')

    const files = await gitStatusFiles(d)
    expect(files).toEqual([{ path: 'a.txt', staged: false, status: 'M' }])
  })
})

describe('git path containment', () => {
  it('rejects no-index diff paths outside a project subdirectory', async () => {
    const { d, git } = repo()
    writeFileSync(join(d, 'tracked.txt'), 'base\n')
    git('add', '.')
    git('commit', '-q', '-m', 'init')
    const sub = join(d, 'pkg')
    execFileSync('mkdir', ['-p', sub])
    writeFileSync(join(d, 'outside.txt'), 'outside\n')

    await expect(gitDiff(sub, '../outside.txt')).rejects.toThrow(/outside the project/i)
  })

  it('treats option-looking filenames as paths when diffing and staging', async () => {
    const { d } = repo()
    const name = '--output=owned.patch'
    writeFileSync(join(d, name), 'content\n')

    const argv = recordGitArgv()
    try {
      const diff = await gitDiff(d, name)
      expect(diff.diff).toContain('content')
      await expect(gitStage(d, [name])).resolves.toBeUndefined()
      expect(await gitStatusFiles(d)).toEqual([{ path: name, staged: true, status: 'A' }])
    } finally {
      argv.restore()
    }

    /*
     * 결과만 보면 세 개의 `--` 중 하나만 지켜진다: `:(literal)` 접두가 붙는 자리에서는
     * 인자가 이미 `:`로 시작해 git이 옵션으로 읽을 일이 없고, 반대로 `--`가 있으면
     * 접두가 없어도 통과한다. 두 겹이 서로를 가려 주므로 **하나를 지워도 초록이었다**
     * (#121). 그래서 결과가 아니라 git이 실제로 받은 줄을 본다.
     */
    const carrying = argv.calls().filter((args) => args.some((a) => a.includes('owned.patch')))
    expect(carrying.length).toBeGreaterThan(0)
    for (const args of carrying) {
      expect(args.indexOf('--')).toBeGreaterThanOrEqual(0)
      expect(args.indexOf('--')).toBeLessThan(args.findIndex((a) => a.includes('owned.patch')))
    }
  })

  it('rejects symlinked no-index diff paths whose target leaves the project', async () => {
    const { d, git } = repo()
    writeFileSync(join(d, 'tracked.txt'), 'base\n')
    git('add', '.')
    git('commit', '-q', '-m', 'init')
    const outside = mkdtempSync(join(tmpdir(), 'cc-git-outside-'))
    dirs.push(outside)
    writeFileSync(join(outside, 'secret.txt'), 'secret\n')
    symlinkSync(outside, join(d, 'linked-out'), 'dir')

    await expect(gitDiff(d, 'linked-out/secret.txt')).rejects.toThrow(/outside the project/i)
    await expect(gitStage(d, ['linked-out/secret.txt'])).rejects.toThrow(/outside the project/i)
  })


  it('rejects git pathspec magic instead of letting it widen selection', async () => {
    const { d } = repo()
    writeFileSync(join(d, 'a.txt'), 'a\n')
    writeFileSync(join(d, 'b.txt'), 'b\n')

    await expect(gitDiff(d, ':(glob)*.txt')).rejects.toThrow(/invalid git path/i)
    await expect(gitStage(d, [':(glob)*.txt'])).rejects.toThrow(/invalid git path/i)
  })

  it('treats wildcard-looking paths literally instead of as git pathspec globs', async () => {
    const { d, git } = repo()
    writeFileSync(join(d, 'a.txt'), 'a\n')
    writeFileSync(join(d, 'b.txt'), 'b\n')
    git('add', '.')
    git('commit', '-q', '-m', 'init')
    writeFileSync(join(d, 'a.txt'), 'changed\n')
    writeFileSync(join(d, 'b.txt'), 'changed\n')

    const diff = await gitDiff(d, '*.txt')
    expect(diff.diff).toBe('')
    await expect(gitStage(d, ['*.txt'])).rejects.toThrow(/pathspec/i)
    expect(await gitStatusFiles(d)).toEqual([
      { path: 'a.txt', staged: false, status: 'M' },
      { path: 'b.txt', staged: false, status: 'M' },
    ])
  })

  it('rejects stage paths outside the project', async () => {
    const { d } = repo()

    await expect(gitStage(d, ['../outside.txt'])).rejects.toThrow(/outside the project/i)
  })
})

/**
 * git 경로도 같은 갈라짐에 샜다 (#119).
 *
 * `assertLexicalGitPath`는 `..`를 접은 문자열을 git에 넘기고, `assertCanonicalGitPath`는
 * 접지 않은 문자열을 검사했다. 링크의 대상이 링크 자신보다 깊으면 둘이 갈라져서, 검사는
 * 프로젝트 안을 보고 통과하는데 git은 바깥 파일을 읽어 그 내용을 diff 본문으로 돌려줬다.
 */
describe('링크 뒤의 .. 로 바깥 파일의 내용을 보지 못한다 (#119)', () => {
  it('diff가 거부된다', async () => {
    const { d } = repo()
    const outside = mkdtempSync(join(tmpdir(), 'cc-git-outside-'))
    dirs.push(outside)
    writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE SECRET')
    execFileSync('mkdir', ['-p', join(d, 'sub', 'deep')])
    execFileSync('mkdir', ['-p', join(d, 'sub', 'evil')])
    symlinkSync(join(d, 'sub', 'deep'), join(d, 'link'))
    symlinkSync(outside, join(d, 'evil'))

    await expect(gitDiff(d, 'link/../evil/secret.txt')).rejects.toThrow(/outside the project/i)
  })
})

/**
 * 브랜치 목록과 전환 (#175) — `origin`이 있는 진짜 저장소로 본다. 짧은 이름(`refname:short`)은
 * 원격 브랜치에 `remotes/`를 붙이지 않아서, 이름만 보고는 `origin/main`과 `feature/login`을
 * 가를 수 없었다.
 */
describe('branches with a remote (#175)', () => {
  const withOrigin = () => {
    const { d: upstream, git: up } = repo()
    up('checkout', '-q', '-b', 'main')
    writeFileSync(join(upstream, 'f.txt'), 'original\n')
    up('add', '.')
    up('commit', '-q', '-m', 'init')
    up('branch', 'release')
    const d = mkdtempSync(join(tmpdir(), 'cc-git-clone-'))
    dirs.push(d)
    execFileSync('git', ['clone', '-q', upstream, d])
    const git = (...args: string[]) => execFileSync('git', args, { cwd: d }).toString()
    git('config', 'user.email', 'test@test')
    git('config', 'user.name', 'test')
    git('branch', 'feature/login')
    return { d, git }
  }

  it('sorts local and remote by the full ref, and drops the remote HEAD alias', async () => {
    const { d } = withOrigin()
    const list = await gitBranches(d)
    expect(list.map((b) => [b.name, b.remote])).toEqual([
      ['feature/login', false],
      ['main', false],
      ['origin/main', true],
      ['origin/release', true],
    ])
    expect(list.find((b) => b.name === 'main')).toMatchObject({ current: true, upstream: 'origin/main' })
  })

  it('picking a remote branch makes a tracking branch instead of detaching HEAD', async () => {
    const { d, git } = withOrigin()
    await expect(gitCheckout(d, 'origin/release')).resolves.toEqual({ ok: true, conflicts: [] })
    expect(git('symbolic-ref', '--short', 'HEAD').trim()).toBe('release')
    expect(git('rev-parse', '--abbrev-ref', 'release@{upstream}').trim()).toBe('origin/release')
  })

  it('a branch named like an option is switched to, not run as one', async () => {
    const { d, git } = withOrigin()
    git('update-ref', 'refs/heads/-f', 'HEAD')
    writeFileSync(join(d, 'f.txt'), 'unsaved agent work\n')
    expect((await gitBranches(d)).map((b) => b.name)).toContain('-f')

    await expect(gitCheckout(d, '-f')).resolves.toEqual({ ok: true, conflicts: [] })
    expect(readFileSync(join(d, 'f.txt'), 'utf8')).toBe('unsaved agent work\n')
    expect(git('symbolic-ref', '--short', 'HEAD').trim()).toBe('-f')
  })
})

/**
 * 한글 이름이 diff 머리줄에 그대로 나온다 (#176). `core.quotePath` 기본값이면 git은
 * `diff --git "a/\355\225\234…" "b/…"`로 감싸서, 화면의 이름표가 머리줄 원문이 되고 파일로
 * 가는 클릭이 경로를 잃었다.
 */
describe('Korean file names in git output (#176)', () => {
  it('the diff header carries the name as written', async () => {
    const { d, git } = repo()
    writeFileSync(join(d, '한글파일.md'), 'v1\n')
    git('add', '.')
    git('commit', '-q', '-m', 'init')
    writeFileSync(join(d, '한글파일.md'), 'v2\n')

    const { diff } = await gitDiff(d, '한글파일.md')
    expect(diff.split('\n')[0]).toBe('diff --git a/한글파일.md b/한글파일.md')
  })
})

describe('commit detail and commit errors (#160)', () => {
  it('a clean merge shows what it brought in from the merged branch', async () => {
    const { d, git } = repo()
    git('checkout', '-q', '-b', 'main')
    writeFileSync(join(d, 'a.txt'), 'a\n')
    git('add', '.')
    git('commit', '-q', '-m', 'init')
    git('checkout', '-q', '-b', 'side')
    writeFileSync(join(d, 'b.txt'), 'b\n')
    git('add', '.')
    git('commit', '-q', '-m', 'side')
    git('checkout', '-q', 'main')
    writeFileSync(join(d, 'c.txt'), 'c\n')
    git('add', '.')
    git('commit', '-q', '-m', 'main moves on')
    git('merge', '-q', '--no-edit', 'side')
    const merge = git('rev-parse', 'HEAD').toString().trim()

    const detail = await gitCommitDetail(d, merge)
    expect(detail.files).toEqual(['b.txt'])
    expect(detail.diff).toContain('+++ b/b.txt')
  })

  it('a commit with nothing to commit says why', async () => {
    const { d, git } = repo()
    writeFileSync(join(d, 'a.txt'), 'a\n')
    git('add', '.')
    git('commit', '-q', '-m', 'init')

    const r = await gitCommit(d, 'my message')
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/nothing to commit/)
  })
})
