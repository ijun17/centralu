import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APP_VERSION, MachineInfo, PROTOCOL_VERSION, sessionLiveDefaults, type NormalizedEvent, type SessionInfo } from '@cc/protocol'
import { Store } from '../dev-services/store.js'
import { SessionManager } from '../sessions/manager.js'
import { createRpcHandler } from '../rpc.js'
import { HostServer } from '../transport/server.js'
import { Links, type LinkDeps } from './links.js'
import { linkedSessions } from './linked-sessions.js'
import { Router } from './router.js'
import type { ConnectionLine, Endpoint, Tunnel } from './tunnel.js'
import { storeMirror, storeRegistry } from './stored.js'
import { scriptedAdapters } from './scripted-agent.test-helpers.js'
import { eventually, SLOW } from '../../../../tooling/test-timing.js'

/**
 * Auto reconnect (#1341, owner decision 2026-10-20), a switch per linked machine and on by default. On: the hub connects
 * when it starts and after every drop, on the backoff. Off: it tries once when it starts; after a drop or a failed
 * attempt it tries no more until the person presses Connect, and an agent's call that needs the machine is answered at
 * once as not connected. Nothing connects a machine on a need any more (the connect mode of #1134 is gone).
 *
 * Two real hosts in one process, as links.test.ts runs them; only the transport is direct.
 */

const TOKEN = 'tok'
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

function folder(): string {
  const d = mkdtempSync(join(tmpdir(), 'cc-links-auto-'))
  cleanups.push(() => rmSync(d, { recursive: true, force: true }))
  return d
}

async function remoteHost(store = new Store()) {
  const adapters = scriptedAdapters()
  const mgr = new SessionManager(store, adapters, (e) => server.broadcast(e))
  const server: HostServer = new HostServer({
    port: 0,
    token: TOKEN,
    onRpc: createRpcHandler(mgr, adapters, {}),
    build: { commit: 'abc1234', protocolVersion: PROTOCOL_VERSION, version: APP_VERSION },
  })
  const port = await server.listen()
  cleanups.push(async () => {
    await mgr.disposeAll()
    await server.close()
  })
  return { mgr, store, port, server, adapters }
}

/** The remote's host goes away and comes back on the same port, as one swapped in place does */
async function bounce(remote: Awaited<ReturnType<typeof remoteHost>>) {
  await remote.server.close()
  const server: HostServer = new HostServer({
    port: remote.port,
    token: TOKEN,
    onRpc: createRpcHandler(remote.mgr, remote.adapters, {}),
    build: { commit: 'abc1234', protocolVersion: PROTOCOL_VERSION, version: APP_VERSION },
  })
  await server.listen()
  cleanups.push(() => server.close())
}

const lineFor = (port: number, over: Partial<ConnectionLine> = {}): ConnectionLine => ({
  v: 1,
  port,
  token: TOKEN,
  version: APP_VERSION,
  protocolVersion: PROTOCOL_VERSION,
  dataDir: '/remote',
  hostRunning: true,
  ...over,
})

/**
 * A tunnel that counts its openings, so a test can tell that no attempt was made. `unreachable`: ssh cannot reach the
 * machine, as a laptop that was closed. `drop()` ends the transport, as an ssh that exits does
 */
class ControlledTunnel implements Tunnel {
  opens = 0
  closes = 0
  unreachable = false
  /** What ssh says when `unreachable`; a connect timeout when absent */
  failure: string | null = null
  /** How long an opening takes, as an ssh to a slow machine */
  openMs = 0
  private downListener: ((reason: string) => void) | undefined
  constructor(private readonly line: () => ConnectionLine) {}
  async open(): Promise<Endpoint> {
    this.opens++
    if (this.openMs) await new Promise((r) => setTimeout(r, this.openMs))
    if (this.unreachable) throw new Error(this.failure ?? 'ssh could not reach laptop: ssh: connect to host laptop port 22: Operation timed out')
    const line = this.line()
    return { url: `ws://127.0.0.1:${line.port}`, token: line.token, line, localPort: line.port }
  }
  onDown(listener: (reason: string) => void): void {
    this.downListener = listener
  }
  drop(): void {
    this.downListener?.('ssh exited')
  }
  async close(): Promise<void> {
    this.closes++
  }
}

type HubOptions = { autoReconnect?: boolean; store?: Store; tunnel?: (line: () => ConnectionLine) => Tunnel; deps?: Partial<LinkDeps> }

async function hubHost(line: () => ConnectionLine, o: HubOptions = {}) {
  const store = o.store ?? new Store()
  const adapters = scriptedAdapters()
  const mgr = new SessionManager(store, adapters, (e) => server.broadcast(e))
  const registry = storeRegistry(store)
  if (!registry.list().length) {
    registry.add({ id: 'm1', name: 'Laptop', sshTarget: 'laptop', remote: { shell: 'posix' }, addedAt: 1, acceptedVersions: null })
    if (o.autoReconnect === false) registry.setAutoReconnect('m1', false)
  }
  const tunnels: Tunnel[] = []
  const events: NormalizedEvent[] = []
  const deps: LinkDeps = {
    hub: { version: APP_VERSION, protocolVersion: PROTOCOL_VERSION, dev: false },
    broadcast: (e) => {
      events.push(e)
      server.broadcast(e)
      mgr.observeLinked(e)
    },
    terminal: (f) => server.pushTerminal(f),
    mirror: storeMirror(store),
    registry,
    tunnelFor: () => {
      const t = o.tunnel ? o.tunnel(line) : new ControlledTunnel(line)
      tunnels.push(t)
      return t
    },
    retryMs: [50, 200],
    client: { maxBackoffMs: 100 },
    ...o.deps,
  }
  const links = new Links(deps)
  mgr.useLinkedSessions((id) => links.knowsSession(id))
  mgr.useLinkedReader(linkedSessions(() => links.all(), (method, params) => router.handle(method, params), 'Hub mac'))
  const router = new Router({ local: createRpcHandler(mgr, adapters, { machines: links }), machines: () => links.all() })
  const server: HostServer = new HostServer({ port: 0, token: TOKEN, onRpc: router.handle })
  await server.listen()
  links.start()
  cleanups.push(async () => {
    await links.stop()
    await mgr.disposeAll()
    await server.close()
  })
  const call = (method: string, params: unknown = {}) => router.handle(method, params) as Promise<any>
  const row = () => links.list()[0]!
  return { links, deps, store, mgr, call, row, events, tunnel: () => tunnels[0] as ControlledTunnel }
}

/** Long enough for several attempts at the test's backoff (50 ms doubling to 200 ms), scaled for a loaded machine */
const WINDOW_MS = 400 * SLOW
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

function seedSession(store: Store, projectId: string | null, id: string, kind: SessionInfo['kind'] = 'worker', externalId: string | null = null) {
  store.sessions.upsertSession({
    id,
    projectId,
    kind,
    tool: 'claude',
    externalId,
    name: id,
    autoNamed: false,
    state: 'idle',
    lastReadSeq: 0,
    lastSeq: 0,
    createdAt: Date.now(),
    waitingSince: null,
    live: false,
    model: null,
    effort: null,
    verbosity: null,
    serviceTier: null,
    permissionPreset: 'normal',
    importedFrom: null,
    worktree: null,
    parentSessionId: null,
    scopeSessionIds: null,
    roleAppend: null,
    appId: null,
    ...sessionLiveDefaults(),
  })
}

/** A git folder whose `origin` is `url`, with one commit */
function checkout(url: string): string {
  const dir = folder()
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' })
  git('init', '-q')
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'first')
  git('remote', 'add', 'origin', url)
  return dir
}

describe('the switch is kept with the machine (#1341)', () => {
  it('is on by default; a restarted hub reads the person’s choice, and the row says it', async () => {
    const remote = await remoteHost()
    const store = new Store()
    const first = await hubHost(() => lineFor(remote.port), { store })
    expect(first.row()).toMatchObject({ autoReconnect: true, connect: 'at_start' })
    expect(await first.call('machines.setAutoReconnect', { machineId: 'm1', autoReconnect: false })).toMatchObject({ autoReconnect: false, connect: 'when_needed' })
    await first.links.stop()

    expect(storeRegistry(store).list()).toEqual([expect.objectContaining({ id: 'm1', autoReconnect: false })])
    const second = await hubHost(() => lineFor(remote.port), { store })
    expect(second.row()).toMatchObject({ autoReconnect: false, connect: 'when_needed' })
  })

  it('answers the older window’s connect mode as the switch, and its need as nothing', async () => {
    const remote = await remoteHost()
    const hub = await hubHost(() => lineFor(remote.port), { autoReconnect: false })
    await eventually(() => hub.row().status === 'connected')
    expect(await hub.call('machines.setConnect', { machineId: 'm1', connect: 'at_start' })).toMatchObject({ autoReconnect: true, connect: 'at_start' })
    expect(await hub.call('machines.setConnect', { machineId: 'm1', connect: 'when_needed' })).toMatchObject({ autoReconnect: false, connect: 'when_needed' })
    // Nothing is connected for a need any more: a disconnected machine stays so
    await hub.call('machines.disconnect', { machineId: 'm1' })
    const opens = hub.tunnel().opens
    expect(await hub.call('machines.need', { machineId: 'm1' })).toMatchObject({ status: 'disconnected' })
    expect(await hub.call('machines.need', { machineId: 'm1', repeat: true })).toMatchObject({ status: 'disconnected' })
    await pause(300)
    expect(hub.row().status).toBe('disconnected')
    expect(hub.tunnel().opens).toBe(opens)
  })
})

describe('a machine with Auto reconnect off (#1341)', () => {
  it('tries once when the hub starts, and connects when it can', async () => {
    const remote = await remoteHost()
    const hub = await hubHost(() => lineFor(remote.port), { autoReconnect: false })
    await eventually(() => hub.row().status === 'connected')
    expect(hub.tunnel().opens).toBe(1)
  })

  it('does not try again after a drop within the backoff window; Connect connects', async () => {
    const remote = await remoteHost()
    const hub = await hubHost(() => lineFor(remote.port), { autoReconnect: false })
    await eventually(() => hub.row().status === 'connected')
    hub.tunnel().drop()
    expect(hub.row().status).toBe('unreachable')
    expect(hub.row().error).toMatch(/ended \(ssh exited\); press Connect to try again$/)

    await pause(WINDOW_MS)
    expect(hub.tunnel().opens).toBe(1)
    expect(hub.row().status).toBe('unreachable')

    await hub.call('machines.reconnect', { machineId: 'm1' })
    await eventually(() => hub.row().status === 'connected')
    expect(hub.tunnel().opens).toBe(2)
  })

  it('does not try again after a failed attempt; Connect tries, and keeps trying only as one attempt does', async () => {
    const remote = await remoteHost()
    let tunnel: ControlledTunnel | undefined
    const hub = await hubHost(() => lineFor(remote.port), {
      autoReconnect: false,
      tunnel: (line) => {
        tunnel = new ControlledTunnel(line)
        tunnel.unreachable = true
        return tunnel
      },
    })
    // A connect that timed out: the machine does not answer (#1398)
    await eventually(() => hub.row().status === 'away')
    await pause(WINDOW_MS)
    expect(tunnel!.opens).toBe(1)

    tunnel!.unreachable = false
    await hub.call('machines.reconnect', { machineId: 'm1' })
    await eventually(() => hub.row().status === 'connected')
    expect(tunnel!.opens).toBe(2)
  })

  it('dials a short drop again at once, over the same forward: a host that is back within the redials reconnects with no new ssh', async () => {
    const remote = await remoteHost()
    const hub = await hubHost(() => lineFor(remote.port), { autoReconnect: false })
    await eventually(() => hub.row().status === 'connected')
    // Every connect says so to the windows (`machine_resync`): a second one is the link coming back after the drop
    const resyncs = () => hub.events.filter((e: any) => e.type === 'machine_resync').length
    const before = resyncs()
    await bounce(remote)
    await eventually(() => resyncs() > before && hub.row().status === 'connected')
    expect(hub.tunnel().opens).toBe(1)
    expect(hub.tunnel().closes).toBe(0)
  })

  it('is not said to wait for the person while it redials after a drop', async () => {
    const remote = await remoteHost()
    const hub = await hubHost(() => lineFor(remote.port), { autoReconnect: false })
    await eventually(() => hub.row().status === 'connected')
    await remote.server.close()
    await eventually(() => hub.row().status === 'unreachable')
    expect(hub.row().error).toMatch(/; reconnecting$/)
    expect(hub.links.get('m1')!.waitsForPerson).toBe(false)
    await eventually(() => hub.links.get('m1')!.waitsForPerson)
  })

  it('stays down after the redials fail: the link says so, closes the forward and waits for Connect', async () => {
    const remote = await remoteHost()
    const hub = await hubHost(() => lineFor(remote.port), { autoReconnect: false })
    await eventually(() => hub.row().status === 'connected')
    await remote.server.close()
    await eventually(() => hub.row().status === 'unreachable' && /press Connect to try again$/.test(hub.row().error ?? ''))
    await pause(WINDOW_MS)
    expect(hub.tunnel().opens).toBe(1)
    expect(hub.row().status).toBe('unreachable')
  })

  it('is not said to wait for the person while its attempt at the start is under way', async () => {
    const remote = await remoteHost()
    const hub = await hubHost(() => lineFor(remote.port), {
      autoReconnect: false,
      tunnel: (line) => {
        const t = new ControlledTunnel(line)
        t.openMs = 400 * SLOW
        return t
      },
    })
    const machine = hub.links.get('m1')!
    expect(hub.row().status).toBe('connecting')
    expect(machine.waitsForPerson).toBe(false)
    await eventually(() => hub.row().status === 'connected')
    expect(machine.waitsForPerson).toBe(false)
    hub.tunnel().drop()
    expect(machine.waitsForPerson).toBe(true)
  })

  it('turned off while connected, it stays connected, and a later drop is not retried', async () => {
    const remote = await remoteHost()
    const hub = await hubHost(() => lineFor(remote.port))
    await eventually(() => hub.row().status === 'connected')
    await hub.call('machines.setAutoReconnect', { machineId: 'm1', autoReconnect: false })
    await pause(150)
    expect(hub.row().status).toBe('connected')
    hub.tunnel().drop()
    await pause(WINDOW_MS)
    expect(hub.row().status).toBe('unreachable')
    expect(hub.tunnel().opens).toBe(1)
  })

  it('closes the ssh forward once its client gave up redialling, since nothing uses it before Connect', async () => {
    const remote = await remoteHost()
    const hub = await hubHost(() => lineFor(remote.port), { autoReconnect: false })
    await eventually(() => hub.row().status === 'connected')
    expect(hub.tunnel().closes).toBe(0)
    await remote.server.close()
    await eventually(() => hub.tunnel().closes >= 1)
    expect(hub.row().status).toBe('unreachable')
  })

  it('turning it off does not cancel the retries of an install or update that is running; the switch takes effect after', async () => {
    const remote = await remoteHost()
    const hub = await hubHost(() => lineFor(remote.port))
    await eventually(() => hub.row().status === 'connected')
    // What `operate` sets while an install or update runs
    ;(hub.links.get('m1') as unknown as { busy: string }).busy = 'update'
    hub.tunnel().unreachable = true
    hub.tunnel().drop()
    await eventually(() => hub.tunnel().opens >= 3)
    await hub.call('machines.setAutoReconnect', { machineId: 'm1', autoReconnect: false })
    const opens = hub.tunnel().opens
    hub.tunnel().unreachable = false
    // The operation's retry still comes, and its check (the host's hello) is met
    await eventually(() => hub.tunnel().opens > opens && hub.row().status === 'connected')
  })

  it('turned off while a retry waits, the retry is cancelled and the row says it waits for Connect', async () => {
    const remote = await remoteHost()
    const hub = await hubHost(() => lineFor(remote.port), { deps: { retryMs: [200 * SLOW, 400 * SLOW] } })
    await eventually(() => hub.row().status === 'connected')
    hub.tunnel().unreachable = true
    hub.tunnel().drop()
    expect(hub.row().error).toMatch(/; reconnecting$/)
    await hub.call('machines.setAutoReconnect', { machineId: 'm1', autoReconnect: false })
    expect(hub.row().error).toMatch(/; press Connect to try again$/)
    await pause(600 * SLOW)
    expect(hub.tunnel().opens).toBe(1)
  })

  it('turned on while it is away, it tries again at once', async () => {
    const remote = await remoteHost()
    const hub = await hubHost(() => lineFor(remote.port), { autoReconnect: false })
    await eventually(() => hub.row().status === 'connected')
    hub.tunnel().drop()
    await pause(150)
    expect(hub.tunnel().opens).toBe(1)
    await hub.call('machines.setAutoReconnect', { machineId: 'm1', autoReconnect: true })
    await eventually(() => hub.row().status === 'connected')
    expect(hub.tunnel().opens).toBe(2)
    // And it does as before from here on: the next drop is retried by itself
    hub.tunnel().drop()
    await eventually(() => hub.tunnel().opens === 3 && hub.row().status === 'connected')
  })

  it('still looks again at the versions that held it, and connects nothing', async () => {
    const remote = await remoteHost()
    let line = lineFor(remote.port, { protocolVersion: PROTOCOL_VERSION + 1 })
    const hub = await hubHost(() => line, { autoReconnect: false, deps: { versionsRetryMs: 100 } })
    await eventually(() => hub.row().status === 'versions_differ')
    line = lineFor(remote.port)
    await eventually(() => hub.row().status === 'unreachable')
    expect(hub.row().error).toContain('Auto reconnect is off')
    expect(hub.row().versions).toMatchObject({ compatible: true })
    const opens = hub.tunnel().opens
    await pause(300)
    expect(hub.tunnel().opens).toBe(opens)
    expect(hub.row().status).toBe('unreachable')
    // The person's Connect connects, as ever
    await hub.call('machines.reconnect', { machineId: 'm1' })
    await eventually(() => hub.row().status === 'connected')
  })
})

describe('a call that needs a machine that is connecting (#1341)', () => {
  async function connecting(deps: Partial<LinkDeps> = {}) {
    const remoteStore = new Store()
    remoteStore.projects.addProject({ id: 'p-app', path: checkout('git@github.com:me/app.git'), name: 'app-checkout' })
    seedSession(remoteStore, 'p-app', 'w1', 'worker', 'ext-w1')
    const remote = await remoteHost(remoteStore)
    let tunnel: ControlledTunnel | undefined
    const hub = await hubHost(() => lineFor(remote.port), {
      autoReconnect: false,
      deps,
      tunnel: (line) => {
        tunnel = new ControlledTunnel(line)
        tunnel.openMs = 500 * SLOW
        return tunnel
      },
    })
    const reader = linkedSessions(() => hub.links.all(), (method, params) => hub.call(method, params), 'Hub mac')
    return { hub, reader, tunnel: () => tunnel! }
  }

  it('waits for the attempt and then goes through', async () => {
    const { hub, reader } = await connecting()
    expect(hub.row().status).toBe('connecting')
    expect(await reader.read('m1.w1', 1)).toMatchObject({ ok: true })
    expect(hub.row().status).toBe('connected')
  })

  it('waits only so long, then says it is not reachable right now; it does not say the person must connect it', async () => {
    const { hub, reader } = await connecting({ attemptWaitMs: 50 })
    const r = await reader.read('m1.w1', 1)
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('not reachable right now') })
    expect((r as { error: string }).error).not.toContain('ask the person')
    await eventually(() => hub.row().status === 'connected')
  })

  it('answers at once when nothing is trying', async () => {
    const { hub, reader, tunnel } = await connecting()
    await eventually(() => hub.row().status === 'connected')
    tunnel().drop()
    const at = Date.now()
    expect(await reader.read('m1.w1', 1)).toMatchObject({ ok: false, error: expect.stringContaining('ask the person to connect it') })
    expect(Date.now() - at).toBeLessThan(200 * SLOW)
  })
})

describe('a child working on a machine whose Auto reconnect is off (#1341)', () => {
  /** A hub with the switch off whose child on Laptop keeps its turn open (it asks a question), so its report is owed */
  async function busyChild(o: { autoReconnect?: boolean; deps?: Partial<LinkDeps> } = {}) {
    const remoteStore = new Store()
    remoteStore.projects.addProject({ id: 'p-app', path: checkout('git@github.com:me/app.git'), name: 'app-checkout' })
    const remote = await remoteHost(remoteStore)
    const hubStore = new Store()
    hubStore.projects.addProject({ id: 'p-hub', path: checkout('https://github.com/me/app'), name: 'app' })
    seedSession(hubStore, 'p-hub', 'h1', 'worker', 'ext-h1')
    const hub = await hubHost(() => lineFor(remote.port), { store: hubStore, autoReconnect: o.autoReconnect ?? false, ...(o.deps ? { deps: o.deps } : {}) })
    await hub.mgr.setProjectTrusted('p-hub', true)
    await eventually(() => hub.row().status === 'connected')
    const call = hub.mgr.startAgent('h1', { task: 'question: proceed?', machine: 'Laptop' })
    const card = () => hub.mgr.listSessions().find((x) => x.id === 'h1')?.pendingApproval
    await eventually(() => !!card())
    await hub.mgr.respondApproval('h1', card()!.requestId, 'allow')
    expect(await call).toMatchObject({ ok: true })
    const owed = () => (hub.mgr as unknown as { children: { linkedReports: Map<string, unknown> } }).children.linkedReports.size
    await eventually(() => owed() === 1)
    const said = async () => (await hub.mgr.loadMessages('h1', 50)).map((m: any) => JSON.stringify(m.payload)).join(' ')
    return { remote, hub, owed, said }
  }

  it('tells the caller when the link drops and nothing will reconnect it, once, and keeps its wait', async () => {
    const { hub, owed, said } = await busyChild()
    hub.tunnel().drop()
    await eventually(async () => (await said()).includes('Auto reconnect is off'))
    const text = await said()
    expect(text).toContain('ask the person to connect it')
    // One notice for one drop, and the wait stands for the report the notice promises
    expect(text.split('dropped while').length - 1).toBe(1)
    expect(owed()).toBe(1)
  })

  it("reports the end of the child's turn once the person has connected the machine, as the notice says", async () => {
    const { remote, hub, owed, said } = await busyChild()
    hub.tunnel().drop()
    await eventually(async () => (await said()).includes('Auto reconnect is off'))
    await hub.call('machines.reconnect', { machineId: 'm1' })
    await eventually(() => hub.row().status === 'connected')
    const child = remote.mgr.listSessions().find((s: any) => s.pendingQuestions?.length) as any
    remote.mgr.answerQuestion(child.id, child.pendingQuestions[0].requestId, [{ answers: ['Yes'] } as any])
    await eventually(async () => (await said()).includes('answered: Yes'))
    await eventually(() => owed() === 0)
  })

  it('tells the caller again when the person turns Auto reconnect off while the machine is down and waiting to retry', async () => {
    const { hub, said } = await busyChild({ autoReconnect: true, deps: { retryMs: [60_000, 60_000] } })
    hub.tunnel().unreachable = true
    hub.tunnel().drop()
    // Told at the first sign, as before: the link is down and will be tried again
    await eventually(async () => (await said()).includes('dropped while'))
    expect(await said()).not.toContain('Auto reconnect is off')
    await hub.call('machines.setAutoReconnect', { machineId: 'm1', autoReconnect: false })
    await eventually(async () => (await said()).includes('Auto reconnect is off'))
    expect(await said()).toContain('ask the person to connect it')
  })

  it('says the person disconnected it, not that Auto reconnect is off, when the switch is on', async () => {
    const { hub, said } = await busyChild()
    await hub.call('machines.setAutoReconnect', { machineId: 'm1', autoReconnect: true })
    await hub.call('machines.disconnect', { machineId: 'm1' })
    await eventually(async () => (await said()).includes('The person disconnected the machine'))
    expect(await said()).not.toContain('Auto reconnect is off')
  })

  it('tells the caller once the quick redials have failed, not at the first sign of a drop', async () => {
    const { remote, hub, owed, said } = await busyChild()
    await remote.server.close()
    await eventually(() => hub.row().status === 'unreachable')
    // Redialling: nobody has been told yet
    expect(await said()).not.toContain('Auto reconnect is off')
    await eventually(async () => (await said()).includes('Auto reconnect is off'))
    expect(owed()).toBe(1)
  })

  it('keeps the wait through a short drop that the quick redial recovers', async () => {
    const { remote, hub, owed, said } = await busyChild()
    const resyncs = () => hub.events.filter((e: any) => e.type === 'machine_resync').length
    const before = resyncs()
    await bounce(remote)
    await eventually(() => resyncs() > before && hub.row().status === 'connected')
    expect(hub.tunnel().opens).toBe(1)
    expect(await said()).not.toContain('Auto reconnect is off')
    expect(owed()).toBe(1)
  })

  it('keeps the wait while an install or update retries on the machine', async () => {
    const { hub, owed, said } = await busyChild()
    ;(hub.links.get('m1') as unknown as { busy: string }).busy = 'update'
    hub.tunnel().unreachable = true
    hub.tunnel().drop()
    await eventually(() => hub.tunnel().opens >= 2)
    expect(owed()).toBe(1)
    expect(await said()).not.toContain('Auto reconnect is off')
  })

  it('says the machine waits for the person once a failed attempt is over, not while it is under way', async () => {
    const remote = await remoteHost()
    const hub = await hubHost(() => lineFor(remote.port), { autoReconnect: false })
    await eventually(() => hub.row().status === 'connected')
    hub.tunnel().unreachable = true
    hub.tunnel().drop()
    await eventually(() => hub.row().status === 'unreachable')
    // The person's Connect fails: its status is set while the attempt is still under way
    const machine = hub.links.get('m1')!
    const waits: boolean[] = []
    const broadcast = hub.deps.broadcast
    hub.deps.broadcast = (e) => {
      broadcast(e)
      if (e.type === 'machine_status') waits.push(machine.waitsForPerson)
    }
    await hub.call('machines.reconnect', { machineId: 'm1' })
    await eventually(() => waits.at(-1) === true)
    expect(waits).toContain(false)
  })
})

/*
 * A machine that does not answer at all (#1398): ssh's connect timed out, there is no route, or the name does not resolve. It is
 * asleep, off or off the network: the row says `away`, with when it was last connected and when the hub tries again, and ssh's
 * own line as the details. A real failure (a key refused, a host key changed) stays an error, `unreachable`, with its reason.
 */
describe('a machine that does not answer (#1398)', () => {
  const NO_ANSWER = [
    'ssh could not reach laptop: ssh: connect to host laptop port 22: Operation timed out',
    'ssh could not reach laptop: ssh: connect to host laptop port 22: Connection timed out',
    'ssh could not reach laptop: ssh: connect to host laptop port 22: No route to host',
    'ssh could not reach laptop: ssh: connect to host laptop port 22: Network is unreachable',
    'ssh could not reach laptop: ssh: Could not resolve hostname jungi.tail3d9122.ts.net: Name or service not known',
    'ssh could not reach laptop: ssh: Could not resolve hostname laptop: No such host is known.',
  ]
  const REAL_FAILURES = [
    'ssh could not reach laptop: me@laptop: Permission denied (publickey).',
    'ssh could not reach laptop: Host key verification failed.',
    'ssh could not reach laptop: @@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@',
    'ssh could not reach laptop: ssh: connect to host laptop port 22: Connection refused',
  ]

  async function down(failure: string, deps: Partial<LinkDeps> = {}, autoReconnect = true, port?: number) {
    let tunnel: ControlledTunnel | undefined
    const remote = await remoteHost()
    const hub = await hubHost(() => lineFor(port ?? remote.port), {
      autoReconnect,
      deps,
      tunnel: (line) => {
        tunnel = new ControlledTunnel(line)
        tunnel.unreachable = true
        tunnel.failure = failure
        return tunnel
      },
    })
    const statuses = () => hub.events.flatMap((e: any) => (e.type === 'machine_status' ? [e.machine.status as string] : []))
    return { hub, tunnel: () => tunnel as ControlledTunnel, statuses, remote }
  }

  for (const failure of NO_ANSWER) {
    it(`shows "${failure.split(': ').slice(-1)[0]}" as away, with ssh's line kept as the details`, async () => {
      const { hub } = await down(failure)
      await eventually(() => hub.row().status === 'away')
      expect(hub.row().error).toBe(failure)
    })
  }

  for (const failure of REAL_FAILURES) {
    it(`keeps "${failure.split(': ').slice(-1)[0]}" an error, with its reason`, async () => {
      const { hub } = await down(failure)
      await eventually(() => hub.row().status === 'unreachable')
      expect(hub.row().error).toBe(failure)
    })
  }

  it('says when it was last connected: a machine that was up and went to sleep', async () => {
    const remote = await remoteHost()
    const hub = await hubHost(() => lineFor(remote.port))
    await eventually(() => hub.row().status === 'connected')
    const connectedAt = hub.row().lastConnectedAt
    expect(connectedAt).toEqual(expect.any(Number))
    // The laptop closes: the link drops, and every attempt after it times out
    hub.tunnel().unreachable = true
    hub.tunnel().drop()
    expect(hub.row().status).toBe('unreachable')
    await eventually(() => hub.row().status === 'away')
    expect(hub.row().lastConnectedAt).toBe(connectedAt)
  })

  it('stays away between attempts that fail alike, without flipping to connecting', async () => {
    const { hub, tunnel, statuses } = await down(NO_ANSWER[0]!)
    await eventually(() => tunnel().opens >= 5)
    const seen = statuses()
    expect(seen).toContain('away')
    // Connecting came once, at the start; after the first away there is none until something answers
    expect(seen.slice(seen.indexOf('away'))).not.toContain('connecting')
    expect(hub.row().status).toBe('away')
  })

  it('says when the next attempt is due, and tells the windows again at each attempt, though the status does not change', async () => {
    const { hub, tunnel } = await down(NO_ANSWER[0]!, { retryMs: [150 * SLOW, 150 * SLOW] })
    await eventually(() => hub.row().status === 'away' && hub.row().nextAttemptAt !== null)
    expect(hub.row().nextAttemptAt as number).toBeGreaterThan(Date.now() - 50)
    await eventually(() => tunnel().opens >= 4)
    // What the windows were told: the row of each attempt carries its own time, later than the one before
    const told = hub.events.flatMap((e: any) => (e.type === 'machine_status' && e.machine.status === 'away' && e.machine.nextAttemptAt ? [e.machine.nextAttemptAt as number] : []))
    expect(new Set(told).size).toBeGreaterThanOrEqual(3)
    expect([...told]).toEqual([...told].sort((a, b) => a - b))
  })

  it('says no attempt is due when Auto reconnect is off, and tries none', async () => {
    const { hub, tunnel } = await down(NO_ANSWER[0]!, {}, false)
    await eventually(() => hub.row().status === 'away')
    expect(hub.row().nextAttemptAt).toBeNull()
    const opens = tunnel().opens
    await pause(WINDOW_MS)
    expect(tunnel().opens).toBe(opens)
  })

  it('is connecting while the person\'s Connect tries, and connected at once when the machine answers', async () => {
    const { hub, tunnel, statuses } = await down(NO_ANSWER[0]!, { retryMs: [60_000, 60_000] })
    await eventually(() => hub.row().status === 'away')
    const before = statuses().length
    tunnel().unreachable = false
    await hub.call('machines.reconnect', { machineId: 'm1' })
    await eventually(() => hub.row().status === 'connected')
    // The person's Connect shows what it does; the backoff's own attempts stay quiet
    expect(statuses().slice(before)).toContain('connecting')
    expect(hub.row().nextAttemptAt).toBeNull()
  })

  it('is not away once ssh answers, whatever comes of the rest of the attempt', async () => {
    // ssh gets through, but nothing listens at the host there: the link is connecting, not away, while it tries
    const { hub, tunnel, statuses } = await down(NO_ANSWER[0]!, { retryMs: [200 * SLOW, 200 * SLOW] }, true, 1)
    await eventually(() => hub.row().status === 'away')
    const away = statuses().length
    tunnel().unreachable = false
    tunnel().failure = null
    await eventually(() => statuses().length > away)
    expect(statuses()[away]).toBe('connecting')
  })
})

describe('a machine with Auto reconnect on (#1341)', () => {
  it('tries again after a failed attempt, and after a drop, on the backoff as before', async () => {
    const remote = await remoteHost()
    let tunnel: ControlledTunnel | undefined
    const hub = await hubHost(() => lineFor(remote.port), {
      tunnel: (line) => {
        tunnel = new ControlledTunnel(line)
        tunnel.unreachable = true
        return tunnel
      },
    })
    await eventually(() => tunnel!.opens >= 3)
    expect(hub.row().status).toBe('away')
    tunnel!.unreachable = false
    await eventually(() => hub.row().status === 'connected')

    const opens = tunnel!.opens
    tunnel!.drop()
    expect(hub.row().error).toMatch(/; reconnecting$/)
    await eventually(() => tunnel!.opens > opens && hub.row().status === 'connected')
  })
})

describe('the person’s Disconnect and Connect (#1134)', () => {
  it('disconnects it without unlinking it and connects it again, whatever the switch says', async () => {
    for (const autoReconnect of [true, false]) {
      const remote = await remoteHost()
      const p = await remote.mgr.addProject(folder())
      const hub = await hubHost(() => lineFor(remote.port), { autoReconnect })
      await eventually(() => hub.row().status === 'connected')

      expect(await hub.call('machines.disconnect', { machineId: 'm1' })).toMatchObject({ status: 'disconnected', error: null })
      expect(hub.links.list().map((m) => m.id)).toEqual(['m1'])
      expect(await hub.call('projects.list')).toEqual([expect.objectContaining({ id: `m1.${p.id}`, unreachable: true })])
      const opens = hub.tunnel().opens
      await pause(300)
      expect(hub.tunnel().opens).toBe(opens)
      expect(hub.row().status).toBe('disconnected')

      await hub.call('machines.reconnect', { machineId: 'm1' })
      await eventually(() => hub.row().status === 'connected')
    }
  })

  it('its sessions keep running there while it is not connected, and what they said is read once it is back', async () => {
    const remote = await remoteHost()
    const p = await remote.mgr.addProject(folder())
    const hub = await hubHost(() => lineFor(remote.port), { autoReconnect: false })
    await eventually(() => hub.row().status === 'connected')
    const s = await hub.call('agents.createSession', { projectId: `m1.${p.id}`, cwd: p.path, tool: 'claude' })
    await hub.call('machines.disconnect', { machineId: 'm1' })

    // Someone at that machine works in the session meanwhile
    const there = s.id.slice('m1.'.length)
    await remote.mgr.send(there, 'while you were away')
    /*
     * Wait for the turn there to have answered and ended: its reply stored, the session resting after it. Waiting for
     * `idle` passed at once, since the session is still idle when send returns and its turn starts 20 ms later (the
     * scripted agent), and a turn ends in `waiting_input`, not `idle`. A loaded runner then read the history after the
     * reconnect before the reply was in it (a full-tier failure of #1238)
     */
    await eventually(async () => (await remote.mgr.loadMessages(there, 200)).some((m: any) => m.payload?.text === 'echo: while you were away'))
    await eventually(() => remote.mgr.listSessions().find((x) => x.id === there)?.state === 'waiting_input')
    await expect(hub.call('messages.load', { sessionId: s.id })).rejects.toMatchObject({ data: { reason: 'unreachable' } })

    const resyncs = hub.events.filter((e: any) => e.type === 'machine_resync').length
    await hub.call('machines.reconnect', { machineId: 'm1' })
    await eventually(() => hub.row().status === 'connected')
    expect(hub.events.filter((e: any) => e.type === 'machine_resync').length).toBeGreaterThan(resyncs)
    const history = await hub.call('messages.load', { sessionId: s.id })
    expect(history.some((m: any) => m.payload?.text === 'echo: while you were away')).toBe(true)
  })

  it('an operation the person asks of a disconnected machine connects it first, and it stays up', async () => {
    const remote = await remoteHost()
    const hub = await hubHost(() => lineFor(remote.port), { autoReconnect: false })
    await eventually(() => hub.row().status === 'connected')
    await hub.call('machines.disconnect', { machineId: 'm1' })
    // A direct tunnel has no shell, so the operation is refused; the link is up anyway, as it would be for ssh
    await expect(hub.call('machines.autostart', { machineId: 'm1' })).rejects.toThrow(/no shell/)
    await eventually(() => hub.row().status === 'connected')
    await pause(300)
    expect(hub.row().status).toBe('connected')
  })
})

describe('the backoff after a good connection (#1134)', () => {
  /*
   * With a cap of 5 minutes, a link that kept its count after connecting would wait minutes after its next drop. Once
   * the connection has stayed up a while (`stableMs`, #1143), not at its hello: a host that answers and stops again at
   * once would otherwise be started again at the first step for good
   */
  it('starts again from its first step once a connection stayed up a while', async () => {
    const remote = await remoteHost()
    let tunnel: ControlledTunnel | undefined
    const hub = await hubHost(() => lineFor(remote.port), {
      tunnel: (line) => {
        tunnel = new ControlledTunnel(line)
        tunnel.unreachable = true
        return tunnel
      },
      deps: { retryMs: [10, 60_000], stableMs: 20 },
    })
    await eventually(() => tunnel!.opens >= 3)
    tunnel!.unreachable = false
    await eventually(() => hub.row().status === 'connected')
    // A timer set after the stable one, so it runs after it whatever the load
    await pause(100)
    // The drop schedules the next attempt at once (`transportDown`); its delay is the last timer set
    const timers = vi.spyOn(globalThis, 'setTimeout')
    try {
      tunnel!.drop()
      const delays = timers.mock.calls.map((c) => c[1])
      expect(delays.at(-1)).toBe(10)
    } finally {
      timers.mockRestore()
    }
    await eventually(() => hub.row().status === 'connected')
  })
})

describe('the setting across builds (#1341)', () => {
  const row = {
    id: 'm1', name: 'Laptop', sshTarget: 'laptop', shell: 'posix', wslDistro: null, command: null, status: 'connected', error: null, versions: null,
    lastConnectedAt: null, localPort: null, sameLocalPort: false, hostStarted: null, install: null, operation: null, autostart: null, elevated: null,
  }

  it('reads a row from an older hub, which sends none, as on; and a value it does not know the same', () => {
    expect(MachineInfo.parse(row).autoReconnect).toBe(true)
    expect(MachineInfo.parse({ ...row, autoReconnect: 'on_tuesdays' }).autoReconnect).toBe(true)
    expect(MachineInfo.parse({ ...row, autoReconnect: false }).autoReconnect).toBe(false)
    // The older connect mode is still read for one release
    expect(MachineInfo.parse({ ...row, connect: 'when_needed' }).connect).toBe('when_needed')
  })

  it('reads a status a newer hub may send and this window does not know as unreachable', () => {
    expect(MachineInfo.parse({ ...row, status: 'asleep' }).status).toBe('unreachable')
  })

  it('reads a machine an older host stored as connecting when needed with the switch off, and one with no value as on', () => {
    const store = new Store()
    store.machines.addLinkedMachine({ id: 'm1', name: 'Laptop', sshTarget: 'laptop', remote: { shell: 'posix' }, addedAt: 1, acceptedVersions: null })
    expect(store.machines.listLinkedMachines()[0]!.autoReconnect).toBe(true)
    // What the connect mode wrote (v59): the column holds `when_needed`
    store.machines.addLinkedMachine({ id: 'm2', name: 'Server', sshTarget: 'server', remote: { shell: 'posix' }, addedAt: 2, acceptedVersions: null })
    ;(store as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db
      .prepare(`UPDATE linked_machines SET connect = 'when_needed' WHERE id = 'm2'`)
      .run()
    expect(store.machines.listLinkedMachines().map((m) => [m.id, m.autoReconnect])).toEqual([['m1', true], ['m2', false]])
    store.machines.setLinkedMachineAutoReconnect('m1', false)
    expect(store.machines.listLinkedMachines()[0]!.autoReconnect).toBe(false)
    store.machines.setLinkedMachineAutoReconnect('m1', true)
    expect(store.machines.listLinkedMachines()[0]!.autoReconnect).toBe(true)
    store.close()
  })
})

describe("an agent's call on a machine nothing here will connect is answered at once (#1341)", () => {
  /**
   * A remote with a checkout of the hub's repository and a worker that can resume, and a hub whose trusted project's
   * session h1 asks. The hub connected once, so its mirror knows the machine; then its Auto reconnect is off and the
   * link is gone, as it stands after a drop
   */
  async function rig(o: { off?: boolean; deps?: Partial<LinkDeps> } = {}) {
    const remoteStore = new Store()
    remoteStore.projects.addProject({ id: 'p-app', path: checkout('git@github.com:me/app.git'), name: 'app-checkout' })
    seedSession(remoteStore, 'p-app', 'w1', 'worker', 'ext-w1')
    const remote = await remoteHost(remoteStore)
    const hubStore = new Store()
    hubStore.projects.addProject({ id: 'p-hub', path: checkout('https://github.com/me/app'), name: 'app' })
    seedSession(hubStore, 'p-hub', 'h1', 'worker', 'ext-h1')
    const hub = await hubHost(() => lineFor(remote.port), { store: hubStore, ...(o.deps ? { deps: o.deps } : {}) })
    await hub.mgr.setProjectTrusted('p-hub', true)
    await eventually(() => hub.row().status === 'connected')
    if (o.off !== false) {
      await hub.call('machines.setAutoReconnect', { machineId: 'm1', autoReconnect: false })
      hub.tunnel().drop()
      await eventually(() => hub.row().status === 'unreachable')
    }
    const opens = hub.tunnel().opens
    const name = (await remote.mgr.listProjects()).find((p) => p.id === 'p-app')!.name
    const reader = linkedSessions(() => hub.links.all(), (method, params) => hub.call(method, params), 'Hub mac')
    return { remote, hub, opens, name, reader }
  }
  const askThePerson = expect.stringContaining('ask the person to connect it')

  it('start_agent with the machine says it is not connected and who can connect it, and connects nothing', async () => {
    const { hub, opens } = await rig()
    const at = Date.now()
    const r = await hub.mgr.startAgent('h1', { task: 'say hello', machine: 'Laptop' })
    expect(r).toMatchObject({ ok: false, error: askThePerson })
    expect(Date.now() - at).toBeLessThan(5_000 * SLOW)
    await pause(WINDOW_MS)
    expect(hub.tunnel().opens).toBe(opens)
    expect(hub.row().status).toBe('unreachable')
  })

  it('does the same for a machine the person disconnected, whatever the switch says', async () => {
    const { hub, opens } = await rig({ off: false })
    await hub.call('machines.disconnect', { machineId: 'm1' })
    expect(await hub.mgr.startAgent('h1', { task: 'say hello', machine: 'Laptop' })).toMatchObject({ ok: false, error: askThePerson })
    expect(hub.tunnel().opens).toBe(opens)
  })

  it('ask_project names its project as last listed, and says the machine is not connected', async () => {
    const { hub, opens, name } = await rig()
    expect(await hub.mgr.askProject('h1', { project: `Laptop/${name}`, task: 'say hello' })).toMatchObject({ ok: false, error: askThePerson })
    expect(hub.tunnel().opens).toBe(opens)
  })

  it('a send to a session there, reading it and its last words say so too', async () => {
    const { hub, opens, reader } = await rig()
    for (const r of [await reader.send('m1.w1', 'hello', 'h1'), await reader.read('m1.w1', 1), await reader.lastWords('m1.w1', 100)]) {
      expect(r).toMatchObject({ ok: false, error: askThePerson })
    }
    expect(hub.tunnel().opens).toBe(opens)
  })

  it('looking a project name up lists its projects as away, and connects nothing', async () => {
    const { hub, opens, name } = await rig()
    const r = await hub.mgr.askProject('h1', { project: 'no-such-project' })
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining(`${name} (on Laptop, not connected until the person connects it)`) })
    expect(hub.tunnel().opens).toBe(opens)
  })

  it('a machine with the switch on that is away is still said to be away for now, as before', async () => {
    const { hub } = await rig({ off: false, deps: { retryMs: [30_000, 30_000] } })
    hub.tunnel().unreachable = true
    hub.tunnel().drop()
    expect(hub.row().status).toBe('unreachable')
    const r = await hub.mgr.startAgent('h1', { task: 'say hello', machine: 'Laptop' })
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('Laptop cannot be reached') })
    expect((r as { error: string }).error).not.toContain('ask the person')
  })

  it('once the person connects it, the same call goes through', async () => {
    const { hub } = await rig()
    await hub.call('machines.reconnect', { machineId: 'm1' })
    await eventually(() => hub.row().status === 'connected')
    const call = hub.mgr.startAgent('h1', { task: 'say hello', machine: 'Laptop' })
    const card = () => hub.mgr.listSessions().find((x) => x.id === 'h1')?.pendingApproval
    await eventually(() => !!card())
    await hub.mgr.respondApproval('h1', card()!.requestId, 'allow')
    expect(await call).toMatchObject({ ok: true })
  })
})
