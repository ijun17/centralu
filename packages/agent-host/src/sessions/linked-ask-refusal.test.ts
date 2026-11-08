import { afterEach, describe, expect, it } from 'vitest'
import { sessionLiveDefaults, type SessionInfo } from '@cc/protocol'
import { NOT_CONNECTED, NOT_CONNECTED_PHRASE, NOT_REACHABLE, type LinkedSessions } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { scriptedAdapters } from '../links/scripted-agent.test-helpers.js'
import { removeTree, tempRoot } from '../temp-dir.test-helpers.js'
import { SessionManager } from './manager.js'

/**
 * The refusal of ask_project to a project on a linked machine when no session is named (#1143 row 3): it lists the sessions
 * with when each last moved, as an ask here does. The times are a separate read of the machine, made only for that refusal,
 * so an ask that goes through never waits for it (linked-sessions.test.ts guards that, on the real reader). And every
 * refusal an agent gets for a machine that is down ends with when to try again: once the person has connected one they
 * disconnected (#1143). The machine here is a stand-in; links.test.ts runs the real one.
 */

const cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c()
})

async function hub(away?: string) {
  const store = new Store()
  const path = tempRoot('cc-ask-refusal-')
  cleanup.push(() => removeTree(path))
  store.projects.addProject({ id: 'p-hub', path, name: 'hub-project' })
  const session = (s: Pick<SessionInfo, 'id' | 'projectId' | 'kind' | 'name'>) =>
    store.sessions.upsertSession({
      ...s, tool: 'claude', externalId: `ext-${s.id}`, autoNamed: false,
      state: 'idle', lastReadSeq: 0, lastSeq: 0, createdAt: 1, waitingSince: null, live: false, model: null, effort: null, verbosity: null,
      serviceTier: null, permissionPreset: 'normal', importedFrom: null, worktree: null, parentSessionId: null, scopeSessionIds: null,
      roleAppend: null, appId: null, ...sessionLiveDefaults(),
    })
  session({ id: 'h1', projectId: 'p-hub', kind: 'worker', name: 'Asker' })
  session({ id: 'orch', projectId: null, kind: 'orchestrator', name: 'Assistant' })
  const mgr = new SessionManager(store, scriptedAdapters(), () => {})
  await mgr.setProjectTrusted('p-hub', true)
  // A checkout, whose origin start_agent with a machine looks for there
  ;(mgr as unknown as { files: { projectOrigin: () => Promise<string> } }).files.projectOrigin = async () => 'git@github.com:me/api.git'
  let movedReads = 0
  const project = { id: 'm1.p-api', name: 'api', path: '/api', defaultTool: null, machine: 'Box', machineId: 'm1', trusted: true, ...(away ? { away } : {}) }
  const reader = {
    machineOf: (id: string) => (id.startsWith('m1.') ? 'Box' : null),
    machineNamed: (name: string) => (name === 'Box' ? { id: 'm1', name } : null),
    projects: async () => ({ projects: [project], away: away ? [{ machineId: 'm1', machine: 'Box', why: away }] : [], machines: [{ machine: 'Box', machineId: 'm1' }] }),
    projectSessions: async () => ({ ok: true as const, sessions: [{ id: 'm1.w1', name: 'Worker', state: 'idle' }, { id: 'm1.w2', name: 'Other', state: 'idle' }] }),
    sessionsMoved: async () => {
      movedReads++
      return { 'm1.w1': '2026-01-02 03:04' }
    },
    describe: () => ({ name: 'Worker', project: 'api on Box' }),
    lastWords: async () => ({ ok: true as const, text: 'done', length: 4, seq: 1 }),
    machineLinked: () => true,
    machineWaitsForPerson: () => false,
    backgroundTasks: async () => [],
  } as unknown as LinkedSessions
  mgr.useLinkedReader(reader)
  // A hub linked to this computer, down as the machine is (#550)
  const hubProject = { id: 'h9.p-web', projectId: 'p-web', name: 'web', hub: 'Desk', hubId: 'h9', ...(away ? { away } : {}) }
  mgr.useLinkedHubs({ projects: async () => ({ projects: [hubProject], away: [] }), ask: () => Promise.reject(new Error('asked a hub that is down')) })
  cleanup.push(() => void mgr.tenure.disposeAll())
  return { mgr, reader, movedReads: () => movedReads }
}

describe('ask_project to a linked machine, when the session is not named', () => {
  it('lists the sessions with when each last moved', async () => {
    const h = await hub()
    const r = await h.mgr.askProject('h1', { project: 'm1/api', session: 'missing', task: 'export' })
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('{"id":"m1.w1","name":"Worker","state":"idle","lastActive":"2026-01-02 03:04"}') })
    expect(r).toMatchObject({ error: expect.stringContaining('{"id":"m1.w2","name":"Other","state":"idle","lastActive":null}') })
    expect(h.movedReads()).toBe(1)
  })
})

describe('a refusal for a machine that is down says when to try again (#1143)', () => {
  /** ask_project of a project named nowhere and of a hub's project, start_agent with the machine, and the Assistant's create_session */
  const refusals = async (away: string) => {
    const { mgr } = await hub(away)
    const error = (r: unknown) => (r as { error?: string }).error ?? (r as { text: string }).text
    return [
      error(await mgr.askProject('h1', { project: 'm1/never-seen', task: 'x' })),
      error(await mgr.askProject('h1', { project: 'h9/web', task: 'x' })),
      error(await mgr.startAgent('h1', { task: 'x', machine: 'Box' })),
      error(await mgr.runCentraluTool('orch', 'create_session', { project: 'm1/api' })),
      error(await mgr.runCentraluTool('orch', 'create_session', { project: 'm1/never-seen' })),
    ]
  }

  it('one the person disconnected: once the person has connected it', async () => {
    const after = 'Try again once the person has connected it.'
    expect(await refusals(NOT_CONNECTED)).toEqual([
      `Box ${NOT_CONNECTED_PHRASE}, so "m1/never-seen" cannot be asked there. ${after}`,
      `Desk ${NOT_CONNECTED_PHRASE}, so web on Desk cannot be asked. ${after}`,
      `Box ${NOT_CONNECTED_PHRASE}, so nothing was started there. ${after}`,
      `Could not create it — api [m1.p-api] is on Box, which ${NOT_CONNECTED_PHRASE}. ${after}`,
      `Could not create it — Box ${NOT_CONNECTED_PHRASE}, so "m1/never-seen" cannot be created there. ${after}`,
    ])
  })

  // The person disconnected it after its projects were listed, before start_agent read their origin
  it('start_agent: one disconnected between the list and the read says so', async () => {
    const { mgr, reader } = await hub()
    Object.assign(reader, { origin: async () => ({ ok: false, error: `Box ${NOT_CONNECTED_PHRASE}` }) })
    expect(await mgr.startAgent('h1', { task: 'x', machine: 'Box' })).toMatchObject({
      ok: false,
      error: `Box ${NOT_CONNECTED_PHRASE}, so nothing was started there. Try again once the person has connected it.`,
    })
  })

  it('one whose link dropped: once its link is back', async () => {
    const after = 'Try again once its link is back.'
    expect(await refusals(NOT_REACHABLE)).toEqual([
      `Box is ${NOT_REACHABLE}, so "m1/never-seen" cannot be asked there. ${after}`,
      `Desk is ${NOT_REACHABLE}, so web on Desk cannot be asked. ${after}`,
      `Box is ${NOT_REACHABLE}, so nothing was started there. ${after}`,
      `Could not create it — api [m1.p-api] is on Box, which is ${NOT_REACHABLE}. ${after}`,
      `Could not create it — Box is ${NOT_REACHABLE}, so "m1/never-seen" cannot be created there. ${after}`,
    ])
  })
})
