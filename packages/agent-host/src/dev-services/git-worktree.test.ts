import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitSummary, gitWorktreeAdd, gitWorktreeDirty, gitWorktreeList, gitWorktreeRemove } from './git.js'

/**
 * 워크트리는 **진짜 git으로만** 시험할 수 있다.
 * 가짜를 세우면 우리가 아는 규칙만 확인하게 되고, 정작 git의 규칙(브랜치 중복·더러운 트리 거부)을
 * 못 본다 — 이 기능에서 사용자를 막는 것은 전부 후자다.
 */
let repo = ''
let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-wt-'))
  repo = join(root, 'repo')
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { cwd: root })
  writeFileSync(join(repo, 'a.txt'), 'hello\n')
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: repo })
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('워크트리', () => {
  it('저장소 밖 경로에 만들고, 원본과 다른 브랜치를 준다', async () => {
    const path = join(root, 'outside', 'session-1')
    const wt = await gitWorktreeAdd(repo, path, 'centralu/abc12345')

    expect(wt).toEqual({ path, branch: 'centralu/abc12345' })
    expect(existsSync(join(path, 'a.txt'))).toBe(true)
    // 원본은 그대로 main에 있어야 한다 — 격리가 그 뜻이다
    expect((await gitSummary(repo)).branch).toBe('main')
    expect((await gitSummary(path)).branch).toBe('centralu/abc12345')
  })

  it('한쪽에서 고쳐도 다른 쪽은 안 흔들린다 (이 기능의 목적)', async () => {
    const path = join(root, 'outside', 'session-2')
    await gitWorktreeAdd(repo, path, 'centralu/wt2')
    writeFileSync(join(path, 'a.txt'), '워크트리에서 고침\n')

    expect((await gitWorktreeDirty(path)).dirty).toBe(true)
    expect((await gitWorktreeDirty(repo)).dirty).toBe(false)
  })

  it('커밋 안 된 변경이 있으면 force 없이는 안 지워진다', async () => {
    const path = join(root, 'outside', 'session-3')
    await gitWorktreeAdd(repo, path, 'centralu/wt3')
    writeFileSync(join(path, 'a.txt'), '아직 커밋 안 함\n')

    // git이 거부하는 것을 확인한다 — 우리가 force를 붙이는 이유가 여기 있다
    await expect(gitWorktreeRemove(repo, path)).rejects.toThrow()
    expect(existsSync(path)).toBe(true)

    await gitWorktreeRemove(repo, path, true)
    expect(existsSync(path)).toBe(false)
  })

  it('같은 브랜치 이름으로 두 번 만들 수 없다', async () => {
    const a = join(root, 'outside', 'a')
    const b = join(root, 'outside', 'b')
    await gitWorktreeAdd(repo, a, 'centralu/dup')
    // 세션 id 앞자리로 브랜치를 짓는 이상 사실상 겪지 않지만, 겪으면 조용히 실패하면 안 된다
    await expect(gitWorktreeAdd(repo, b, 'centralu/dup')).rejects.toThrow()
  })

  it('목록에 등록된 것만 보인다 (지운 뒤에는 사라진다)', async () => {
    const path = join(root, 'outside', 'listed')
    await gitWorktreeAdd(repo, path, 'centralu/listed')

    const before = await gitWorktreeList(repo)
    expect(before.map((w) => w.branch)).toContain('centralu/listed')

    await gitWorktreeRemove(repo, path)
    const after = await gitWorktreeList(repo)
    expect(after.map((w) => w.branch)).not.toContain('centralu/listed')
  })

  it('git 저장소가 아니면 목록은 빈 채로 답한다 (터지지 않는다)', async () => {
    expect(await gitWorktreeList(root)).toEqual([])
  })
})
