import { describe, expect, it } from 'vitest'
import type { AgentAdapter, SessionHandle } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { SessionManager } from './manager.js'

/**
 * C-2: '항상 허용' 규칙이 재시작 후에도 살아남는가.
 * M1에서는 매처가 빈 문자열로 저장돼 사실상 아무 효과가 없었다 — 그 회귀를 막는다.
 */

function fakeAdapter(applied: string[][]): AgentAdapter {
  return {
    tool: 'claude',
    capabilities: { approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: false },
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

describe('승인 규칙 영속 (C-2)', () => {
  it('always + matcher를 주면 규칙이 저장된다', async () => {
    const { mgr, session } = await setup()
    mgr.respondApproval(session.id, 'req-1', 'always', 'session', 'npm test*')
    // id·createdAt은 설정 화면이 규칙을 지우고 언제 만들었는지 보여주는 데 쓴다 (E-4)
    expect(mgr.listApprovalRules()).toMatchObject([{ scope: 'session', matcher: 'npm test*', decision: 'allow' }])
    expect(mgr.listApprovalRules()[0]!.id).toBeGreaterThan(0)
  })

  it('매처가 없으면 저장하지 않는다 (빈 규칙은 무용지물이므로)', async () => {
    const { mgr, session } = await setup()
    mgr.respondApproval(session.id, 'req-1', 'always', 'session')
    expect(mgr.listApprovalRules()).toEqual([])
  })

  it('세션 범위 규칙은 그 세션에만 주입된다', async () => {
    const { store, mgr, session, project } = await setup()
    mgr.respondApproval(session.id, 'req-1', 'always', 'session', 'ls*')

    // host 재시작을 흉내낸다: 같은 store로 매니저를 새로 만든다
    const applied2: string[][] = []
    const mgr2 = new SessionManager(store, new Map([['claude', fakeAdapter(applied2)]]), () => {})
    const res = await mgr2.resumeSession(session.id)
    expect(res.resumed).toBe(true)
    expect(applied2[0]).toContain('ls*')

    // 다른 세션에는 새어 나가지 않는다
    const other = await mgr2.createSession({
      projectId: project.id, cwd: project.path, tool: 'claude', permissionPreset: 'normal',
    })
    const otherRules = applied2[applied2.length - 1]
    expect(otherRules).not.toContain('ls*')
    expect(other.id).not.toBe(session.id)
  })

  it('프로젝트 범위 규칙은 같은 프로젝트의 새 세션에도 적용된다', async () => {
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
