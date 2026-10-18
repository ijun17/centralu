import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionLiveDefaults, type SessionInfo } from '@cc/protocol'
import type { LinkedSessions, OrchestratedSession } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { eventually } from '../../../../tooling/test-timing.js'
import { ChildOwnership } from './child-ownership.js'
import { RemoteAgents, REMOTE_AGENTS_KEY, type RemoteAgentsHost } from './remote-agents.js'

/**
 * A child on a linked machine as the hub follows it (#1038), over a stand-in for the link that answers what the test
 * says: what the hub knows after a restart, and a link that drops before the hub saw the child's turn start. The real
 * link is in links.test.ts.
 */
let store: Store
let children: ChildOwnership
let state: string
let settled: string[]
let told: string[]
let restored: string[]

const caller = { id: 'h1', name: 'Parent', projectId: 'p1', kind: 'worker', permissionPreset: 'normal', ...sessionLiveDefaults() } as unknown as SessionInfo
const child = { sessionId: 'm1.c1', callerId: 'h1', machineId: 'm1', machine: 'Box', name: 'Child', tool: 'claude', project: 'app', startedAt: 1 }

function agents(): RemoteAgents {
  const reader = {
    read: async () => ({ ok: true, state, lines: [] }),
    list: async (): Promise<OrchestratedSession[]> => [{ sessionId: child.sessionId, name: 'Child', project: 'app', state, tool: 'claude', preview: '', machine: 'Box' }],
    machineLinked: () => true,
    lastWords: async () => 'done there',
  } as unknown as LinkedSessions
  const host = {
    children,
    store,
    linkedReader: reader,
    meta: new Map([[caller.id, caller]]),
    settleLinkedTurn: (id: string) => settled.push(id),
    linkedTasksRunning: () => [],
    tellSession: async (_to: string, text: string) => void told.push(text),
    linkedReportRestored: (id: string) => restored.push(id),
  } as unknown as RemoteAgentsHost
  return new RemoteAgents(host, { agentCeilingError: () => null, reservePlace: () => ({ release: () => {} }) })
}

beforeEach(() => {
  store = new Store()
  children = new ChildOwnership(store)
  store.settings.setAppSetting(REMOTE_AGENTS_KEY, JSON.stringify([child]))
  state = 'working'
  settled = []
  told = []
  restored = []
})
afterEach(() => store.close())

describe('what is owed of a child on a linked machine, across a hub restart (#1038)', () => {
  const stored = () => JSON.parse(store.settings.appSetting(REMOTE_AGENTS_KEY) ?? '[]') as { sessionId: string; owed?: { paused?: unknown[] } }[]
  const task = { id: 't1', description: 'build', status: 'running' } as never

  it('keeps in the record whether its report is owed and what it is paused over, as the report changes', () => {
    // As the host starts: restored, which also hooks the record to its report
    agents().restore()
    children.setLinkedReport(child.sessionId, { orchestratorId: 'h1', busy: false })
    expect(stored()[0]!.owed).toEqual({})
    children.setLinkedReport(child.sessionId, { orchestratorId: 'h1', busy: false, paused: [task] })
    expect(stored()[0]!.owed).toEqual({ paused: [task] })
    children.dropLinkedReport(child.sessionId)
    expect(stored()[0]!.owed).toBeUndefined()
  })

  it('owes it again after a restart: read once the link is up, a paused one waiting on its work, nothing for a caller gone', async () => {
    store.settings.setAppSetting(REMOTE_AGENTS_KEY, JSON.stringify([
      { ...child, owed: {} },
      { ...child, sessionId: 'm1.c2', owed: { paused: [task] } },
      { ...child, sessionId: 'm1.c3', callerId: 'gone', owed: {} },
    ]))
    const ra = agents()
    ra.restore()
    expect([...children.linkedReports.keys()]).toEqual(['m1.c1', 'm1.c2'])
    expect(restored).toEqual(['m1.c2'])
    expect(stored().find((r) => r.sessionId === 'm1.c3')!.owed).toBeUndefined()
    // The link comes up and the child is at rest: its turn ended unseen, so its report goes now
    state = 'idle'
    ra.observe({ type: 'machine_resync', machineId: 'm1' })
    await eventually(() => settled.includes('m1.c1'))
    expect(settled).not.toContain('m1.c2')
  })
})

describe('a child on a linked machine, as the hub follows it (#1038 review)', () => {
  // After a hub restart nothing is armed or waited on: the state is the machine's, not "finished"
  it("lists the child's state as its machine reports it, not as what the hub happens to hold", async () => {
    const ra = agents()
    expect(await ra.rows('h1')).toEqual([expect.objectContaining({ sessionId: child.sessionId, state: 'working', machine: 'Box' })])
    state = 'waiting_approval'
    expect(await ra.rows('h1')).toEqual([expect.objectContaining({ state: 'waiting' })])
    state = 'idle'
    expect(await ra.rows('h1')).toEqual([expect.objectContaining({ state: 'finished' })])
  })

  // A drop before the first event of the turn left it unseen as busy, and its end while the link was down never reported
  it('reports a turn that ended while the link was down, when a call was waiting on it and had not seen it start', async () => {
    const ra = agents()
    children.setLinkedReport(child.sessionId, { orchestratorId: 'h1', busy: false })
    const waiting = ra.agentSession('h1', ra.of(child.sessionId)!, { sessionId: child.sessionId, action: 'wait' })
    await eventually(() => !children.linkedReports.has(child.sessionId))
    ra.observe({ type: 'machine_status', machine: { id: 'm1', name: 'Box', status: 'unreachable' } })
    expect(await waiting).toMatchObject({ ok: true, state: 'working', notice: expect.stringContaining('The link to Box dropped') })
    // The turn ended there meanwhile; the link comes back
    state = 'idle'
    ra.observe({ type: 'machine_resync', machineId: 'm1' })
    await eventually(() => settled.length === 1)
    expect(settled).toEqual([child.sessionId])
  })
})
