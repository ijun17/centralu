import { afterEach, describe, expect, it } from 'vitest'
import { LinkedAppCallParams } from '@cc/protocol'
import * as kit from '../apps/external/test-helpers.js'
import { sessionAddress } from '../mail/address.js'
import { runCleanups } from './links-world.test-helpers.js'
import { hubHost, machineHost } from './reverse-link.test-helpers.js'
import { appsPeers, linkedNotices } from './apps-across.js'
import type { AppsPeer } from './linked-apps.js'
import { recordStartingHub } from '../sessions/hub-preset.js'
import type { RemoteAgent } from '../sessions/remote-agents.js'
import { SLOW, eventually } from '../../../../tooling/test-timing.js'

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
async function world(o: { hubApps?: boolean; mail?: true } = {}) {
  const machine = await machineHost({ sessions: ['w1', 'w2', 'w3'], apps: true, ...(o.mail ? { mail: o.mail } : {}) })
  machine.apps!.plant(kit, 'p-remote', 'board')
  const hub = await hubHost(machine.port, { ...(o.hubApps !== false ? { apps: true } : {}), ...(o.mail ? { mail: o.mail } : {}), children: [child] })
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

/**
 * The machine's link to the hub as its sessions' app calls use it, recording each `hub.appCall` sent. From the `holdFrom`th
 * call of `hold` on, the hub is asked to wait for the run's end (`held` resolves as that call is sent, `ended` once it
 * settles), so only the link's loss ends the wait and the test drops it at a known point rather than racing the hub's answer
 */
function watchHubCalls(machine: World['machine'], holdFrom: number) {
  const real = appsPeers({ hubs: machine.hubs, settings: machine.store.settings })
  const sent: LinkedAppCallParams[] = []
  let reached = () => {}
  const held = new Promise<void>((resolve) => (reached = resolve))
  let settled = () => {}
  const ended = new Promise<void>((resolve) => (settled = resolve))
  const watched = (link: AppsPeer): AppsPeer => ({
    ...link,
    call: (method, params, timeoutMs) => {
      if (method !== 'appCall') return link.call(method, params, timeoutMs)
      const p = LinkedAppCallParams.parse(params)
      sent.push(p)
      if (p.tool !== 'hold' || sent.filter((s) => s.tool === 'hold').length < holdFrom) return link.call(method, params, timeoutMs)
      reached()
      const answer = link.call(method, { ...p, waitMs: 600_000 }, timeoutMs)
      void answer.catch(() => {}).then(settled)
      return answer
    },
  })
  machine.apps!.linked.usePeers({
    machines: real.machines,
    startedBy: (id) => {
      const s = real.startedBy(id)
      return s?.link ? { ...s, link: watched(s.link) } : s
    },
  })
  return { sent, held, ended }
}

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

  it('tells the agent in its mail, once the hub offers again, that its call while the hub was away did not run', async () => {
    const { machine, hub, attach } = await world({ mail: true })
    const live = attach('w1')
    expect(text(await live.call('app-board', 'peek', {}))).toBe('peeked')
    await machine.bounce(undefined, async () => {
      await eventually(() => machine.hubs.appsPeer(hub.id)?.reachable === false)
      expect(text(await live.call('app-board', 'peek', {}))).toMatch(/Hub mac is not reachable.*nothing ran/)
    })
    const mail = () => machine.store.mailbox.pendingFor(sessionAddress(machine.id, 'w1'), Number.MAX_SAFE_INTEGER).map((p) => p.message.body)
    await eventually(() => mail().some((b) => b.includes('reachable again')))
    expect(mail().filter((b) => b.includes('reachable again'))).toEqual(['[Centralu] Hub mac is reachable again; board was not called while it was away. Call it again if it is still needed.'])
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
    const told: [string, string][] = []
    const hubLink: { now?: AppsPeer } = {}
    machine.apps!.linked.usePeers({ machines: () => [], startedBy: () => ({ hub: { id: hub.id, name: hub.name }, link: hubLink.now }) }, (id, body) => void told.push([id, body]))
    const live = attach('w1')
    expect(live.current().map((s) => s.server)).toEqual(['app-board'])
    const r = await live.call('app-board', 'peek', {})
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/Hub mac is not reachable.*nothing ran.*copy of board is not used/)
    expect(boardRuns(machine, 'p-remote')).toEqual([])
    // A signal while the hub is still away tells nothing; once it is back, the session hears that its call did not run
    machine.apps!.linked.back(hub.id)
    expect(told).toEqual([])
    hubLink.now = { id: hub.id, name: hub.name, reachable: true, answers: true, gives: true, call: () => Promise.reject(new Error('unused')) }
    machine.apps!.linked.back(hub.id)
    expect(told).toEqual([['w1', '[Centralu] Hub mac is reachable again; board was not called while it was away. Call it again if it is still needed.']])
  })

  it('tells nothing when its hub offers again of an app that hub withheld while reachable: it was never away', async () => {
    const { machine, hub, attach } = await world()
    const told: [string, string][] = []
    machine.apps!.linked.usePeers(appsPeers({ hubs: machine.hubs, settings: machine.store.settings }), (id, body) => void told.push([id, body]))
    // `w2`: the hub has no record of starting it, so it lists it nothing
    const r = await attach('w2').call('app-board', 'peek', {})
    expect(text(r)).toMatch(/Hub mac does not offer board to this session now/)
    machine.apps!.linked.back(hub.id)
    expect(told).toEqual([])
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
    machine.mgr.apps.setAppFlag('off', { projectId: 'p-remote', appId: 'board' }, true)
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

  it.each([
    { when: 'after its first answer, its run id known', holdFrom: 2, told: false },
    { when: 'before its first answer, its run id not known', holdFrom: 1, told: false },
    { when: 'after the agent was told it is still running', holdFrom: 2, told: true },
  ])("a link lost mid-call ($when) is answered as maybe done, nothing is resent, and a known run id's run_status gives the hub's result", async ({ holdFrom, told }) => {
    const { machine, hub, attach } = await world()
    const live = attach('w1')
    const { sent, held, ended } = watchHubCalls(machine, holdFrom)
    // `told`: past its wait the agent hears it is still running, with its run id, and the call goes on here (`detached`).
    // The wait outlasts the first 1 s chunk that brings the run id, with room for a slow machine
    const calling = live.call('app-board', 'hold', {}, told ? { waitMs: 3_000 * SLOW } : {})
    // A write: the agent's own card on the machine asks first
    const card = await eventually(() => machine.mgr.listSessions().find((s) => s.id === 'w1')?.pendingApproval)
    machine.mgr.inputs.respondApproval('w1', card!.requestId, 'allow')
    await held
    await eventually(() => boardRuns(hub, 'p-hub').some((r) => r.tool === 'hold' && r.status === 'running'))
    const runId = hub.apps!.rt.runs({ projectId: 'p-hub', appId: 'board' })[0]!.id
    const early = told ? await calling : null
    if (early) expect(early.structuredContent).toMatchObject({ runId, status: 'running' })
    let lost!: Awaited<typeof calling>
    await machine.bounce(undefined, async () => {
      await ended
      lost = await calling
    })
    if (!told) {
      expect(lost.isError).toBe(true)
      expect(text(lost).match(/may or may not/g)).toEqual(['may or may not'])
      expect(text(lost)).toContain('The link to Hub mac was lost during the call, so App board on Hub mac may or may not have done this.')
      const status = `app(action="call", app="board", tool="run_status", args={"run_id": "${runId}"})`
      if (holdFrom === 2) expect(text(lost)).toContain(`Do not call it again: once the link is back, ${status} gives its result.`)
      else expect(text(lost)).toContain('Its run id there is not known: check what it did before calling it again.')
    }

    await eventually(() => machine.hubs.appsPeer(hub.id)?.reachable === true)
    hub.apps!.open('board')
    await eventually(() => boardRuns(hub, 'p-hub')[0]?.status === 'ok')
    // The hub's `released`, not the lost-link error the early-returned call left recorded here
    if (holdFrom === 2) expect(text(await live.call('app-board', 'run_status', { run_id: runId }))).toContain('released')
    // Sent once, as one call under one id (asked again per wait, never as a second run), and never after the loss
    const holds = sent.filter((p) => p.tool === 'hold')
    expect(holds).toHaveLength(holdFrom)
    expect(new Set(holds.map((p) => p.call)).size).toBe(1)
    expect(boardRuns(hub, 'p-hub').filter((r) => r.tool === 'hold')).toHaveLength(1)
  })
})
