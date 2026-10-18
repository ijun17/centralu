import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@cc/core'
import { projectLabelOf, sidebarProjectOf } from './selectors.js'
import { openProjectOf } from './screens.js'

describe('sidebarProjectOf (#1038)', () => {
  const s = (id: string, projectId: string | null, over: Partial<SessionSummary> = {}) => ({ id, projectId, askedBy: null, machine: null, ...over }) as SessionSummary
  const all = (...list: SessionSummary[]) => Object.fromEntries(list.map((x) => [x.id, x]))

  it("stands a child started on another machine under its parent's project, and what that child started with it", () => {
    const parent = s('h1', 'p-hub')
    const child = s('m1.c1', 'm1.p-app', { machine: 'm1', askedBy: 'h1' })
    const grandchild = s('m1.c2', 'm1.p-app', { machine: 'm1', askedBy: 'm1.c1' })
    const sessions = all(parent, child, grandchild)
    expect(sidebarProjectOf(child, sessions)).toBe('p-hub')
    expect(sidebarProjectOf(grandchild, sessions)).toBe('p-hub')
    // With its parent gone from the list, it stands in its own machine's project
    expect(sidebarProjectOf(child, all(child))).toBe('m1.p-app')
  })

  it('keeps a session in its own project otherwise: ask_project on the same machine, a local child, a loop', () => {
    const asker = s('a', 'p1')
    const asked = s('b', 'p2', { askedBy: 'a' })
    const child = s('c', 'p1', { askedBy: 'a' })
    expect(sidebarProjectOf(asked, all(asker, asked))).toBe('p2')
    expect(sidebarProjectOf(child, all(asker, child))).toBe('p1')
    const x = s('m1.x', 'm1.p', { machine: 'm1', askedBy: 'y' })
    const y = s('y', 'p', { askedBy: 'm1.x' })
    // It ends where the loop closes, at the last session before it
    expect(sidebarProjectOf(x, all(x, y))).toBe('p')
  })
})

describe('openProjectOf (#1038)', () => {
  it('tints the project a child started on another machine stands under, not the machine’s own', () => {
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
    expect(openProjectOf(state as never)).toBe('p-hub')
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
