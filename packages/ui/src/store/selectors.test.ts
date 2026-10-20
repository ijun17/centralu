import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@cc/core'
import { computeInbox, projectLabelOf, sessionFolderOf } from './selectors.js'
import { openProjectOf } from './screens.js'
import { handedOffBy } from './sidebarTree.js'

describe('openProjectOf (#1416)', () => {
  it('tints the project that holds a child started on another machine, not its parent’s', () => {
    const parent = { id: 'h1', projectId: 'p-hub', askedBy: null, machine: null } as unknown as SessionSummary
    const child = { id: 'm1.c1', projectId: 'm1.p-app', askedBy: 'h1', machine: 'm1' } as unknown as SessionSummary
    const state = {
      view: 'focus' as const,
      focusedSessionId: 'm1.c1',
      focusedProjectId: 'm1.p-app',
      focusedApp: null,
      projects: { 'p-hub': {}, 'm1.p-app': {} },
      sessions: { h1: parent, 'm1.c1': child },
    }
    expect(openProjectOf(state as never)).toBe('m1.p-app')
  })
})

describe('handedOffBy (#1416)', () => {
  const s = (id: string, projectId: string | null, over: Partial<SessionSummary> = {}) => ({ id, projectId, askedBy: null, machine: null, ...over }) as SessionSummary
  const all = (...list: SessionSummary[]) => Object.fromEntries(list.map((x) => [x.id, x]))

  it('groups what a session started on other machines by machine, and leaves out what it started on its own', () => {
    const parent = s('h1', 'p-hub')
    const far1 = s('m1.a', 'm1.p', { machine: 'm1', askedBy: 'h1' })
    const far2 = s('m1.b', 'm1.q', { machine: 'm1', askedBy: 'h1' })
    const other = s('m2.c', 'm2.p', { machine: 'm2', askedBy: 'h1' })
    const local = s('l1', 'p-hub', { askedBy: 'h1' })
    const sessions = all(parent, far1, far2, other, local)
    expect(handedOffBy('h1', sessions)).toEqual([
      { machine: 'm1', sessions: [far1, far2] },
      { machine: 'm2', sessions: [other] },
    ])
    // Nothing for a session that started nothing elsewhere, and not for the child's own parent chain
    expect(handedOffBy('l1', sessions)).toEqual([])
    expect(handedOffBy('m1.a', sessions)).toEqual([])
  })

  it('reads a session on a linked machine that started a child on that same machine as its own, not handed off', () => {
    const parent = s('m1.p1', 'm1.p', { machine: 'm1' })
    const child = s('m1.c1', 'm1.p', { machine: 'm1', askedBy: 'm1.p1' })
    expect(handedOffBy('m1.p1', all(parent, child))).toEqual([])
  })

  it('follows the sessions it is given, not the first it was asked about', () => {
    const parent = s('h1', 'p')
    const far = s('m1.a', 'm1.p', { machine: 'm1', askedBy: 'h1' })
    expect(handedOffBy('h1', all(parent, far))).toHaveLength(1)
    expect(handedOffBy('h1', all(parent))).toEqual([])
  })
})

describe('projectLabelOf', () => {
  const projects = { p1: { name: 'alpha' } }

  it('is the project name', () => {
    expect(projectLabelOf(projects, 'p1')).toBe('alpha')
  })

  it('names the orchestrator, which has no project', () => {
    expect(projectLabelOf(projects, null)).toBe('Orchestrator')
  })

  it('says nothing for a project the list does not hold yet', () => {
    expect(projectLabelOf(projects, 'gone')).toBe('')
  })
})

describe('sessionFolderOf (#1209)', () => {
  const projects = { p1: { path: '/repo' } } as never
  const sessions = {
    plain: { id: 'plain', projectId: 'p1', worktree: null },
    wt: { id: 'wt', projectId: 'p1', worktree: { path: '/wt/s1', branch: 'centralu/s1' } },
    orch: { id: 'orch', projectId: null, worktree: null },
  } as never

  it("is a worktree session's worktree, and the project's folder for a session without one", () => {
    expect(sessionFolderOf({ sessions, projects }, 'wt')).toBe('/wt/s1')
    expect(sessionFolderOf({ sessions, projects }, 'plain')).toBe('/repo')
  })

  it('is null for a session with no project, and for one not in the list', () => {
    expect(sessionFolderOf({ sessions, projects }, 'orch')).toBeNull()
    expect(sessionFolderOf({ sessions, projects }, 'gone')).toBeNull()
  })
})

describe('computeInbox: a question', () => {
  const q = (state: SessionSummary['state'], over: Partial<SessionSummary> = {}) =>
    ({ id: 'q', projectId: 'p', name: 'api', state, waitingSince: null, lastSeq: 3, lastReadSeq: 3, pendingQuestions: [{}], interruption: null, ...over }) as unknown as SessionSummary
  const list = (s: SessionSummary) => computeInbox({ sessions: { [s.id]: s }, mcpProposals: [], skillProposals: [], appArrivals: [] } as never, 0)

  it('is listed as an approval is, marked as a question the person answers', () => {
    expect(list(q('working'))).toMatchObject([{ id: 'q', state: 'waiting_approval', asking: true }])
    expect(list(q('waiting_approval'))).toMatchObject([{ state: 'waiting_approval', asking: true }])
  })

  it('leaves an error as an error, and an approval without a question unmarked', () => {
    expect(list(q('error'))).toMatchObject([{ state: 'error' }])
    expect(list(q('waiting_approval', { pendingQuestions: [] }))[0]!.asking).toBe(false)
  })
})
