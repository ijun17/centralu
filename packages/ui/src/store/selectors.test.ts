import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@cc/core'
import { computeInbox, projectLabelOf, sessionFolderOf } from './selectors.js'
import { openProjectOf } from './screens.js'

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
