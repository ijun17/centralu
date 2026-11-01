import { afterEach, describe, expect, it } from 'vitest'
import { APP_VERSION, PROTOCOL_VERSION, type SessionInfo } from '@cc/protocol'
import { Store } from '../dev-services/store.js'
import { SessionManager } from '../sessions/manager.js'
import { createRpcHandler } from '../rpc.js'
import { HostServer } from '../transport/server.js'
import { Links, type LinkDeps } from './links.js'
import { LinkedHubs } from './linked-hubs.js'
import { reverseCalls } from './reverse-calls.js'
import { Router } from './router.js'
import { DirectTunnel } from './tunnel.js'
import { hubSelfId, storeMirror, storeRegistry } from './stored.js'
import { scriptedAdapters } from './scripted-agent.test-helpers.js'
import { TOKEN, cleanups, folder, lineFor, runCleanups, seedSession } from './links-world.test-helpers.js'
import { eventually } from '../../../../tooling/test-timing.js'

/**
 * The reverse direction (#550, docs/plans/remote-hub.md §12.7): a linked machine's session asks a project of the hub,
 * behind the hub's card for the pair. Real hosts in one process, each with its own store, session manager, RPC handler
 * and server, wired as main.ts wires them; only the transport is loopback instead of ssh.
 */

afterEach(runCleanups)

/** An RPC handler without these methods, as a build from before them answers */
function without(handler: ReturnType<typeof createRpcHandler>, methods: readonly string[]): ReturnType<typeof createRpcHandler> {
  return (method, ...rest) => {
    if (methods.includes(method)) return Promise.reject(new Error(`Unknown method: ${method}. This Centralu host does not have it; the window may be from another build.`))
    return handler(method, ...rest)
  }
}

/** The machine: a trusted project with an ordinary session (the caller), and the hubs that offer it the reverse direction */
async function machineHost(o: { without?: readonly string[]; sessions?: readonly string[]; askTimeoutMs?: number } = {}) {
  const store = new Store()
  store.projects.addProject({ id: 'p-remote', path: folder(), name: 'remote-project' })
  for (const id of o.sessions ?? ['w1']) seedSession(store, 'p-remote', id, 'worker', `ext-${id}`)
  const adapters = scriptedAdapters()
  const mgr = new SessionManager(store, adapters, (e) => server.broadcast(e))
  const hubs = new LinkedHubs({ call: (client, method, params, opts) => server.call(client, method, params, opts), lookupMs: 2000, ...(o.askTimeoutMs ? { askTimeoutMs: o.askTimeoutMs } : {}) })
  mgr.useLinkedHubs(hubs)
  const server: HostServer = new HostServer({
    port: 0,
    token: TOKEN,
    onRpc: without(createRpcHandler(mgr, adapters, { hubs }), o.without ?? []),
    onClientGone: (client) => hubs.gone(client),
    build: { commit: 'abc1234', protocolVersion: PROTOCOL_VERSION, version: APP_VERSION },
  })
  const port = await server.listen()
  mgr.setProjectTrusted('p-remote', true)
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await mgr.disposeAll()
    await server.close()
  }
  cleanups.push(close)
  const ask = (opts: { project: string; session?: string; task?: string }, signal?: AbortSignal) => mgr.askProject('w1', opts, signal)
  return { store, mgr, server, hubs, port, close, ask }
}

/** A hub linked to the machine as `m1` ("Remote box"), with a project and an ordinary session in it (the asked one) */
async function hubHost(machinePort: number, o: { name?: string; reverse?: boolean; project?: string; preset?: SessionInfo['permissionPreset'] } = {}) {
  const store = new Store()
  const projectName = o.project ?? 'hub-project'
  store.projects.addProject({ id: 'p-hub', path: folder(), name: projectName })
  seedSession(store, 'p-hub', 'h1', 'worker', 'ext-h1', { permissionPreset: o.preset ?? 'normal' })
  const adapters = scriptedAdapters()
  const mgr = new SessionManager(store, adapters, (e) => server.broadcast(e))
  const name = o.name ?? 'Hub mac'
  mgr.useHubName(() => name)
  const registry = storeRegistry(store)
  registry.add({ id: 'm1', name: 'Remote box', sshTarget: 'box', remote: { shell: 'posix' }, addedAt: 1, acceptedVersions: null })
  const reverse: Partial<LinkDeps> =
    o.reverse === false
      ? {}
      : {
          hubSelf: () => ({ id: hubSelfId(store), name }),
          reverse: reverseCalls({
            allowed: (id) => store.machines.linkedMachineAsks(id),
            projects: () => mgr.projectsForMachines(),
            ask: (machine, params, signal) => mgr.askFromMachine(machine, params, signal),
            selfName: () => name,
          }),
        }
  const links = new Links({
    hub: { version: APP_VERSION, protocolVersion: PROTOCOL_VERSION, dev: false },
    broadcast: (e) => {
      server.broadcast(e)
      mgr.observeLinked(e)
    },
    terminal: (f) => server.pushTerminal(f),
    mirror: storeMirror(store),
    registry,
    tunnelFor: () => new DirectTunnel(() => lineFor(machinePort)),
    retryMs: [50, 200],
    client: { maxBackoffMs: 100 },
    ...reverse,
  })
  const router = new Router({ local: createRpcHandler(mgr, adapters, { machines: links }), machines: () => links.all() })
  const server: HostServer = new HostServer({ port: 0, token: TOKEN, onRpc: router.handle })
  await server.listen()
  links.start()
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    await links.stop()
    await mgr.disposeAll()
    await server.close()
  }
  cleanups.push(stop)
  const card = () => mgr.listSessions().find((s) => s.id === 'h1')?.pendingApproval
  const answer = async (decision: 'allow' | 'deny') => {
    await eventually(() => !!card())
    const c = card()!
    await mgr.respondApproval('h1', c.requestId, decision)
    await eventually(() => card()?.requestId !== c.requestId)
    return c
  }
  const machine = () => links.list()[0]!
  return { store, mgr, links, router, server, card, answer, machine, stop, name, id: hubSelfId(store), projectName }
}

/** A machine and a hub linked to it, connected, with the hub's switch for the machine on unless told otherwise */
async function rig(o: { on?: boolean; sessions?: readonly string[]; askTimeoutMs?: number; preset?: SessionInfo['permissionPreset'] } = {}) {
  const machine = await machineHost({ sessions: o.sessions, askTimeoutMs: o.askTimeoutMs })
  const hub = await hubHost(machine.port, { preset: o.preset })
  await eventually(() => hub.machine().status === 'connected')
  if (o.on !== false) {
    await hub.router.handle('machines.setAsks', { machineId: 'm1', on: true })
    await eventually(() => machine.hubs.any)
  }
  return { machine, hub }
}

const lastWords = (r: unknown) => (r as { answer?: string }).answer ?? ''

describe('a linked machine’s session asks the hub’s projects (#550)', () => {
  it('is off by default: the hub is not offered to the machine, and a call that comes anyway is refused', async () => {
    const { machine, hub } = await rig({ on: false })
    expect(hub.machine().asks).toEqual({ on: false, note: null })
    // The hub said off: its projects cannot be named
    const r = await machine.ask({ project: `Hub mac/${hub.projectName}`, task: 'say hello' })
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('No project named') })
    expect(machine.hubs.any).toBe(false)
    // A machine that calls anyway, on the hub's own connection, is refused by the hub: nothing reaches its sessions
    const client = [...(machine.server as unknown as { byClient: Map<number, unknown> }).byClient.keys()][0]!
    await expect(machine.server.call(client, 'hub.askProject', { caller: { sessionId: 'w1', name: 'w1', project: 'remote-project' }, project: hub.projectName, task: 'x', depth: 1 })).rejects.toThrow(
      'Hub mac does not let sessions on Remote box ask its projects',
    )
    await expect(machine.server.call(client, 'hub.projects', {})).rejects.toThrow('does not let sessions on Remote box')
    // Nor anything outside the allowlist, switch on or not
    await hub.router.handle('machines.setAsks', { machineId: 'm1', on: true })
    await expect(machine.server.call(client, 'sessions.list', {})).rejects.toThrow('Unknown method: sessions.list')
    expect(hub.card()).toBeFalsy()
    expect(hub.store.messages.loadMessages('h1', 20)).toEqual([])
  })

  it('raises the hub’s card for a first ask, naming the machine and the session there; allowed, the answer comes back', async () => {
    const { machine, hub } = await rig()
    const call = machine.ask({ project: hub.projectName, task: 'say hello' })
    const c = await hub.answer('allow')
    expect(c.detail).toMatchObject({
      kind: 'project_access',
      access: 'delegate',
      from: { name: 'remote-project', machine: 'Remote box', session: { id: 'w1', name: 'w1' } },
      to: { id: 'p-hub', name: hub.projectName },
      session: { id: 'h1' },
    })
    const r = await call
    expect(r).toMatchObject({ ok: true, state: 'done', project: `${hub.id}/${hub.projectName}`, sessionId: `${hub.id}.h1`, readable: [] })
    expect(lastWords(r)).toContain('echo: [A session in the project "remote-project on Remote box" asks this project')
    // On the hub it is recorded as that session on that machine, never as the person or an orchestrator
    const there = hub.store.messages.loadMessages('h1', 10).find((m) => (m.payload as { text?: string }).text?.includes('say hello'))!
    expect(there.payload).toMatchObject({ from: { sessionId: '_linked-machine-session', name: 'w1 on Remote box' } })
    expect(hub.store.machines.listMachineAskConsents()).toEqual([expect.objectContaining({ machineId: 'm1', sessionId: 'w1', projectId: 'p-hub' })])
    // The asked session worked one level below the asker, and the mark went with its turn (#867)
    await eventually(() => hub.store.settings.appSetting('hub_ask_depth:h1') === null)
  })

  it('passes an approved pair with no card, until the person withdraws it', async () => {
    const { machine, hub } = await rig()
    const first = machine.ask({ project: hub.projectName, task: 'one' })
    await hub.answer('allow')
    expect(await first).toMatchObject({ ok: true, state: 'done' })

    const raised: unknown[] = []
    const off = setInterval(() => hub.card() && raised.push(hub.card()), 5)
    const second = await machine.ask({ project: `Hub mac/${hub.projectName}`, task: 'two' })
    clearInterval(off)
    expect(second).toMatchObject({ ok: true, state: 'done' })
    expect(lastWords(second)).toContain('two')
    expect(raised).toEqual([])

    // Withdrawn in Settings → Machines: the next ask asks again
    expect(await hub.router.handle('machines.askConsents', {})).toEqual([
      expect.objectContaining({ machineId: 'm1', machineName: 'Remote box', sessionId: 'w1', sessionName: 'w1', projectId: 'p-hub', projectName: hub.projectName }),
    ])
    await hub.router.handle('machines.withdrawAsk', { machineId: 'm1', sessionId: 'w1', projectId: 'p-hub' })
    const third = machine.ask({ project: hub.projectName, task: 'three' })
    await hub.answer('deny')
    expect(await third).toMatchObject({ ok: false, error: expect.stringContaining('did not allow') })
    // A denial is not remembered, and the pair stays withdrawn
    expect(hub.store.machines.listMachineAskConsents()).toEqual([])
  })

  it('is another pair for another session of the machine', async () => {
    const { machine, hub } = await rig({ sessions: ['w1', 'w2'] })
    const first = machine.ask({ project: hub.projectName, task: 'one' })
    await hub.answer('allow')
    await first
    const other = machine.mgr.askProject('w2', { project: hub.projectName, task: 'two' })
    const c = await hub.answer('deny')
    expect(c.detail).toMatchObject({ from: { session: { id: 'w2' } } })
    expect(await other).toMatchObject({ ok: false })
  })

  it('turning the switch off refuses at once and forgets the pairs; on again, the card comes back', async () => {
    const { machine, hub } = await rig()
    const first = machine.ask({ project: hub.projectName, task: 'one' })
    await hub.answer('allow')
    await first
    await hub.router.handle('machines.setAsks', { machineId: 'm1', on: false })
    await eventually(() => !machine.hubs.any)
    expect(await machine.ask({ project: `Hub mac/${hub.projectName}`, task: 'two' })).toMatchObject({ ok: false, error: expect.stringContaining('No project named') })
    expect(hub.store.machines.listMachineAskConsents()).toEqual([])
    await hub.router.handle('machines.setAsks', { machineId: 'm1', on: true })
    await eventually(() => machine.hubs.any)
    const again = machine.ask({ project: hub.projectName, task: 'three' })
    await hub.answer('allow')
    expect(await again).toMatchObject({ ok: true, state: 'done' })
  })

  it('refuses an approval that comes after the switch went off while the card stood, and sends nothing', async () => {
    const { machine, hub } = await rig()
    const call = machine.ask({ project: hub.projectName, task: 'say hello' })
    await eventually(() => !!hub.card())
    // Off at the store, so only the read after the answer can see it
    hub.store.machines.setLinkedMachineAsks('m1', false)
    await hub.answer('allow')
    expect(await call).toMatchObject({ ok: false, error: expect.stringContaining('does not let sessions on Remote box') })
    expect(hub.store.messages.loadMessages('h1', 20).some((m) => (m.payload as { text?: string }).text?.includes('say hello'))).toBe(false)
    expect(hub.store.machines.listMachineAskConsents()).toEqual([])
  })

  it('withdraws the hub’s card when the machine’s call is cancelled, and sends nothing', async () => {
    const { machine, hub } = await rig()
    const ctl = new AbortController()
    const call = machine.ask({ project: hub.projectName, task: 'say hello' }, ctl.signal)
    await eventually(() => !!hub.card())
    ctl.abort()
    await eventually(() => !hub.card())
    expect(await call).toMatchObject({ ok: false })
    // The card closed unanswered; no task went in
    expect(hub.store.messages.loadMessages('h1', 20).some((m) => m.kind !== 'approval')).toBe(false)
    expect(hub.store.machines.listMachineAskConsents()).toEqual([])
  })

  // #550 review: the target's `auto` is its own, and answers no card of another machine
  it('raises the card for a hub session under auto too, and remembers nothing until Allow', async () => {
    const { machine, hub } = await rig({ preset: 'auto' })
    expect(hub.mgr.listSessions().find((s) => s.id === 'h1')?.permissionPreset).toBe('auto')
    const call = machine.ask({ project: hub.projectName, task: 'say hello' })
    await eventually(() => !!hub.card())
    expect(hub.store.machines.listMachineAskConsents()).toEqual([])
    expect(hub.store.messages.loadMessages('h1', 20).some((m) => (m.payload as { text?: string }).text?.includes('say hello'))).toBe(false)
    await hub.answer('allow')
    expect(await call).toMatchObject({ ok: true, state: 'done' })
    expect(hub.store.machines.listMachineAskConsents()).toEqual([expect.objectContaining({ machineId: 'm1', sessionId: 'w1', projectId: 'p-hub' })])
  })

  // #550 review: a call given up on the machine is withdrawn on the hub, so its card does not wait for nobody
  it('closes the hub’s card when the machine’s call runs out of time, and sends nothing', async () => {
    const { machine, hub } = await rig({ askTimeoutMs: 500 })
    const call = machine.ask({ project: hub.projectName, task: 'say hello' })
    await eventually(() => !!hub.card())
    expect(await call).toMatchObject({ ok: false, error: expect.stringContaining('did not answer hub.askProject in time') })
    await eventually(() => !hub.card())
    expect(hub.store.messages.loadMessages('h1', 20).some((m) => m.kind !== 'approval')).toBe(false)
    expect(hub.store.machines.listMachineAskConsents()).toEqual([])
  })

  it('closes a card still standing when the switch goes off', async () => {
    const { machine, hub } = await rig()
    const call = machine.ask({ project: hub.projectName, task: 'say hello' })
    await eventually(() => !!hub.card())
    await hub.router.handle('machines.setAsks', { machineId: 'm1', on: false })
    await eventually(() => !hub.card())
    expect(await call).toMatchObject({ ok: false, error: expect.stringContaining('does not let sessions on Remote box') })
    expect(hub.store.messages.loadMessages('h1', 20).some((m) => m.kind !== 'approval')).toBe(false)
  })

  it('removing the machine takes its pairs and tells the machine the hub no longer answers it', async () => {
    const { machine, hub } = await rig()
    const first = machine.ask({ project: hub.projectName, task: 'one' })
    await hub.answer('allow')
    await first
    expect(hub.store.machines.listMachineAskConsents()).toHaveLength(1)
    await hub.router.handle('machines.remove', { machineId: 'm1' })
    expect(hub.store.machines.listMachineAskConsents()).toEqual([])
    await eventually(() => !machine.hubs.any)
    expect(await machine.ask({ project: `Hub mac/${hub.projectName}`, task: 'two' })).toMatchObject({ ok: false, error: expect.stringContaining('No project named') })
  })

  it('refuses a session of the hub busy with a turn that is not the asker’s', async () => {
    const { machine, hub } = await rig()
    await hub.mgr.send('h1', 'please approve my command')
    await eventually(() => hub.mgr.listSessions().find((s) => s.id === 'h1')?.state === 'waiting_approval')
    expect(await machine.ask({ project: hub.projectName, task: 'x' })).toMatchObject({ ok: false, error: expect.stringContaining('busy with a turn that is not yours') })
  })
})

describe('several hubs, and builds from before the reverse direction (#550)', () => {
  it('shows each hub by its own name, and one whose link is down as not reachable', async () => {
    const machine = await machineHost()
    const a = await hubHost(machine.port, { name: 'Hub mac', project: 'alpha' })
    const b = await hubHost(machine.port, { name: 'Laptop', project: 'beta' })
    for (const h of [a, b]) {
      await eventually(() => h.machine().status === 'connected')
      await h.router.handle('machines.setAsks', { machineId: 'm1', on: true })
    }
    const listed = await machine.ask({ project: 'no-such-project', task: 'x' })
    expect((listed as { error: string }).error).toContain('alpha (on Hub mac)')
    expect((listed as { error: string }).error).toContain('beta (on Laptop)')

    await b.stop()
    const down = await machine.ask({ project: 'beta', task: 'x' })
    expect(down).toMatchObject({ ok: false, error: 'Laptop is not reachable right now, so beta on Laptop cannot be asked. Try again once its link is back.' })
    expect(((await machine.ask({ project: 'no-such-project', task: 'x' })) as { error: string }).error).toContain('Laptop (not reachable right now)')
    // The other hub still answers
    const call = machine.ask({ project: 'Hub mac/alpha', task: 'hello' })
    await a.answer('allow')
    expect(await call).toMatchObject({ ok: true, state: 'done', sessionId: `${a.id}.h1` })
  })

  it('a machine that does not take the offer: the hub’s row says it is told again, while the switch is on', async () => {
    const machine = await machineHost({ without: ['host.hubOffer'] })
    const hub = await hubHost(machine.port)
    await eventually(() => hub.machine().status === 'connected')
    await hub.router.handle('machines.setAsks', { machineId: 'm1', on: true })
    await eventually(() => !!hub.machine().asks?.note)
    expect(hub.machine().asks).toEqual({ on: true, note: expect.stringContaining('Remote box could not be told yet (') })
    await hub.router.handle('machines.setAsks', { machineId: 'm1', on: false })
    expect(hub.machine().asks).toEqual({ on: false, note: null })
  })

  it('a hub from before it offers nothing, so its projects cannot be named, and a call to it is dropped there', async () => {
    const machine = await machineHost()
    const hub = await hubHost(machine.port, { reverse: false })
    await eventually(() => hub.machine().status === 'connected')
    await hub.router.handle('machines.setAsks', { machineId: 'm1', on: true })
    expect(machine.hubs.any).toBe(false)
    expect(await machine.ask({ project: `Hub mac/${hub.projectName}`, task: 'x' })).toMatchObject({ ok: false, error: expect.stringContaining('No project named') })
    // Even a machine that calls it anyway gets no answer: the hub's link has no handler, and drops the call
    const client = [...(machine.server as unknown as { byClient: Map<number, unknown> }).byClient.keys()][0]!
    await expect(machine.server.call(client, 'hub.projects', {}, { timeoutMs: 300 })).rejects.toThrow('did not answer hub.projects in time')
  })

  it('a hub that offered but lacks the call is named as needing an update', async () => {
    const hubs = new LinkedHubs({ call: async () => Promise.reject(new Error('Unknown method: hub.askProject')) })
    hubs.offer(7, { hub: { id: 'hub-00000001', name: 'Old hub' }, on: true })
    expect(await hubs.ask('hub-00000001', { caller: { sessionId: 'w1', name: 'w1', project: 'p' }, project: 'x', task: 't', depth: 1 })).toEqual({
      ok: false,
      error: 'Old hub runs a Centralu from before this, so it cannot be asked. Update it there.',
    })
    expect((await hubs.projects()).away).toEqual([{ hubId: 'hub-00000001', hub: 'Old hub', why: 'it runs a Centralu from before this; update it there' }])
  })
})
