import { describe, expect, it } from 'vitest'
import { detectTrigger, scoreCommand } from './Autocomplete.js'

/**
 * 자동완성이 **원하지 않는 것을 고르게 만들면** 안 쓰느니만 못하다.
 * Enter를 누르는 순간 맨 위 항목이 들어가므로, 순서가 곧 정확성이다.
 */
describe('슬래시 명령 정렬', () => {
  const rank = (names: string[], q: string) =>
    names
      .map((n) => ({ n, s: scoreCommand(n, q) }))
      .filter((x): x is { n: string; s: number } => x.s !== null)
      .sort((a, b) => (b.s === a.s ? a.n.length - b.n.length : b.s - a.s))
      .map((x) => x.n)

  it('정확히 일치하는 것이 가장 위다 (도그푸딩: usage에 usage-credit이 먼저 떴다)', () => {
    expect(rank(['usage-credit', 'usage', 'usage-report'], 'usage')[0]).toBe('usage')
  })

  it('앞에서 시작하는 쪽이 중간에 걸린 것보다 위다', () => {
    expect(rank(['docs-usage', 'usage-credit'], 'usa')[0]).toBe('usage-credit')
  })

  it('한두 글자는 시작·경계 매치만 받는다 (중간 매치는 소음이다)', () => {
    const out = rank(['usage', 'docs-lookup', 'commit', 'usage-credit'], 'u')
    expect(out).toContain('usage')
    expect(out).not.toContain('docs-lookup') // lookup의 u가 끼어들면 안 된다
    expect(out).not.toContain('commit')
  })

  it('구분자 뒤도 이름의 시작으로 친다', () => {
    expect(scoreCommand('usage-credit', 'credit')).not.toBeNull()
  })

  it('세 글자부터는 중간 매치도 받아준다', () => {
    expect(scoreCommand('docs-lookup', 'ook')).not.toBeNull()
    expect(scoreCommand('docs-lookup', 'zzz')).toBeNull()
  })

  it('짧은 이름이 같은 점수에서 위다', () => {
    expect(rank(['reviewer-extra', 'review'], 'review')[0]).toBe('review')
  })
})

describe('무엇을 자동완성할지 알아내기', () => {
  it('슬래시는 맨 앞에서만 (문장 중간의 경로를 명령으로 보면 안 된다)', () => {
    expect(detectTrigger('/rev', 4)?.kind).toBe('command')
    expect(detectTrigger('경로는 src/rev', '경로는 src/rev'.length)).toBeNull()
  })

  it('@는 공백 뒤에서 시작한 것만 (이메일 주소를 잡지 않는다)', () => {
    expect(detectTrigger('이거 봐줘 @src/a', '이거 봐줘 @src/a'.length)?.kind).toBe('file')
    expect(detectTrigger('me@example.com', 'me@example.com'.length)).toBeNull()
  })

  it('바꿔 넣을 자리를 정확히 잡는다', () => {
    const text = '보자 @Ses'
    const t = detectTrigger(text, text.length)!
    expect(t.query).toBe('Ses')
    expect(text.slice(t.start)).toBe('@Ses')
  })
})
