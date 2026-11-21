import { afterEach, describe, expect, it, vi } from 'vitest'
import * as kit from '../apps/external/test-helpers.js'
import { sessionAddress } from '../mail/address.js'
import { AWAY_TOLD_MS, LinkedApps, type LinkedTool } from './linked-apps.js'
import { runCleanups } from './links-world.test-helpers.js'
import { hubHost, machineHost } from './reverse-link.test-helpers.js'
import { eventually } from '../../../../tooling/test-timing.js'

/**
 * A project's app used from another machine (#1938, docs/plans/remote-hub.md §13): a hub's session finds, attaches and
 * calls a machine's shared app, which runs and is recorded on the machine. Real hosts in one process, each with its own
 * store, session manager, app runtime, RPC handler and server, wired as main.ts wires them; only the transport is loopback.
 */

afterEach(runCleanups)

const text = (r: { content: unknown[] }) => r.content.map((c) => (c as { text?: string }).text ?? '').join('\n')

/** A machine with the fixture app `board` in its project, shared unless told otherwise, and a hub linked to it */
async function world(o: { shared?: boolean; machineApps?: true | 'before'; mail?: true } = {}) {
  const machine = await machineHost({ apps: o.machineApps ?? true })
  machine.apps!.plant(kit, 'p-remote', 'board', { shared: o.shared !== false })
  const hub = await hubHost(machine.port, { apps: true, ...(o.mail ? { mail: o.mail } : {}) })
  await eventually(() => hub.machine().status === 'connected')
  await eventually(() => machine.hubs.appsOn !== undefined && !!hub.links.get('m1')?.answersApps === (o.machineApps !== 'before'))
  await hub.mgr.setProjectTrusted('p-hub', true)
  const access = hub.mgr.apps.requireAppAccess()
  const live = hub.mgr.apps.sessionAppsHub()!.attach({ id: 'h1', kind: 'worker', projectId: 'p-hub' })
  return { machine, hub, access, live }
}

describe("a hub's session uses a machine's project app (#1938)", () => {
  it('finds it by machine and project, attaches it behind the card naming the machine, and calls it there', async () => {
    const { machine, hub, access, live } = await world()
    expect(await access.refreshLinked('h1')).toEqual([])
    const found = access.find('h1')
    expect(found).toMatchObject({ ok: true, apps: [{ ref: 'Remote box/remote-project/board', project: 'remote-project', machine: 'Remote box' }] })

    const attaching = access.attach('h1', 'Remote box/remote-project/board')
    const card = await hub.answer('allow')
    expect(card.detail).toMatchObject({ kind: 'project_access', access: 'apps', to: { name: 'remote-project', machine: 'Remote box' } })
    expect(await attaching).toMatchObject({ ok: true, server: 'app-board', tools: ['echo', 'peek', 'poke', 'hold'] })

    // Read-only: no card. It ran on the machine, recorded there under the hub's session, qualified by the hub's link
    const r = await live.call('app-board', 'peek', {})
    expect(text(r)).toBe('peeked')
    const rows = machine.apps!.rt.runs({ projectId: 'p-remote', appId: 'board' })
    expect(rows).toMatchObject([{ tool: 'peek', status: 'ok', callerKind: 'session', callerSessionId: `${hub.id}.h1` }])
    // Nothing ran on the hub: it has no such app
    expect(hub.apps!.rt.list()).toEqual([])

    // A write asks in the hub session's own card, as for an app here
    const poking = live.call('app-board', 'poke', { to: 3 })
    await hub.answer('allow')
    expect(text(await poking)).toBe('poked 3')
  })

  it('is not offered when the machine does not share it, and is refused by the machine once sharing is withdrawn', async () => {
    const { machine, access, live, hub } = await world({ shared: false })
    await access.refreshLinked('h1')
    expect(access.find('h1')).toEqual({ ok: true, apps: [] })
    expect(await access.attach('h1', 'Remote box/remote-project/board')).toMatchObject({ ok: false, error: expect.stringContaining('No app named') })

    // Shared, attached, then withdrawn there: the hub's list still names it, the machine refuses the call, nothing ran
    machine.mgr.apps.setAppFlag('shared', { projectId: 'p-remote', appId: 'board' }, true)
    await access.refreshLinked('h1')
    const attaching = access.attach('h1', 'Remote box/remote-project/board')
    await hub.answer('allow')
    expect(await attaching).toMatchObject({ ok: true })
    machine.mgr.apps.setAppFlag('shared', { projectId: 'p-remote', appId: 'board' }, false)
    const r = await live.call('app-board', 'peek', {})
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('cannot use that app of this computer now')
    expect(machine.apps!.rt.runs({ projectId: 'p-remote', appId: 'board' })).toEqual([])
  })

  it('is not offered, and is refused there, once the person turns it off on the machine from the hub window (§13.7)', async () => {
    const { machine, hub, access, live } = await world()
    await access.refreshLinked('h1')
    const attaching = access.attach('h1', 'Remote box/remote-project/board')
    await hub.answer('allow')
    expect(await attaching).toMatchObject({ ok: true })

    // "Runs on Remote box" turned off in the hub's Settings → Apps: the hub routes it to the machine, which stores it
    await hub.router.handle('apps.setOff', { projectId: 'm1.p-remote', appId: 'board', off: true })
    expect(machine.apps!.rt.list().find((a) => a.appId === 'board')).toMatchObject({ status: 'stopped', off: true })
    const r = await live.call('app-board', 'peek', {})
    expect(r.isError).toBe(true)
    expect(machine.apps!.rt.runs({ projectId: 'p-remote', appId: 'board' })).toEqual([])
    await access.refreshLinked('h1')
    expect(access.find('h1')).toEqual({ ok: true, apps: [] })
  })

  it('answers that the machine is away, naming it, and runs nothing; a link lost mid-call says it may have run, with its run id', async () => {
    const { machine, hub, access, live } = await world()
    await access.refreshLinked('h1')
    const attaching = access.attach('h1', 'Remote box/remote-project/board')
    await hub.answer('allow')
    await attaching

    // Held on the machine past the first wait, then the link goes
    const holding = live.call('app-board', 'hold', {})
    await hub.answer('allow')
    await eventually(() => machine.apps!.rt.runs({ projectId: 'p-remote', appId: 'board' }).some((r) => r.status === 'running'))
    const runId = machine.apps!.rt.runs({ projectId: 'p-remote', appId: 'board' })[0]!.id
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    await machine.close()
    const lost = await holding
    expect(lost.isError).toBe(true)
    // Said once, with the whole call that asks about it, under the name the agent calls the app by
    expect(text(lost).match(/may or may not/g)).toHaveLength(1)
    expect(text(lost)).toContain(`app(action="call", app="board", tool="run_status", args={"run_id": "${runId}"})`)

    await eventually(() => hub.machine().status !== 'connected')
    const r = await live.call('app-board', 'peek', {})
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/Remote box is not reachable.*nothing ran/)
  })

  it('tells the session in its mail, once the machine is back, that its call while away did not run', async () => {
    const { machine, hub, access, live } = await world({ mail: true })
    await access.refreshLinked('h1')
    const attaching = access.attach('h1', 'Remote box/remote-project/board')
    await hub.answer('allow')
    await attaching
    await machine.bounce(undefined, async () => {
      await eventually(() => hub.machine().status !== 'connected')
      expect(text(await live.call('app-board', 'peek', {}))).toMatch(/Remote box is not reachable.*nothing ran/)
    })
    const mail = () => hub.store.mailbox.pendingFor(sessionAddress(hub.id, 'h1'), Number.MAX_SAFE_INTEGER).map((p) => p.message.body)
    await eventually(() => mail().length > 0)
    expect(mail()).toEqual(['[Centralu] Remote box is reachable again; board was not called while it was away. Call it again if it is still needed.'])
    expect(machine.apps!.rt.runs({ projectId: 'p-remote', appId: 'board' })).toEqual([])
  })

  it('withdraws a call there when the caller cancels it', async () => {
    const { machine, hub, access, live } = await world()
    await access.refreshLinked('h1')
    const attaching = access.attach('h1', 'Remote box/remote-project/board')
    await hub.answer('allow')
    await attaching
    const abort = new AbortController()
    const holding = live.call('app-board', 'hold', {}, { signal: abort.signal })
    await hub.answer('allow')
    await eventually(() => machine.apps!.rt.runs({ projectId: 'p-remote', appId: 'board' }).some((r) => r.status === 'running'))
    abort.abort()
    await holding
    await eventually(() => machine.apps!.rt.runs({ projectId: 'p-remote', appId: 'board' })[0]?.status === 'cancelled')
  })

  it('answers run_status from the machine for a call that ended past its wait', async () => {
    const { machine, hub, access, live } = await world()
    await access.refreshLinked('h1')
    const attaching = access.attach('h1', 'Remote box/remote-project/board')
    await hub.answer('allow')
    await attaching
    const holding = live.call('app-board', 'hold', {}, { waitMs: 3_000 })
    await hub.answer('allow')
    const first = await holding
    expect(text(first)).toContain('still running')
    const runId = (first.structuredContent as { runId: string }).runId
    machine.apps!.open('board')
    await eventually(() => machine.apps!.rt.runs({ projectId: 'p-remote', appId: 'board' })[0]?.status === 'ok')
    await eventually(async () => text(await live.call('app-board', 'run_status', { run_id: runId })).includes('released'))
  })

  it('never starts a call whose cancel overtook it', async () => {
    const { machine, hub, access } = await world()
    await access.refreshLinked('h1')
    const link = hub.links.get('m1')!
    await link.call('host.appCancel', { call: 'c-1' })
    const r = await link.call('host.appCall', { call: 'c-1', session: 'h1', projectId: 'p-remote', appId: 'board', tool: 'peek', args: {}, waitMs: 1_000 })
    expect(r).toMatchObject({ status: 'cancelled' })
    expect(machine.apps!.rt.runs({ projectId: 'p-remote', appId: 'board' })).toEqual([])
  })

  it('names a machine from before it, and calls nothing there', async () => {
    const { access } = await world({ machineApps: 'before' })
    expect(await access.refreshLinked('h1')).toEqual([{ name: 'Remote box', why: expect.stringContaining('update it there') }])
    expect(access.find('h1')).toEqual({ ok: true, apps: [] })
  })
})

describe('a session whose app call was refused while its host was away hears once that the host is back', () => {
  const app = (appId: string) => ({ projectId: 'p', project: 'proj', appId, name: appId, description: '', tools: [] })
  /** A machine `m1` ("Box") that lists two apps, and a second one; `away` takes them down */
  function rig() {
    const told: [string, string][] = []
    let up = true
    let answers = true
    let tools: LinkedTool[] | null = []
    const peer = (id: string, name: string) => ({
      id, name, gives: false,
      get reachable() { return up },
      get answers() { return answers },
      call: async () => ({ apps: [{ ...app('board'), tools }, app('notes')] }),
    })
    const linked = new LinkedApps()
    linked.usePeers({ machines: () => [peer('m1', 'Box'), peer('m2', 'Other box')], startedBy: () => null }, (id, body) => void told.push([id, body]))
    const ref = (appId: string, host = 'm1') => ({ projectId: `${host}.p`, appId })
    return { linked, told, ref, away: (v: boolean) => void (up = !v), older: (v: boolean) => void (answers = !v), unlisted: () => void (tools = null) }
  }
  afterEach(() => vi.restoreAllMocks())

  it('names each app once, per session, only for calls within AWAY_TOLD_MS, and only once', async () => {
    const { linked, told, ref, away } = rig()
    for (const s of ['s1', 's2', 's3', 's4']) await linked.refresh(s)
    away(true)
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    await linked.call('s3', ref('board'), 'peek', {}, { name: 'board' })
    now.mockReturnValue(1_000_001)
    await linked.call('s4', ref('notes'), 'peek', {}, { name: 'notes' })
    now.mockReturnValue(1_000_000 + AWAY_TOLD_MS)
    for (const appId of ['board', 'notes', 'board']) expect((await linked.call('s1', ref(appId), 'peek', {}, { name: appId })).error).toMatch(/Box is not reachable.*nothing ran/)
    await linked.call('s2', ref('board', 'm2'), 'peek', {}, { name: 'board' })
    now.mockReturnValue(1_000_001 + AWAY_TOLD_MS)
    away(false)
    linked.back('m1')
    // s3's call is one past the window, s4's exactly at it; s2's was on the other host
    expect(told).toEqual([
      ['s4', '[Centralu] Box is reachable again; notes was not called while it was away. Call it again if it is still needed.'],
      ['s1', '[Centralu] Box is reachable again; board and notes were not called while it was away. Call them again if they are still needed.'],
    ])
    linked.back('m1')
    expect(told).toHaveLength(2)
    linked.back('m2')
    expect(told.at(-1)).toEqual(['s2', '[Centralu] Other box is reachable again; board was not called while it was away. Call it again if it is still needed.'])
  })

  it('tells nothing while the host is still away or answers no app calls on this connection, and keeps the call for when it can', async () => {
    const { linked, told, ref, away, older } = rig()
    await linked.refresh('s1')
    away(true)
    await linked.call('s1', ref('board'), 'peek', {}, { name: 'board' })
    linked.back('m1')
    expect(told).toEqual([])
    away(false)
    older(true)
    linked.back('m1')
    expect(told).toEqual([])
    older(false)
    linked.back('m1')
    expect(told.map(([id]) => id)).toEqual(['s1'])
  })

  it("tells nothing of a call of a tool not in the session's list, which would not run there either, but tells of one when it has no list yet", async () => {
    const { linked, told, ref, away, unlisted } = rig()
    await linked.refresh('s1')
    away(true)
    await linked.call('s1', ref('board'), 'peek', {}, { name: 'board', notListed: true })
    away(false)
    linked.back('m1')
    expect(told).toEqual([])
    unlisted()
    await linked.refresh('s1')
    away(true)
    await linked.call('s1', ref('board'), 'peek', {}, { name: 'board', notListed: true })
    away(false)
    linked.back('m1')
    expect(told.map(([id]) => id)).toEqual(['s1'])
  })

  it('tells nothing of a deleted session', async () => {
    const { linked, told, ref, away } = rig()
    await linked.refresh('s1')
    away(true)
    await linked.call('s1', ref('board'), 'peek', {}, { name: 'board' })
    linked.forget('s1')
    linked.back('m1')
    expect(told).toEqual([])
  })
})
