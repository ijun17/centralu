import { afterEach, describe, expect, it } from 'vitest'
import { sessionLiveDefaults } from '@cc/protocol'
import { eventually } from '../../../../tooling/test-timing.js'
import type { LinkedSessions } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { scriptedAdapters } from '../links/scripted-agent.test-helpers.js'
import { removeTree, tempRoot } from '../temp-dir.test-helpers.js'
import { SessionManager } from './manager.js'

/**
 * The refusal of ask_project to a project on a linked machine when no session is named (#1143 row 3): it lists the sessions
 * with when each last moved, as an ask here does. The times are a separate read of the machine, made only for that refusal,
 * so an ask that goes through never waits for it. The machine here is a stand-in; links.test.ts runs the real one.
 */

const cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c()
})

async function hub() {
  const store = new Store()
  const path = tempRoot('cc-ask-refusal-')
  cleanup.push(() => removeTree(path))
  store.projects.addProject({ id: 'p-hub', path, name: 'hub-project' })
  store.sessions.upsertSession({
    id: 'h1', projectId: 'p-hub', kind: 'worker', tool: 'claude', externalId: 'ext-h1', name: 'Asker', autoNamed: false,
    state: 'idle', lastReadSeq: 0, lastSeq: 0, createdAt: 1, waitingSince: null, live: false, model: null, effort: null, verbosity: null,
    serviceTier: null, permissionPreset: 'normal', importedFrom: null, worktree: null, parentSessionId: null, scopeSessionIds: null,
    roleAppend: null, appId: null, ...sessionLiveDefaults(),
  })
  const mgr = new SessionManager(store, scriptedAdapters(), () => {})
  await mgr.setProjectTrusted('p-hub', true)
  let movedReads = 0
  let sent = 0
  const project = { id: 'm1.p-api', name: 'api', path: '/api', defaultTool: null, machine: 'Box', machineId: 'm1', trusted: true }
  const reader = {
    machineOf: (id: string) => (id.startsWith('m1.') ? 'Box' : null),
    projects: async () => ({ projects: [project], away: [] }),
    projectSessions: async () => ({ ok: true as const, sessions: [{ id: 'm1.w1', name: 'Worker', state: 'idle' }, { id: 'm1.w2', name: 'Other', state: 'idle' }] }),
    sessionsMoved: async () => {
      movedReads++
      return { 'm1.w1': '2026-01-02 03:04' }
    },
    send: async () => {
      sent++
      return { ok: true as const }
    },
    describe: () => ({ name: 'Worker', project: 'api on Box' }),
    lastWords: async () => ({ ok: true as const, text: 'done', length: 4, seq: 1 }),
    machineLinked: () => true,
    machineWaitsForPerson: () => false,
    backgroundTasks: async () => [],
  } as unknown as LinkedSessions
  mgr.useLinkedReader(reader)
  cleanup.push(() => void mgr.disposeAll())
  return { mgr, movedReads: () => movedReads, sent: () => sent }
}

describe('ask_project to a linked machine, when the session is not named', () => {
  it('lists the sessions with when each last moved', async () => {
    const h = await hub()
    const r = await h.mgr.askProject('h1', { project: 'm1/api', session: 'missing', task: 'export' })
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('{"id":"m1.w1","name":"Worker","state":"idle","lastActive":"2026-01-02 03:04"}') })
    expect(r).toMatchObject({ error: expect.stringContaining('{"id":"m1.w2","name":"Other","state":"idle","lastActive":null}') })
    expect(h.movedReads()).toBe(1)
  })

  it('does not read the times for an ask that goes through', async () => {
    const h = await hub()
    const call = h.mgr.askProject('h1', { project: 'm1/api', session: 'm1.w1', task: 'export' })
    await eventually(() => !!h.mgr.listSessions().find((s) => s.id === 'h1')?.pendingApproval)
    h.mgr.respondApproval('h1', h.mgr.listSessions().find((s) => s.id === 'h1')!.pendingApproval!.requestId, 'allow')
    // The task has gone in; the call itself answers when the machine's turn ends, which this stand-in never says
    await eventually(() => h.sent() > 0)
    expect(h.movedReads()).toBe(0)
    void call
  })
})
