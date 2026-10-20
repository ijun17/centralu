import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@cc/core'
import { appSessionsNeedAttention, groupProjectAppSessions, orderAsTree, treeRows } from './tree.js'

const s = (id: string, over: Partial<SessionSummary> = {}) => ({ id, parentSessionId: null, askedBy: null, ...over }) as SessionSummary
const shape = (list: SessionSummary[]) => orderAsTree(list).map(({ s, depth }) => `${'  '.repeat(depth)}${s.id}`)

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

  it('hangs a fork under the session it was copied from, not under the session that asked for it (#677)', () => {
    expect(
      shape([
        s('busy'),
        s('asker'),
        s('fork', { askedBy: 'asker', forkedFrom: 'busy' }),
        s('worktree-fork', { askedBy: 'asker', parentSessionId: 'asker', forkedFrom: 'busy' }),
      ]),
    ).toEqual(['busy', '  fork', '  worktree-fork', 'asker'])
  })

  it('keeps a former manager\'s worktree sessions under it, by parentSessionId', () => {
    expect(shape([s('mgr'), s('wt', { parentSessionId: 'mgr' })])).toEqual(['mgr', '  wt'])
  })

  it('leaves at the top level a session asked by another project and one whose parent is gone', () => {
    expect(
      shape([
        s('asked', { askedBy: 'a-session-of-another-project' }),
        s('orphan', { askedBy: 'deleted' }),
        s('root'),
        s('child', { askedBy: 'root' }),
      ]),
    ).toEqual(['asked', 'orphan', 'root', '  child'])
  })

  // #1416: a linked machine's project lists its child without the parent, which stands in another machine's project
  it('leaves at the top level a child whose asker is on another machine, with its own children under it', () => {
    expect(
      shape([
        s('m1.child', { askedBy: 'hub-parent' }),
        s('m1.grandchild', { askedBy: 'm1.child' }),
        s('m1.other'),
      ]),
    ).toEqual(['m1.child', '  m1.grandchild', 'm1.other'])
  })

  it('hangs a child\'s own children one step further in, not at the top level beside their grandparent (#862)', () => {
    expect(
      shape([
        s('orchestrator'),
        s('grandchild', { askedBy: 'area-c', parentSessionId: 'area-c' }),
        s('area-c', { askedBy: 'orchestrator', parentSessionId: 'orchestrator' }),
        s('area-d', { askedBy: 'orchestrator' }),
        s('great-grandchild', { askedBy: 'grandchild' }),
      ]),
    ).toEqual(['orchestrator', '  area-c', '    grandchild', '      great-grandchild', '  area-d'])
  })

  it('draws every session once even if the links make a loop, after the sessions that hang under nothing', () => {
    expect(shape([s('a', { askedBy: 'b' }), s('b', { askedBy: 'a' }), s('c')])).toEqual(['c', 'a', '  b'])
  })

  it('puts listed project-app sessions under their app and leaves a removed app in the project tree', () => {
    const grouped = groupProjectAppSessions(
      [
        s('ordinary'),
        s('builder', { appId: 'notes' }),
        s('builder-child', { appId: 'notes', askedBy: 'builder' }),
        s('app-agent', { appId: 'notes' }),
        s('started-agent', { askedBy: 'ordinary' }),
        s('worktree', { parentSessionId: 'ordinary' }),
        s('removed-app-agent', { appId: 'gone' }),
      ],
      ['notes'],
    )

    expect(grouped.byApp.get('notes')?.map((session) => session.id)).toEqual(['builder', 'builder-child', 'app-agent'])
    expect(shape(grouped.byApp.get('notes') ?? [])).toEqual(['builder', '  builder-child', 'app-agent'])
    expect(shape(grouped.project)).toEqual(['ordinary', '  started-agent', '  worktree', 'removed-app-agent'])
  })

  it('marks only an approval or pending question as an app session waiting on the person', () => {
    expect(appSessionsNeedAttention([s('finished', { state: 'waiting_input', pendingQuestions: [] })])).toBe(false)
    expect(appSessionsNeedAttention([s('approval', { state: 'waiting_approval', pendingQuestions: [] })])).toBe(true)
    expect(appSessionsNeedAttention([s('question', { state: 'idle', pendingQuestions: [{ requestId: 'question', questions: [] }] })])).toBe(true)
  })
})

/** A folded parent keeps its row and its children's count; the children leave the rows (#666) */
describe('treeRows', () => {
  const list = [s('parent'), s('kid-1', { askedBy: 'parent' }), s('kid-2', { parentSessionId: 'parent' }), s('plain')]
  const rowsOf = (sessions: SessionSummary[], folded: string[]) =>
    treeRows(sessions, (id) => folded.includes(id)).map((r) => `${'  '.repeat(r.depth)}${r.s.id}${r.children.length ? `(${r.children.length}${r.folded ? ' folded' : ''})` : ''}`)
  const shapeRows = (folded: string[]) => rowsOf(list, folded)

  it('lists the children under an open parent, with their count on the parent', () => {
    expect(shapeRows([])).toEqual(['parent(2)', '  kid-1', '  kid-2', 'plain'])
  })

  it('leaves the children out of a folded parent but keeps them countable', () => {
    expect(shapeRows(['parent'])).toEqual(['parent(2 folded)', 'plain'])
  })

  it('folds nothing for a session that has no children', () => {
    expect(shapeRows(['plain', 'kid-1'])).toEqual(['parent(2)', '  kid-1', '  kid-2', 'plain'])
  })

  const deep = [s('top'), s('mid', { askedBy: 'top' }), s('leaf', { askedBy: 'mid' }), s('next', { askedBy: 'top' })]

  it('gives each row its own children, a grandchild under its parent (#862)', () => {
    expect(rowsOf(deep, [])).toEqual(['top(2)', '  mid(1)', '    leaf', '  next'])
  })

  it('hides everything under a folded row, its children\'s children too', () => {
    expect(rowsOf(deep, ['top'])).toEqual(['top(2 folded)'])
    expect(rowsOf(deep, ['mid'])).toEqual(['top(2)', '  mid(1 folded)', '  next'])
  })
})
