import { describe, expect, it } from 'vitest'
import type { GitCommit } from '@cc/protocol'
import { commitAgo, hasMultipleAuthors } from './commits.js'

/** 기록 목록이 지키는 두 규칙 — 얼마나 됐나, 그리고 이름을 적을 값어치가 있나 */

const NOW = Date.UTC(2026, 7, 21, 12, 0, 0)
const minutes = (n: number) => NOW - n * 60_000

describe('commitAgo', () => {
  it('1분 미만은 방금이다 — 초 단위는 커밋에서 의미가 없다', () => {
    expect(commitAgo(NOW, NOW)).toBe('just now')
    expect(commitAgo(minutes(0.9), NOW)).toBe('just now')
  })
  it('시계가 어긋나 미래로 찍힌 커밋도 방금으로 — 음수 분을 적지 않는다', () => {
    expect(commitAgo(NOW + 60_000, NOW)).toBe('just now')
  })
  it('한 시간까지는 분, 하루까지는 시간', () => {
    expect(commitAgo(minutes(32), NOW)).toBe('32m ago')
    expect(commitAgo(minutes(59), NOW)).toBe('59m ago')
    expect(commitAgo(minutes(60), NOW)).toBe('1h ago')
    expect(commitAgo(minutes(23 * 60), NOW)).toBe('23h ago')
  })
  it('하루를 넘기면 날, 한 달을 넘기면 달', () => {
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
  it('혼자 쓰는 저장소면 이름 자리를 내주지 않는다', () => {
    expect(hasMultipleAuthors([commit('나'), commit('나')])).toBe(false)
  })
  it('구별할 사람이 있으면 적는다', () => {
    expect(hasMultipleAuthors([commit('나'), commit('너')])).toBe(true)
  })
  it('빈 목록에서도 답이 있다 (커밋이 없는 저장소)', () => {
    expect(hasMultipleAuthors([])).toBe(false)
  })
})
