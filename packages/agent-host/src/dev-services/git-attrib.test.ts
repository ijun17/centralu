import { describe, expect, it } from 'vitest'
import { attachCommitSessions, looksLikeGitCommit, parseCommitSha } from './git-attrib.js'
import type { GitCommit } from '@cc/protocol'

/** Commit attribution (#50) — the contract for the side that picks it up from tool output, without a hook */

describe('parseCommitSha', () => {
  it('picks it up from the [branch hash] line of git commit output', () => {
    expect(parseCommitSha('[main 4ce6fc7] fix(grid): columns\n 3 files changed')).toBe('4ce6fc7')
    expect(parseCommitSha('[feature/x abc1234def] msg')).toBe('abc1234def')
    expect(parseCommitSha('[detached HEAD 9f8e7d6] msg')).toBe('9f8e7d6')
    // the root commit
    expect(parseCommitSha('[main (root-commit) 1a2b3c4] first')).toBe('1a2b3c4')
  })

  it('null when there is no hash — HEAD is asked instead at that point', () => {
    expect(parseCommitSha('nothing to commit, working tree clean')).toBeNull()
    expect(parseCommitSha('')).toBeNull()
  })
})

describe('looksLikeGitCommit', () => {
  it('catches a plain commit and a commit inside a chain', () => {
    expect(looksLikeGitCommit('git commit -m "x"')).toBe(true)
    expect(looksLikeGitCommit('git add -A && git commit -m "y" && git push')).toBe(true)
    expect(looksLikeGitCommit("/bin/zsh -lc 'git commit -am wip'")).toBe(true)
  })
  it('lets a non-commit git command through', () => {
    expect(looksLikeGitCommit('git status')).toBe(false)
    expect(looksLikeGitCommit('npm test')).toBe(false)
  })
})

describe('attachCommitSessions', () => {
  const commit = (sha: string): GitCommit => ({ sha, shortSha: sha.slice(0, 7), subject: 's', author: 'a', when: 1, parents: [] })

  it('matches a short hash (picked up from truncated output) by prefix too', () => {
    const out = attachCommitSessions(
      [commit('4ce6fc7aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), commit('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')],
      [{ sha: '4ce6fc7', sessionId: 's1' }],
      (id) => (id === 's1' ? 'Auth refactor' : undefined),
    )
    expect(out[0]!.sessionName).toBe('Auth refactor')
    expect(out[1]!.sessionName).toBeUndefined()
  })

  it('the fact of an agent commit survives even when the session is deleted', () => {
    const out = attachCommitSessions([commit('abc')], [{ sha: 'abc', sessionId: 'gone' }], () => undefined)
    expect(out[0]!.sessionName).toBe('(deleted session)')
  })
})
