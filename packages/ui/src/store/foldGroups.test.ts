import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@cc/core'
import { appGroupKey, childrenGroupKey, deadFoldKeys, foldGroupsHiding, sameKeys } from './foldGroups.js'

const s = (id: string, over: Partial<SessionSummary> = {}) =>
  ({ id, projectId: 'p', appId: null, machine: null, parentSessionId: null, askedBy: null, ...over }) as SessionSummary
const keyOf = (x: SessionSummary) => `${x.projectId}/${x.appId}`

describe('foldGroupsHiding (#666)', () => {
  const all = (...list: SessionSummary[]) => Object.fromEntries(list.map((x) => [x.id, x]))
  const listed = new Set(['p/slider'])

  it('names the group of the session that started this one', () => {
    const kid = s('kid', { askedBy: 'parent' })
    expect(foldGroupsHiding(kid, all(s('parent'), kid), keyOf, listed)).toEqual([childrenGroupKey('parent')])
    const wt = s('wt', { parentSessionId: 'parent' })
    expect(foldGroupsHiding(wt, all(s('parent'), wt), keyOf, listed)).toEqual([childrenGroupKey('parent')])
  })

  it('names the group of the session a fork was copied from, not of the session that asked for it (#677)', () => {
    const fork = s('fork', { askedBy: 'asker', parentSessionId: 'asker', forkedFrom: 'busy' })
    expect(foldGroupsHiding(fork, all(s('busy'), s('asker'), fork), keyOf, listed)).toEqual([childrenGroupKey('busy')])
  })

  it('names the app’s group when the app is listed, and nothing for a removed one', () => {
    const owned = s('owned', { appId: 'slider' })
    expect(foldGroupsHiding(owned, all(owned), keyOf, listed)).toEqual([appGroupKey('p/slider')])
    const gone = s('gone', { appId: 'removed' })
    expect(foldGroupsHiding(gone, all(gone), keyOf, listed)).toEqual([])
  })

  it('names both for a child inside an app, and only the app for a parent that is drawn elsewhere', () => {
    const parent = s('parent', { appId: 'slider' })
    const kid = s('kid', { appId: 'slider', askedBy: 'parent' })
    expect(foldGroupsHiding(kid, all(parent, kid), keyOf, listed)).toEqual([appGroupKey('p/slider'), childrenGroupKey('parent')])
    // The parent stands in the project's own list, so the child is not nested under it
    const loose = s('loose')
    const strayKid = s('stray', { appId: 'slider', askedBy: 'loose' })
    expect(foldGroupsHiding(strayKid, all(loose, strayKid), keyOf, listed)).toEqual([appGroupKey('p/slider')])
  })

  // #1038: a child started on another machine is a session of that machine's project, but the sidebar draws it under its parent
  it('names the parent’s group for a child that stands in the parent’s project but belongs to another machine’s', () => {
    const parent = s('parent')
    const kid = s('m1.kid', { projectId: 'm1.q', machine: 'm1', askedBy: 'parent' })
    expect(foldGroupsHiding(kid, all(parent, kid), keyOf, listed)).toEqual([childrenGroupKey('parent')])
  })

  // The tree draws a fork under its asker when the session it was copied from is gone (`treeParentOf`); the reveal followed forkedFrom
  it('names the asker’s group for a fork whose source is gone', () => {
    const asker = s('asker')
    const fork = s('fork', { askedBy: 'asker', parentSessionId: 'asker', forkedFrom: 'deleted' })
    expect(foldGroupsHiding(fork, all(asker, fork), keyOf, listed)).toEqual([childrenGroupKey('asker')])
    // The source is in another group than the fork's: the tree does not nest the fork under it either
    const far = s('far', { projectId: 'q' })
    const strayFork = s('stray', { askedBy: 'asker', forkedFrom: 'far' })
    expect(foldGroupsHiding(strayFork, all(asker, far, strayFork), keyOf, listed)).toEqual([childrenGroupKey('asker')])
  })

  it('names nothing for a top-level session, a parent in another project or one that is gone', () => {
    expect(foldGroupsHiding(s('top'), all(s('top')), keyOf, listed)).toEqual([])
    const far = s('far', { askedBy: 'elsewhere' })
    expect(foldGroupsHiding(far, all(far, s('elsewhere', { projectId: 'q' })), keyOf, listed)).toEqual([])
    expect(foldGroupsHiding(far, all(far), keyOf, listed)).toEqual([])
  })
})

describe('deadFoldKeys (#666)', () => {
  const sessions = { live: {} }
  const apps = new Set(['p/slider', '_user/tool'])

  it('names the folds of sessions and apps that are gone', () => {
    expect(deadFoldKeys(['session:live', 'session:gone', 'app:p/slider', 'app:p/gone', 'app:_user/tool'], sessions, apps)).toEqual([
      'session:gone',
      'app:p/gone',
    ])
  })

  it('leaves a linked machine’s keys alone: they are absent only until its link comes up', () => {
    expect(deadFoldKeys(['session:m1.abc', 'app:m1.proj/slider', 'app:m1:_user/tool'], sessions, apps)).toEqual([])
  })

  it('judges no app while the app list says nothing, and ignores keys it does not know', () => {
    expect(deadFoldKeys(['app:p/gone', 'session:gone', 'other:thing'], sessions, null)).toEqual(['session:gone'])
  })
})

describe('sameKeys', () => {
  it('compares by value and order', () => {
    expect(sameKeys(['a', 'b'], ['a', 'b'])).toBe(true)
    expect(sameKeys(['a', 'b'], ['b', 'a'])).toBe(false)
    expect(sameKeys(['a'], ['a', 'b'])).toBe(false)
  })
})
