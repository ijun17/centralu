import { describe, expect, it } from 'vitest'
import { attachCommitSessions, looksLikeGitCommit, parseCommitSha } from './git-attrib.js'
import type { GitCommit } from '@cc/protocol'

/** 커밋 귀속 (#50) — 훅 없이 도구 출력에서 줍는 쪽의 계약 */

describe('parseCommitSha', () => {
  it('git commit 출력의 [branch hash] 줄에서 줍는다', () => {
    expect(parseCommitSha('[main 4ce6fc7] fix(grid): columns\n 3 files changed')).toBe('4ce6fc7')
    expect(parseCommitSha('[feature/x abc1234def] msg')).toBe('abc1234def')
    expect(parseCommitSha('[detached HEAD 9f8e7d6] msg')).toBe('9f8e7d6')
    // 루트 커밋
    expect(parseCommitSha('[main (root-commit) 1a2b3c4] first')).toBe('1a2b3c4')
  })

  it('해시가 없으면 null — 그때는 HEAD를 물어본다', () => {
    expect(parseCommitSha('nothing to commit, working tree clean')).toBeNull()
    expect(parseCommitSha('')).toBeNull()
  })
})

describe('looksLikeGitCommit', () => {
  it('평범한 커밋과 체인 속 커밋을 잡는다', () => {
    expect(looksLikeGitCommit('git commit -m "x"')).toBe(true)
    expect(looksLikeGitCommit('git add -A && git commit -m "y" && git push')).toBe(true)
    expect(looksLikeGitCommit("/bin/zsh -lc 'git commit -am wip'")).toBe(true)
  })
  it('커밋이 아닌 git은 지나간다', () => {
    expect(looksLikeGitCommit('git status')).toBe(false)
    expect(looksLikeGitCommit('npm test')).toBe(false)
  })
})

describe('attachCommitSessions', () => {
  const commit = (sha: string): GitCommit => ({ sha, shortSha: sha.slice(0, 7), subject: 's', author: 'a', when: 1, parents: [] })

  it('짧은 해시(잘린 출력에서 주운 것)도 접두사로 맞춘다', () => {
    const out = attachCommitSessions(
      [commit('4ce6fc7aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), commit('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')],
      [{ sha: '4ce6fc7', sessionId: 's1' }],
      (id) => (id === 's1' ? '인증 리팩터링' : undefined),
    )
    expect(out[0]!.sessionName).toBe('인증 리팩터링')
    expect(out[1]!.sessionName).toBeUndefined()
  })

  it('세션이 지워졌어도 에이전트 커밋이라는 사실은 남는다', () => {
    const out = attachCommitSessions([commit('abc')], [{ sha: 'abc', sessionId: 'gone' }], () => undefined)
    expect(out[0]!.sessionName).toBe('(지워진 세션)')
  })
})
