import { describe, expect, it } from 'vitest'
import type { GitCommit } from '@cc/protocol'
import { laneCount, layoutCommits } from './graph.js'

const c = (sha: string, ...parents: string[]): GitCommit => ({
  sha,
  shortSha: sha.slice(0, 7),
  subject: sha,
  author: 'a',
  when: 0,
  parents,
})

describe('layoutCommits', () => {
  it('한 줄기는 한 레인에 곧게 내려간다', () => {
    const rows = layoutCommits([c('c', 'b'), c('b', 'a'), c('a')])
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0])
    expect(laneCount(rows)).toBe(1)
  })

  it('마지막 커밋의 부모가 없으면 선도 거기서 끝난다 (루트)', () => {
    const rows = layoutCommits([c('b', 'a'), c('a')])
    expect(rows.at(-1)!.below).toEqual([])
    expect(rows.at(-1)!.edges).toEqual([])
  })

  it('창 밖의 부모는 레인을 붙잡은 채로 둔다 — 역사는 거기서 끝난 게 아니다', () => {
    const rows = layoutCommits([c('b', 'a')]) // a는 목록에 없다
    expect(rows[0]!.below).toEqual([0])
  })

  it('병합은 옆 레인으로 갈라졌다가 다시 합류한다', () => {
    // m ─┬─ main(x) ─┐
    //    └─ side(y) ─┴─ base(z)
    const rows = layoutCommits([c('m', 'x', 'y'), c('x', 'z'), c('y', 'z'), c('z')])

    const [m, x, y, z] = rows as [(typeof rows)[0], (typeof rows)[0], (typeof rows)[0], (typeof rows)[0]]
    expect(m.lane).toBe(0)
    // 첫 부모는 제 레인을 잇고, 두 번째 부모만 옆으로 갈라진다
    expect(m.edges).toEqual([0, 1])
    expect(x.lane).toBe(0)
    expect(y.lane).toBe(1)
    // 두 갈래가 같은 부모를 가리키면 새 레인을 만들지 않고 하나로 합쳐진다
    expect(y.edges).toEqual([0])
    expect(z.lane).toBe(0)
    expect(laneCount(rows)).toBe(2)
  })

  it('갈라진 레인은 합쳐진 뒤 다시 비어 다음 가지가 재사용한다', () => {
    const rows = layoutCommits([c('m', 'x', 'y'), c('x', 'z'), c('y', 'z'), c('z')])
    // z 행 위에서는 0번만 내려온다 — 1번은 y에서 이미 합류해 사라졌다
    expect(rows[3]!.above).toEqual([0])
  })

  it('같은 부모를 가리키는 자식이 둘이면 레인 하나만 남는다 (유령 레인 없음)', () => {
    // 두 개의 head가 같은 부모를 가진 경우
    const rows = layoutCommits([c('h1', 'p'), c('h2', 'p'), c('p')])
    expect(rows[2]!.lane).toBe(0)
    // p 이후로 남아 있는 레인이 없어야 한다
    expect(rows[2]!.below).toEqual([])
  })

  it('부모가 자식보다 먼저 와도 유령 레인이 남지 않는다 (rebase 뒤 날짜 역전)', () => {
    // p가 c보다 위에 찍힌 비-topo 순서 — c의 부모 p는 이미 그려졌으므로 레인을 잡으면 안 된다
    const rows = layoutCommits([c('p'), c('c', 'p')])
    expect(rows[1]!.below).toEqual([])
    expect(rows[1]!.edges).toEqual([])
    expect(laneCount(rows)).toBe(1)
  })

  it('병합의 두 번째 부모가 이미 그려졌어도 새 레인을 만들지 않는다', () => {
    // y가 병합 m보다 먼저 나오는 비-topo 순서
    const rows = layoutCommits([c('y', 'z'), c('m', 'x', 'y'), c('x', 'z'), c('z')])
    const bottom = rows.at(-1)!
    // z가 그려진 뒤에는 어떤 레인도 남지 않아야 한다 — y를 기다리는 유령 레인 금지
    expect(bottom.below).toEqual([])
  })

  it('above/below는 실제로 이어진다 — 아래 행의 above는 위 행의 below와 같다', () => {
    const rows = layoutCommits([c('m', 'x', 'y'), c('x', 'z'), c('y', 'z'), c('z')])
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.above).toEqual(rows[i - 1]!.below)
    }
  })
})
