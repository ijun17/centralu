import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitDiff, gitStage, gitStatusFiles } from './git.js'

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

    const diff = await gitDiff(d, name)
    expect(diff.diff).toContain('content')
    await expect(gitStage(d, [name])).resolves.toBeUndefined()
    expect(await gitStatusFiles(d)).toEqual([{ path: name, staged: true, status: 'A' }])
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
