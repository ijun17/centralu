import { describe, expect, it } from 'vitest'
import { SessionManager } from './manager.js'
import { Store } from '../dev-services/store.js'
import type { AgentAdapter } from '../adapters/contract.js'

/**
 * 유령 세션 회귀 테스트 (M2.5 도그푸딩에서 발견).
 *
 * 어댑터 생성 실패 시 세션 레코드가 먼저 저장돼 있으면, 목록에는 보이지만
 * 말을 걸 수 없는 세션이 DB에 쌓인다 (실제로 19개가 쌓였다).
 */
const failingAdapter: AgentAdapter = {
  tool: 'claude',
  capabilities: { approvals: true, contextUsage: 'exact', resume: true, listExternal: false, autoTitle: true, attachments: [] },
  detect: async () => ({ tool: 'claude', installed: true, loggedIn: true, detail: 'test' }),
  createSession: async () => {
    throw new Error('Native CLI binary for darwin-arm64 not found')
  },
}

describe('세션 생성 실패', () => {
  it('어댑터가 실패하면 세션이 저장되지 않는다 (유령 세션 방지)', async () => {
    const store = new Store()
    const mgr = new SessionManager(store, new Map([['claude', failingAdapter]]), () => {})
    await mgr.addProject('/tmp')

    const project = (await mgr.listProjects())[0]!
    await expect(
      mgr.createSession({ projectId: project.id, cwd: '/tmp', tool: 'claude', permissionPreset: 'normal' }),
    ).rejects.toThrow('시작하지 못했습니다')

    expect(mgr.listSessions()).toHaveLength(0)
    expect(store.listSessions()).toHaveLength(0)
    store.close()
  })

  it('실패 이유가 그대로 전달된다 (사용자가 원인을 알아야 고친다)', async () => {
    const store = new Store()
    const mgr = new SessionManager(store, new Map([['claude', failingAdapter]]), () => {})
    await mgr.addProject('/tmp')
    const project = (await mgr.listProjects())[0]!
    await expect(
      mgr.createSession({ projectId: project.id, cwd: '/tmp', tool: 'claude', permissionPreset: 'normal' }),
    ).rejects.toThrow('Native CLI binary')
    store.close()
  })
})
