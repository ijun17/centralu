import { describe, expect, it } from 'vitest'
import type { GitCommit } from '@cc/protocol'
import { commitAgo, hasMultipleAuthors } from './commits.js'

/** Two rules the commit list keeps — how long ago it was, and whether a name is worth writing */

const NOW = Date.UTC(2026, 7, 21, 12, 0, 0)
const minutes = (n: number) => NOW - n * 60_000

describe('commitAgo', () => {
  it('is just now under one minute — seconds have no meaning for a commit', () => {
    expect(commitAgo(NOW, NOW)).toBe('just now')
    expect(commitAgo(minutes(0.9), NOW)).toBe('just now')
  })
  it('shows just now for a commit timestamped in the future by clock skew too — never a negative number of minutes', () => {
    expect(commitAgo(NOW + 60_000, NOW)).toBe('just now')
  })
  it('is minutes up to an hour, hours up to a day', () => {
    expect(commitAgo(minutes(32), NOW)).toBe('32m ago')
    expect(commitAgo(minutes(59), NOW)).toBe('59m ago')
    expect(commitAgo(minutes(60), NOW)).toBe('1h ago')
    expect(commitAgo(minutes(23 * 60), NOW)).toBe('23h ago')
  })
  it('is days past a day, months past a month', () => {
    expect(commitAgo(minutes(24 * 60), NOW)).toBe('1d ago')
    expect(commitAgo(minutes(29 * 24 * 60), NOW)).toBe('29d ago')
    expect(commitAgo(minutes(30 * 24 * 60), NOW)).toBe('1mo ago')
    expect(commitAgo(minutes(400 * 24 * 60), NOW)).toBe('13mo ago')
  })
})

const commit = (author: string): GitCommit => ({
  sha: author, shortSha: author, subject: 's', author, when: NOW, parents: [],
})

describe('hasMultipleAuthors', () => {
  it('does not give up space for a name in a solo repository', () => {
    expect(hasMultipleAuthors([commit('나'), commit('나')])).toBe(false)
  })
  it('writes it when there is someone to tell apart', () => {
    expect(hasMultipleAuthors([commit('나'), commit('너')])).toBe(true)
  })
  it('has an answer even for an empty list (a repository with no commits)', () => {
    expect(hasMultipleAuthors([])).toBe(false)
  })
})
