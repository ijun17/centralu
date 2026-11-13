import { afterEach, describe, expect, it } from 'vitest'
import * as kit from '../apps/external/test-helpers.js'
import { runCleanups } from './links-world.test-helpers.js'
import { hubHost, machineHost } from './reverse-link.test-helpers.js'
import { linkedNotices } from './apps-across.js'
import { recordStartingHub } from '../sessions/hub-preset.js'
import type { RemoteAgent } from '../sessions/remote-agents.js'
import { eventually } from '../../../../tooling/test-timing.js'

/**
 * A started agent uses its parent project's apps on the hub that started it (#1938, docs/plans/remote-hub.md §13.5): it is
 * given them as its own project's, the hub decides who may reach them from its own record of the agent, and the copy its
 * checkout on the machine carries is not given to it. Real hosts in one process, wired as main.ts wires them; only the
 * transport is loopback.
 */

afterEach(runCleanups)

const text = (r: { content: unknown[] }) => r.content.map((c) => (c as { text?: string }).text ?? '').join('\n')

/** The hub's record of the agent `w1` that its session `h1` started on the machine, as start_agent writes it */
const child: RemoteAgent = { sessionId: 'm1.w1', callerId: 'h1', machineId: 'm1', machine: 'Remote box', name: 'w1', tool: 'claude', project: 'remote-project', startedAt: 1 }

/**
 * The fixture app `board` in the hub's project and, as a copy in its checkout, in the machine's; `w1` on the machine started
 * by the hub, and `w2`, which the machine records as started by it but the hub has no record of
 */
async function world(o: { hubApps?: boolean } = {}) {
  const machine = await machineHost({ sessions: ['w1', 'w2'], apps: true })
  machine.apps!.plant(kit, 'p-remote', 'board')
  const hub = await hubHost(machine.port, { ...(o.hubApps !== false ? { apps: true } : {}), children: [child] })
  await hub.mgr.setProjectTrusted('p-hub', true)
  hub.apps?.plant(kit, 'p-hub', 'board')
  await eventually(() => hub.machine().status === 'connected')
  if (o.hubApps !== false) await eventually(() => machine.hubs.appsPeer(hub.id) !== undefined)
  recordStartingHub(machine.store.settings, 'w1', { id: hub.id, name: hub.name })
  recordStartingHub(machine.store.settings, 'w2', { id: hub.id, name: hub.name })
  const attach = async (id: string) => {
    const live = machine.mgr.apps.sessionAppsHub()!.attach({ id, kind: 'worker', projectId: 'p-remote' })
    await live.ready?.()
    return live
  }
  return { machine, hub, attach }
}

const boardRuns = (host: { apps: { rt: { runs(q: { projectId: string; appId: string }): { tool: string; status: string; callerSessionId: string | null }[] } } | null }, projectId: string) =>
  host.apps!.rt.runs({ projectId, appId: 'board' })

describe("a started agent uses its parent project's apps on the hub (#1938, §13.5)", () => {
  it("is given the hub's app in place of its checkout's copy, which runs on the hub under the agent's id there", async () => {
    const { machine, hub, attach } = await world()
    const live = await attach('w1')
    // One `app-board`: the hub's. The checkout's copy is not given, so nothing here runs a second queue
    expect(live.current().map((s) => s.server)).toEqual(['app-board'])
    const r = await live.call('app-board', 'peek', {})
    expect(text(r)).toBe('peeked')
    expect(boardRuns(hub, 'p-hub')).toMatchObject([{ tool: 'peek', status: 'ok', callerSessionId: 'm1.w1' }])
    expect(boardRuns(machine, 'p-remote')).toEqual([])
    expect(machine.apps!.rt.list().find((a) => a.appId === 'board')?.status).not.toBe('running')
  })

  it("lists nothing to a session the hub has no record of starting, whatever the machine says: it keeps its own project's copy", async () => {
    const { machine, hub, attach } = await world()
    const live = await attach('w2')
    // The machine says the hub started w2; the hub's own record says not, so w2 is not given the hub's app
    expect(live.current().map((s) => s.server)).toEqual(['app-board'])
    const r = await live.call('app-board', 'peek', {})
    expect(text(r)).toBe('peeked')
    expect(boardRuns(hub, 'p-hub')).toEqual([])
    // Asked straight, the hub lists nothing for it, by its own record
    expect(await machine.hubs.appsPeer(hub.id)!.call('apps', { session: 'w2' }, 5_000)).toEqual({ apps: [] })
  })

  it("delivers the hub's app's notice to the agent that uses it, and to no other session there", async () => {
    const { machine, hub, attach } = await world()
    const live = await attach('w1')
    await live.call('app-board', 'peek', {})
    const notice = linkedNotices({ machines: hub.links })
    await notice('m1.w1', 'the queue moved', { appId: 'board', projectId: 'p-hub', name: 'Board' })
    await eventually(() => machine.store.messages.loadMessages('w1').some((m) => m.role === 'user' && JSON.stringify(m.payload).includes('the queue moved')))
    expect(machine.store.messages.loadMessages('w1').find((m) => m.role === 'user')?.payload).toMatchObject({ fromApp: { appId: 'board', name: 'Board' } })
    await expect(notice('m1.w2', 'not yours', { appId: 'board', projectId: 'p-hub', name: 'Board' })!).rejects.toThrow('does not use this app')
  })

  it('after a restart, before its hub offers again, answers that the hub is away and still withholds the copy', async () => {
    const { machine, attach } = await world()
    const first = await attach('w1')
    expect(text(await first.call('app-board', 'peek', {}))).toBe('peeked')
    // As a restarted host: nothing in memory, and no hub has offered yet; what the hub gave is read from the session's record
    machine.apps!.linked.forget('w1')
    machine.apps!.linked.usePeers(() => [])
    const live = await attach('w1')
    expect(live.current().map((s) => s.server)).toEqual(['app-board'])
    const r = await live.call('app-board', 'peek', {})
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/Hub mac is not reachable.*nothing ran/)
    expect(boardRuns(machine, 'p-remote')).toEqual([])
  })

  it('keeps its checkout copy when the hub that started it does not offer apps, and never calls it', async () => {
    const { machine, hub, attach } = await world({ hubApps: false })
    const live = await attach('w1')
    expect(live.current().map((s) => s.server)).toEqual(['app-board'])
    expect(text(await live.call('app-board', 'peek', {}))).toBe('peeked')
    expect(boardRuns(machine, 'p-remote')).toMatchObject([{ tool: 'peek', callerSessionId: 'w1' }])
    expect(hub.apps).toBeNull()
  })
})

