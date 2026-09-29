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
  it('a single trunk runs straight down one lane', () => {
    const rows = layoutCommits([c('c', 'b'), c('b', 'a'), c('a')])
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0])
    expect(laneCount(rows)).toBe(1)
  })

  it('when the last commit has no parent, the line ends there too (the root)', () => {
    const rows = layoutCommits([c('b', 'a'), c('a')])
    expect(rows.at(-1)!.below).toEqual([])
    expect(rows.at(-1)!.edges).toEqual([])
  })

  it('a parent outside the window keeps holding its lane — history does not end there', () => {
    const rows = layoutCommits([c('b', 'a')]) // a is not in the list
    expect(rows[0]!.below).toEqual([0])
  })

  it('a merge branches off into a side lane and joins back', () => {
    // m ─┬─ main(x) ─┐
    //    └─ side(y) ─┴─ base(z)
    const rows = layoutCommits([c('m', 'x', 'y'), c('x', 'z'), c('y', 'z'), c('z')])

    const [m, x, y, z] = rows as [(typeof rows)[0], (typeof rows)[0], (typeof rows)[0], (typeof rows)[0]]
    expect(m.lane).toBe(0)
    // The first parent continues its own lane; only the second parent branches off to the side
    expect(m.edges).toEqual([0, 1])
    expect(x.lane).toBe(0)
    expect(y.lane).toBe(1)
    // When the two branches point at the same parent, they merge into one instead of making a new lane
    expect(y.edges).toEqual([0])
    expect(z.lane).toBe(0)
    expect(laneCount(rows)).toBe(2)
  })

  it('a lane that branched off is empty again once merged, and the next branch reuses it', () => {
    const rows = layoutCommits([c('m', 'x', 'y'), c('x', 'z'), c('y', 'z'), c('z')])
    // Only lane 0 comes down into the z row — lane 1 already joined at y and is gone
    expect(rows[3]!.above).toEqual([0])
  })

  it('two children pointing at the same parent leave only one lane (no ghost lane)', () => {
    // Two heads that have the same parent
    const rows = layoutCommits([c('h1', 'p'), c('h2', 'p'), c('p')])
    expect(rows[2]!.lane).toBe(0)
    // No lane may be left after p
    expect(rows[2]!.below).toEqual([])
  })

  it('no ghost lane is left when a parent comes before its child (dates out of order after a rebase)', () => {
    // A non-topological order with p drawn above c — c's parent p is already drawn, so it must not get a lane
    const rows = layoutCommits([c('p'), c('c', 'p')])
    expect(rows[1]!.below).toEqual([])
    expect(rows[1]!.edges).toEqual([])
    expect(laneCount(rows)).toBe(1)
  })

  it('a merge makes no new lane when its second parent has already been drawn', () => {
    // A non-topological order where y comes before the merge m
    const rows = layoutCommits([c('y', 'z'), c('m', 'x', 'y'), c('x', 'z'), c('z')])
    const bottom = rows.at(-1)!
    // No lane may be left once z is drawn — no ghost lane waiting for y
    expect(bottom.below).toEqual([])
  })

  it('above/below really connect — the above of a row equals the below of the row over it', () => {
    const rows = layoutCommits([c('m', 'x', 'y'), c('x', 'z'), c('y', 'z'), c('z')])
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.above).toEqual(rows[i - 1]!.below)
    }
  })
})
