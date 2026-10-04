import { describe, expect, it } from 'vitest'
import type { AgentAdapter, SessionHandle } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { SessionManager } from './manager.js'

/**
 * C-2: does an "always allow" rule survive a restart.
 * In M1, the matcher was saved as an empty string and effectively had no effect — this guards
 * against that regression.
 */

function fakeAdapter(applied: string[][]): AgentAdapter {
  return {
    tool: 'claude',
    descriptor: { name: 'claude', label: 'Claude Code', mark: 'C', install: 'npm i -g x', login: 'x login' },
    capabilities: { approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: false, backgroundTasks: false },
    detect: async () => ({ tool: 'claude', installed: true, loggedIn: true, detail: 'fake' }),
    createSession: async (opts): Promise<SessionHandle> => ({
      sessionId: opts.sessionId,
      externalId: `ext-${opts.sessionId}`,
      send: () => {},
      respondApproval: () => true,
      applyRules: (m) => void applied.push([...m]),
      interrupt: () => {},
      dispose: async () => {},
    }),
  }
}

async function setup() {
  const store = new Store()
  const applied: string[][] = []
  const mgr = new SessionManager(store, new Map([['claude', fakeAdapter(applied)]]), () => {})
  const project = await mgr.addProject(process.cwd())
  const session = await mgr.createSession({
    projectId: project.id, cwd: project.path, tool: 'claude', permissionPreset: 'normal',
  })
  return { store, mgr, applied, project, session }
}

describe('approval rules persist (C-2)', () => {
  it('saves the rule when given always + a matcher', async () => {
    const { mgr, session } = await setup()
    mgr.respondApproval(session.id, 'req-1', 'always', 'session', 'npm test*')
    // id and createdAt are used by the settings screen to show when a rule was created, for deleting it (E-4)
    expect(mgr.listApprovalRules()).toMatchObject([{ scope: 'session', matcher: 'npm test*', decision: 'allow' }])
    expect(mgr.listApprovalRules()[0]!.id).toBeGreaterThan(0)
    // Carries which session the rule belongs to — the settings screen labels each row with its owner (#183)
    expect(mgr.listApprovalRules()[0]).toMatchObject({ sessionId: session.id, projectId: null })
  })

  it('does not save it with no matcher (an empty rule is useless)', async () => {
    const { mgr, session } = await setup()
    mgr.respondApproval(session.id, 'req-1', 'always', 'session')
    expect(mgr.listApprovalRules()).toEqual([])
  })

  it('a session-scoped rule is injected only into that session', async () => {
    const { store, mgr, session, project } = await setup()
    mgr.respondApproval(session.id, 'req-1', 'always', 'session', 'ls*')

    // Simulates a host restart: a new manager is created on the same store
    const applied2: string[][] = []
    const mgr2 = new SessionManager(store, new Map([['claude', fakeAdapter(applied2)]]), () => {})
    const res = await mgr2.resumeSession(session.id)
    expect(res.resumed).toBe(true)
    expect(applied2[0]).toContain('ls*')

    // Does not leak into another session
    const other = await mgr2.createSession({
      projectId: project.id, cwd: project.path, tool: 'claude', permissionPreset: 'normal',
    })
    const otherRules = applied2[applied2.length - 1]
    expect(otherRules).not.toContain('ls*')
    expect(other.id).not.toBe(session.id)
  })

  it('a project-scoped rule also applies to a new session in the same project', async () => {
    const { store, mgr, session, project } = await setup()
    mgr.respondApproval(session.id, 'req-1', 'always', 'project', 'git status')

    const applied2: string[][] = []
    const mgr2 = new SessionManager(store, new Map([['claude', fakeAdapter(applied2)]]), () => {})
    await mgr2.createSession({
      projectId: project.id, cwd: project.path, tool: 'claude', permissionPreset: 'normal',
    })
    expect(applied2[0]).toContain('git status')
  })
})
