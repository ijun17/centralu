import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitStage, gitStatusFiles } from './git.js'

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
