import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@cc/core'
import { groupProjectAppSessions, orderAsTree } from './tree.js'

const s = (id: string, over: Partial<SessionSummary> = {}) => ({ id, parentSessionId: null, askedBy: null, ...over }) as SessionSummary
const shape = (list: SessionSummary[]) => orderAsTree(list).map(({ s, nested }) => (nested ? `  ${s.id}` : s.id))

/** The sidebar groups a session's children under it by who started them (owner decision 2026-10-12, #561) */
describe('orderAsTree', () => {
  it('nests every start_agent child under its parent, in its folder or a worktree, in list order', () => {
    expect(
      shape([
        s('parent'),
        s('other'),
        s('same-folder', { askedBy: 'parent' }),
        s('worktree', { askedBy: 'parent', parentSessionId: 'parent' }),
        s('mine-too', { askedBy: 'other' }),
      ]),
    ).toEqual(['parent', '  same-folder', '  worktree', 'other', '  mine-too'])
  })

  it('keeps a former manager\'s worktree sessions under it, by parentSessionId', () => {
    expect(shape([s('mgr'), s('wt', { parentSessionId: 'mgr' })])).toEqual(['mgr', '  wt'])
  })

  it('leaves at the top level a session asked by another project, one whose parent is gone, and a grandchild', () => {
    expect(
      shape([
        s('asked', { askedBy: 'a-session-of-another-project' }),
        s('orphan', { askedBy: 'deleted' }),
        s('root'),
        s('child', { askedBy: 'root' }),
        s('grandchild', { askedBy: 'child' }),
      ]),
    ).toEqual(['asked', 'orphan', 'root', '  child', 'grandchild'])
  })

  it('puts listed project-app sessions under their app and leaves a removed app in the project tree', () => {
    const grouped = groupProjectAppSessions(
      [
        s('ordinary'),
        s('builder', { appId: 'notes' }),
        s('app-agent', { appId: 'notes' }),
        s('started-agent', { askedBy: 'ordinary' }),
        s('worktree', { parentSessionId: 'ordinary' }),
        s('removed-app-agent', { appId: 'gone' }),
      ],
      ['notes'],
    )

    expect(grouped.byApp.get('notes')?.map((session) => session.id)).toEqual(['builder', 'app-agent'])
    expect(shape(grouped.project)).toEqual(['ordinary', '  started-agent', '  worktree', 'removed-app-agent'])
  })
})
