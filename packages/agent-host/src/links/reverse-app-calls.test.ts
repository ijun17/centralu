import { afterEach, describe, expect, it } from 'vitest'
import * as kit from '../apps/external/test-helpers.js'
import { runCleanups } from './links-world.test-helpers.js'
import { hubHost, machineHost } from './reverse-link.test-helpers.js'
import { appsPeers, linkedNotices } from './apps-across.js'
import { recordStartingHub } from '../sessions/hub-preset.js'
import type { RemoteAgent } from '../sessions/remote-agents.js'
import { eventually } from '../../../../tooling/test-timing.js'

/**
 * A started agent uses its parent project's apps on the hub that started it (#1938, docs/plans/remote-hub.md §13.5): it is
 * given them as its own project's, the hub decides who may reach them from its own record of the agent, and the copy its
 * checkout on the machine carries never runs for it, whatever the hub lists. Real hosts in one process, wired as main.ts
 * wires them; only the transport is loopback.
 */

afterEach(runCleanups)

const text = (r: { content: unknown[] }) => r.content.map((c) => (c as { text?: string }).text ?? '').join('\n')

/** The hub's record of the agent `w1` that its session `h1` started on the machine, as start_agent writes it */
const child: RemoteAgent = { sessionId: 'm1.w1', callerId: 'h1', machineId: 'm1', machine: 'Remote box', name: 'w1', tool: 'claude', project: 'remote-project', startedAt: 1 }

/**
 * The fixture app `board` in the hub's project and, as a copy in its checkout, in the machine's; `w1` on the machine started
 * by the hub, `w2`, which the machine records as started by it but the hub has no record of, and `w3`, an ordinary session of
 * the machine's own
 */
async function world(o: { hubApps?: boolean } = {}) {
  const machine = await machineHost({ sessions: ['w1', 'w2', 'w3'], apps: true })
  machine.apps!.plant(kit, 'p-remote', 'board')
  const hub = await hubHost(machine.port, { ...(o.hubApps !== false ? { apps: true } : {}), children: [child] })
  await hub.mgr.setProjectTrusted('p-hub', true)
  hub.apps?.plant(kit, 'p-hub', 'board')
  await eventually(() => hub.machine().status === 'connected')
  if (o.hubApps !== false) await eventually(() => machine.hubs.appsPeer(hub.id)?.answers === true)
  // As the machine records the hub that started a session, with whether it offered its apps then
  const apps = o.hubApps !== false
  recordStartingHub(machine.store.settings, 'w1', { id: hub.id, name: hub.name, apps })
  recordStartingHub(machine.store.settings, 'w2', { id: hub.id, name: hub.name, apps })
  // As an adapter does: the session's apps are counted as it starts, before anything asks its hub (`ready` is the app tool's)
  const attach = (id: string) => machine.mgr.apps.sessionAppsHub()!.attach({ id, kind: 'worker', projectId: 'p-remote' })
  return { machine, hub, attach }
}

type World = Awaited<ReturnType<typeof world>>

const boardRuns = (host: { apps: { rt: { runs(q: { projectId: string; appId: string }): { tool: string; status: string; callerSessionId: string | null }[] } } | null }, projectId: string) =>
  host.apps!.rt.runs({ projectId, appId: 'board' })

describe("a started agent uses its parent project's apps on the hub (#1938, §13.5)", () => {
  it("is given the hub's app under the name its checkout's copy had, from its first count, and it runs on the hub under the agent's id there", async () => {
    const { machine, hub, attach } = await world()
    const live = attach('w1')
    // Counted before its hub is asked: one `app-board`, the name the agent calls. The copy behind it never runs
    expect(live.current().map((s) => s.server)).toEqual(['app-board'])
    const r = await live.call('app-board', 'peek', {})
    expect(text(r)).toBe('peeked')
    // Still that one name once the hub has listed its app
    expect(live.current().map((s) => s.server)).toEqual(['app-board'])
    expect(boardRuns(hub, 'p-hub')).toMatchObject([{ tool: 'peek', status: 'ok', callerSessionId: 'm1.w1' }])
    expect(boardRuns(machine, 'p-remote')).toEqual([])
    expect(machine.apps!.rt.list().find((a) => a.appId === 'board')?.status).not.toBe('running')
    // Asked about the copy itself (a view's link dropped on the session), it is not the session's to reach
    const key = { id: 'w1', kind: 'worker' as const, projectId: 'p-remote' }
    expect(machine.mgr.apps.sessionAppsHub()!.reach(key, { projectId: 'p-remote', appId: 'board' })).toEqual({ reachable: false, reason: 'unavailable' })
  })

  it('never runs the copy for a session the hub has no record of starting: the hub lists it nothing, and that is the answer', async () => {
    const { machine, hub, attach } = await world()
    const r = await attach('w2').call('app-board', 'peek', {})
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/Hub mac does not offer board to this session now.*copy of board is not used.*Nothing ran/)
    expect(boardRuns(hub, 'p-hub')).toEqual([])
    expect(boardRuns(machine, 'p-remote')).toEqual([])
    // Asked straight, the hub lists nothing for it, by its own record
    expect(await machine.hubs.appsPeer(hub.id)!.call('apps', { session: 'w2' }, 5_000)).toEqual({ apps: [] })
  })

  it.each([
    [
      'its project there is no longer trusted',
      async (hub: World['hub']) => {
        await hub.mgr.setProjectTrusted('p-hub', false)
        hub.apps!.rt.refresh()
      },
    ],
    ['the session that started it is archived', (hub: World['hub']) => hub.mgr.trash.trashSession('h1')],
  ])('never falls back to the copy once the hub stops listing its app (%s)', async (_why, withdraw) => {
    const { machine, hub, attach } = await world()
    const live = attach('w1')
    expect(text(await live.call('app-board', 'peek', {}))).toBe('peeked')
    await withdraw(hub)
    // The hub is asked again: it lists nothing now
    await machine.apps!.linked.refresh('w1')
    expect(live.current().map((s) => s.server)).toEqual(['app-board'])
    const r = await live.call('app-board', 'peek', {})
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/does not offer board to this session now.*Nothing ran/)
    expect(boardRuns(machine, 'p-remote')).toEqual([])
    expect(boardRuns(hub, 'p-hub')).toHaveLength(1)
  })

  it("delivers the hub's app's notice to the agent that uses it, and to no other session there", async () => {
    const { machine, hub, attach } = await world()
    await attach('w1').call('app-board', 'peek', {})
    const notice = linkedNotices({ machines: hub.links })
    await notice('m1.w1', 'the queue moved', { appId: 'board', projectId: 'p-hub', name: 'Board' })
    await eventually(() => machine.store.messages.loadMessages('w1').some((m) => m.role === 'user' && JSON.stringify(m.payload).includes('the queue moved')))
    expect(machine.store.messages.loadMessages('w1').find((m) => m.role === 'user')?.payload).toMatchObject({ fromApp: { appId: 'board', name: 'Board' } })
    await expect(notice('m1.w2', 'not yours', { appId: 'board', projectId: 'p-hub', name: 'Board' })!).rejects.toThrow('does not use this app')
  })

  it.each([true, false])('after a restart, before its hub offers again, answers that the hub is away and never runs the copy (used before: %s)', async (usedBefore) => {
    const { machine, hub, attach } = await world()
    if (usedBefore) expect(text(await attach('w1').call('app-board', 'peek', {}))).toBe('peeked')
    // As a restarted host: no list kept, and its hub has not offered since; the session's record names the hub
    machine.apps!.linked.forget('w1')
    machine.apps!.linked.usePeers({ machines: () => [], startedBy: () => ({ hub: { id: hub.id, name: hub.name }, link: undefined }) })
    const live = attach('w1')
    expect(live.current().map((s) => s.server)).toEqual(['app-board'])
    const r = await live.call('app-board', 'peek', {})
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/Hub mac is not reachable.*nothing ran.*copy of board is not used/)
    expect(boardRuns(machine, 'p-remote')).toEqual([])
  })

  it("answers that the hub did not answer in time when it is linked but its list does not come, and never runs the copy", async () => {
    const { machine, hub, attach } = await world()
    machine.apps!.linked.forget('w1')
    // Linked and offering apps, but its `hub.apps` ends as a link's timeout does
    const link = { id: hub.id, name: hub.name, reachable: true, answers: true, gives: true, call: () => Promise.reject(new Error('timed out after 2000 ms')) }
    machine.apps!.linked.usePeers({ machines: () => [], startedBy: () => ({ hub: { id: hub.id, name: hub.name, apps: true }, link }) })
    const r = await attach('w1').call('app-board', 'peek', {})
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/Hub mac did not answer in time.*nothing ran.*copy of board is not used/)
    expect(text(r)).not.toMatch(/does not offer|not be trusted|may be gone/)
    expect(boardRuns(machine, 'p-remote')).toEqual([])
    expect(boardRuns(hub, 'p-hub')).toEqual([])
  })

  it.each([
    ['recorded as offering no apps', 'runs', JSON.stringify({ id: 'HUB', name: 'Hub mac', apps: false })],
    ['recorded by a build from before `apps`', 'is withheld', JSON.stringify({ id: 'HUB', name: 'Hub mac' })],
  ] as const)('after a restart, its hub away and %s: the copy %s, as stored-shapes.md says', async (_, then, record) => {
    const { machine, hub, attach } = await world()
    machine.apps!.linked.forget('w1')
    // As a restarted host before its hub is back: no link, only the session's stored record, read as main.ts wires it
    machine.store.settings.setAppSetting('started_from_hub_by:w1', record.replace('HUB', hub.id))
    machine.apps!.linked.usePeers(appsPeers({ settings: machine.store.settings }))
    const r = await attach('w1').call('app-board', 'peek', {})
    if (then === 'runs') {
      expect(text(r)).toBe('peeked')
      expect(boardRuns(machine, 'p-remote')).toMatchObject([{ tool: 'peek', callerSessionId: 'w1' }])
    } else {
      expect(r.isError).toBe(true)
      expect(text(r)).toMatch(/Hub mac is not reachable.*nothing ran.*copy of board is not used/)
      expect(boardRuns(machine, 'p-remote')).toEqual([])
    }
    expect(boardRuns(hub, 'p-hub')).toEqual([])
  })

  it("an ordinary session runs the checkout's copy until it is off on this computer; the started agent uses the hub's either way (§13.7)", async () => {
    const { machine, hub, attach } = await world()
    expect(text(await attach('w3').call('app-board', 'peek', {}))).toBe('peeked')
    expect(boardRuns(machine, 'p-remote')).toMatchObject([{ tool: 'peek', status: 'ok', callerSessionId: 'w3' }])
    machine.mgr.apps.setAppOff({ projectId: 'p-remote', appId: 'board' }, true)
    const other = attach('w3')
    expect(other.current()).toEqual([])
    const r = await other.call('app-board', 'peek', {})
    expect(r.isError).toBe(true)
    expect(boardRuns(machine, 'p-remote')).toHaveLength(1)
    // Counted before its hub is asked, the off copy still holds the name the hub's app takes
    const started = attach('w1')
    expect(started.current().map((s) => s.server)).toEqual(['app-board'])
    expect(text(await started.call('app-board', 'peek', {}))).toBe('peeked')
    expect(boardRuns(hub, 'p-hub')).toMatchObject([{ tool: 'peek', status: 'ok', callerSessionId: 'm1.w1' }])
    expect(boardRuns(machine, 'p-remote')).toHaveLength(1)
    expect(machine.apps!.rt.list().find((a) => a.appId === 'board')).toMatchObject({ status: 'stopped', off: true })
  })

  it('keeps its checkout copy when the hub that started it does not offer apps, and never calls it', async () => {
    const { machine, hub, attach } = await world({ hubApps: false })
    const live = attach('w1')
    expect(live.current().map((s) => s.server)).toEqual(['app-board'])
    expect(text(await live.call('app-board', 'peek', {}))).toBe('peeked')
    expect(boardRuns(machine, 'p-remote')).toMatchObject([{ tool: 'peek', callerSessionId: 'w1' }])
    expect(hub.apps).toBeNull()
  })
})
