import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { SessionManager } from './manager.js'
import { Store } from '../dev-services/store.js'
import type { AgentAdapter } from '../adapters/contract.js'

/**
 * A regression test for ghost sessions (found during M2.5 dogfooding).
 *
 * If the session record was already saved before the adapter's creation failed, a session
 * accumulates in the DB that shows up in the list but cannot be talked to (19 of them actually
 * piled up in practice).
 */
const failingAdapter: AgentAdapter = {
  tool: 'claude',
  descriptor: { name: 'claude', label: 'Claude Code', mark: 'C', install: 'npm i -g x', login: 'x login' },
  capabilities: { approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: false, backgroundTasks: false },
  detect: async () => ({ tool: 'claude', installed: true, loggedIn: true, detail: 'test' }),
  createSession: async () => {
    throw new Error('Native CLI binary for darwin-arm64 not found')
  },
}

describe('session creation failure', () => {
  it('a session is not saved if the adapter fails (preventing ghost sessions)', async () => {
    const store = new Store()
    const mgr = new SessionManager(store, new Map([['claude', failingAdapter]]), () => {})
    await mgr.addProject(tmpdir())

    const project = (await mgr.listProjects())[0]!
    await expect(
      mgr.createSession({ projectId: project.id, cwd: tmpdir(), tool: 'claude', permissionPreset: 'normal' }),
    ).rejects.toThrow('Could not start')

    expect(mgr.listSessions()).toHaveLength(0)
    expect(store.listSessions()).toHaveLength(0)
    store.close()
  })

  it('the failure reason is passed through as-is (the user needs to know the cause to fix it)', async () => {
    const store = new Store()
    const mgr = new SessionManager(store, new Map([['claude', failingAdapter]]), () => {})
    await mgr.addProject(tmpdir())
    const project = (await mgr.listProjects())[0]!
    await expect(
      mgr.createSession({ projectId: project.id, cwd: tmpdir(), tool: 'claude', permissionPreset: 'normal' }),
    ).rejects.toThrow('Native CLI binary')
    store.close()
  })
})
