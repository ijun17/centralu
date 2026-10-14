import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@cc/core'
import { appGroupKey, childrenGroupKey, foldGroupsHiding } from './foldGroups.js'

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

  it('names nothing for a top-level session, a parent in another project or one that is gone', () => {
    expect(foldGroupsHiding(s('top'), all(s('top')), keyOf, listed)).toEqual([])
    const far = s('far', { askedBy: 'elsewhere' })
    expect(foldGroupsHiding(far, all(far, s('elsewhere', { projectId: 'q' })), keyOf, listed)).toEqual([])
    expect(foldGroupsHiding(far, all(far), keyOf, listed)).toEqual([])
  })
})
