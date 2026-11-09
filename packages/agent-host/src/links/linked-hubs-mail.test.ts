import { afterEach, describe, expect, it } from 'vitest'
import { LinkedHubs } from './linked-hubs.js'
import { runCleanups } from './links-world.test-helpers.js'
import { hubHost, machineHost } from './reverse-link.test-helpers.js'
import { eventually } from '../../../../tooling/test-timing.js'
import { startingHub } from '../sessions/hub-preset.js'

/**
 * The machine's side of `hub.mail` (#2067 item 1, docs/plans/linked-mail.md §3): which hubs it keeps for mail, and what
 * a call to them comes to. The session's tool on top of it is linked-mail.test.ts.
 */

afterEach(runCleanups)

/** The hubs the machine has heard an offer from, whatever they offered */
const known = (hubs: LinkedHubs) => (hubs as unknown as { hubs: Map<string, unknown> }).hubs.size

describe('a linked machine keeps the hubs that take mail (#2067 item 1)', () => {
  it('keeps one whose asks switch is off, without listing or asking its projects, and forgets it when the hub removes the machine', async () => {
    const machine = await machineHost()
    const hub = await hubHost(machine.port, { mail: true })
    await eventually(() => known(machine.hubs) === 1)
    expect(hub.machine().asks).toEqual({ on: false, note: null })
    expect(machine.hubs.any).toBe(false)
    expect(await machine.ask({ project: `Hub mac/${hub.projectName}`, task: 'x' })).toMatchObject({ ok: false, error: expect.stringContaining('No project named') })
    // Removed while connected, the hub withdraws its offer though its switch was never on
    await hub.router.handle('machines.remove', { machineId: 'm1' })
    await eventually(() => known(machine.hubs) === 0)
  })

  it('records the hub whose connection created a session with fromHub, and none for a session it creates without', async () => {
    const machine = await machineHost()
    const hub = await hubHost(machine.port, { mail: true })
    await eventually(() => known(machine.hubs) === 1)
    const path = machine.store.projects.listProjects().find((p) => p.id === 'p-remote')!.path
    const create = (fromHub: boolean) =>
      hub.router.handle('agents.createSession', { projectId: 'm1.p-remote', cwd: path, tool: 'claude', ...(fromHub ? { fromHub: { callerPreset: 'normal' } } : {}) }) as Promise<{ id: string }>
    const [started, plain] = [await create(true), await create(false)]
    const here = (qualified: string) => qualified.slice('m1.'.length)
    expect(startingHub(machine.store.settings, here(started.id))).toEqual({ id: hub.id, name: 'Hub mac' })
    expect(startingHub(machine.store.settings, here(plain.id))).toBeNull()
  })

  it('a hub from before it, with its asks switch off, is not known', async () => {
    const machine = await machineHost()
    const hub = await hubHost(machine.port, { mail: 'before' })
    await eventually(() => hub.machine().status === 'connected')
    await hub.router.handle('machines.setAsks', { machineId: 'm1', on: true })
    await eventually(() => known(machine.hubs) === 1)
    await hub.router.handle('machines.setAsks', { machineId: 'm1', on: false })
    await eventually(() => known(machine.hubs) === 0)
  })
})

describe('a message to a parent on a hub, as the machine sends it (#2067 item 1)', () => {
  const offer = (hubs: LinkedHubs, o: { client?: number; id?: string; name?: string; on?: boolean; mail?: boolean } = {}) =>
    hubs.offer(o.client ?? 7, { hub: { id: o.id ?? 'hub-00000001', name: o.name ?? 'Hub mac' }, on: o.on ?? false, ...(o.mail === false ? {} : { mail: true }) })
  const MAC = { id: 'hub-00000001', name: 'Hub mac' }
  const LAPTOP = { id: 'hub-00000002', name: 'Laptop' }

  it('goes to the hub that started the session and to no other, which never reads the text', async () => {
    const calls: { client: number; params: unknown }[] = []
    const hubs = new LinkedHubs({ call: async (client, _m, params) => (calls.push({ client, params }), { ok: true, messageId: 'msg-1', to: 'h1' }) })
    offer(hubs, { client: 7 })
    offer(hubs, { client: 8, ...LAPTOP })
    expect(await hubs.mail('c1', LAPTOP, { text: 'hello' })).toEqual({ ok: true, messageId: 'msg-1', to: 'h1', hub: 'Laptop' })
    expect(calls).toEqual([{ client: 8, params: { sessionId: 'c1', text: 'hello' } }])
    // Another hub being down does not stand in the way, nor is it named
    hubs.gone(7)
    expect(await hubs.mail('c1', LAPTOP, { text: 'again' })).toMatchObject({ ok: true, hub: 'Laptop' })
    // The connection a hub offered on names it, for the session it creates there
    expect([hubs.on(8), hubs.on(7), hubs.on(9)]).toEqual([LAPTOP, undefined, undefined])
  })

  it('says each cause: no hub recorded, that hub not linked or down, a hub from before it, a link failing during the send', async () => {
    const answer: { fn: () => Promise<unknown> } = { fn: async () => ({ ok: true, messageId: 'msg-1', to: 'h1' }) }
    const calls: number[] = []
    const hubs = new LinkedHubs({ call: (client) => (calls.push(client), answer.fn()) })
    offer(hubs)
    // A session started by a build from before the record: nothing says which computer, and nothing is sent anywhere
    expect(await hubs.mail('c1', null, { text: 'hello' })).toEqual({
      ok: false,
      why: 'elsewhere',
      text: 'your parent is a session on another computer, and this session was started before this computer recorded which computer that was, so nothing was sent. End your turn with the answer: that is how your parent hears from you.',
    })
    expect(await hubs.mail('c1', LAPTOP, { text: 'hello' })).toEqual({
      ok: false,
      why: 'link_down',
      text: 'Laptop, which started this session, is not linked to this computer right now (or runs a Centralu from before mail crossed computers), so nothing was sent. Send it again once the link is back.',
    })
    expect(calls).toEqual([])
    answer.fn = () => Promise.reject(new Error('Unknown method: hub.mail'))
    expect(await hubs.mail('c1', MAC, { text: 'hello' })).toMatchObject({ ok: false, why: 'older', text: expect.stringMatching(/^Hub mac runs an older Centralu, which mail does not reach\./) })
    answer.fn = () => Promise.reject(new Error('the connection closed'))
    expect(await hubs.mail('c1', MAC, { text: 'hello' })).toEqual({
      ok: false,
      why: 'link_down',
      text: 'the link to Hub mac failed during the send (the connection closed), so it is not known whether the message arrived. If you send it again and it did, Hub mac refuses the second one as a repeat.',
    })
    // Its connection gone, the hub is not called at all
    calls.length = 0
    hubs.gone(7)
    expect(await hubs.mail('c1', MAC, { text: 'hello' })).toEqual({ ok: false, why: 'link_down', text: 'Hub mac is not reachable right now, so nothing was sent. Send it again once the link is back.' })
    expect(calls).toEqual([])
  })

  it('a hub that offers mail with its switch off is not listed or asked; off without mail forgets it', async () => {
    const calls: string[] = []
    const hubs = new LinkedHubs({ call: async (_c, method) => (calls.push(method), method === 'hub.mail' ? { ok: true, messageId: 'msg-1', to: 'h1' } : { projects: [] }) })
    offer(hubs)
    expect(hubs.any).toBe(false)
    expect(await hubs.projects()).toEqual({ projects: [], away: [] })
    expect(await hubs.ask('hub-00000001', { caller: { sessionId: 'w1', name: 'w1', project: 'p' }, project: 'x', task: 't', depth: 1 })).toEqual({ ok: false, error: 'That computer no longer lets this machine ask its projects.' })
    expect(await hubs.mail('c1', MAC, { text: 'hello' })).toEqual({ ok: true, messageId: 'msg-1', to: 'h1', hub: 'Hub mac' })
    expect(calls).toEqual(['hub.mail'])
    offer(hubs, { mail: false })
    expect(await hubs.mail('c1', MAC, { text: 'hello' })).toMatchObject({ ok: false, why: 'link_down' })
  })
})
