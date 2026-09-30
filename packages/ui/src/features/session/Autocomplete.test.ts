import { describe, expect, it } from 'vitest'
import { detectTrigger, scoreCommand } from './Autocomplete.js'

/**
 * If autocomplete **makes people pick something they did not want**, it is worse than not
 * having it at all. Pressing Enter inserts whatever is at the top, so order is correctness.
 */
describe('sorting slash commands', () => {
  const rank = (names: string[], q: string) =>
    names
      .map((n) => ({ n, s: scoreCommand(n, q) }))
      .filter((x): x is { n: string; s: number } => x.s !== null)
      .sort((a, b) => (b.s === a.s ? a.n.length - b.n.length : b.s - a.s))
      .map((x) => x.n)

  it('an exact match ranks highest (dogfooding: usage-credit used to show above usage)', () => {
    expect(rank(['usage-credit', 'usage', 'usage-report'], 'usage')[0]).toBe('usage')
  })

  it('a match starting at the front ranks above one caught in the middle', () => {
    expect(rank(['docs-usage', 'usage-credit'], 'usa')[0]).toBe('usage-credit')
  })

  it('one or two letters only get start or word-boundary matches (a mid-word match is noise)', () => {
    const out = rank(['usage', 'docs-lookup', 'commit', 'usage-credit'], 'u')
    expect(out).toContain('usage')
    expect(out).not.toContain('docs-lookup') // the 'u' in lookup must not interfere
    expect(out).not.toContain('commit')
  })

  it('what follows a separator also counts as the start of a name', () => {
    expect(scoreCommand('usage-credit', 'credit')).not.toBeNull()
  })

  it('from three letters on, mid-word matches are accepted too', () => {
    expect(scoreCommand('docs-lookup', 'ook')).not.toBeNull()
    expect(scoreCommand('docs-lookup', 'zzz')).toBeNull()
  })

  it('a shorter name ranks first on a tied score', () => {
    expect(rank(['reviewer-extra', 'review'], 'review')[0]).toBe('review')
  })
})

describe('working out what to autocomplete', () => {
  it('a slash only at the very start (a path in the middle of a sentence must not be read as a command)', () => {
    expect(detectTrigger('/rev', 4)?.kind).toBe('command')
    expect(detectTrigger('경로는 src/rev', '경로는 src/rev'.length)).toBeNull()
  })

  it('@ only starting right after whitespace (does not match email addresses)', () => {
    expect(detectTrigger('이거 봐줘 @src/a', '이거 봐줘 @src/a'.length)?.kind).toBe('file')
    expect(detectTrigger('me@example.com', 'me@example.com'.length)).toBeNull()
  })

  it('pinpoints exactly where the replacement should be inserted', () => {
    const text = '보자 @Ses'
    const t = detectTrigger(text, text.length)!
    expect(t.query).toBe('Ses')
    expect(text.slice(t.start)).toBe('@Ses')
  })
})
