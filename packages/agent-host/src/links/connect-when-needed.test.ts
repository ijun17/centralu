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
import { DirectTunnel, type ConnectionLine, type Endpoint, type Tunnel } from './tunnel.js'
import { storeMirror, storeRegistry } from './stored.js'
import { scriptedAdapters } from './scripted-agent.test-helpers.js'
import { eventually, SLOW } from '../../../../tooling/test-timing.js'

/**
 * A machine that connects when needed (#1134, owner decision 2026-10-18): not connected at start; connected when the
 * window opens one of its projects or sessions (`machines.need`) or when the person connects it; kept connected while
 * something needs it and while a session there is in a turn; disconnected by the person without being unlinked. Its
 * sessions keep running there while it is not connected, and what they said is read once the link is up again.
 *
 * Two real hosts in one process, as links.test.ts runs them; only the transport is direct.
 */

const TOKEN = 'tok'
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

function folder(): string {
  const d = mkdtempSync(join(tmpdir(), 'cc-links-needed-'))
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
  return { mgr, store, port }
}

const lineFor = (port: number): ConnectionLine => ({ v: 1, port, token: TOKEN, version: APP_VERSION, protocolVersion: PROTOCOL_VERSION, dataDir: '/remote', hostRunning: true })

/** A tunnel that counts its openings, so a test can tell that no attempt was made */
class CountingTunnel extends DirectTunnel {
  opens = 0
  constructor(line: () => ConnectionLine | Promise<ConnectionLine>) {
    super(async () => {
      this.opens++
      return line()
    })
  }
}

type HubOptions = { connect?: 'at_start' | 'when_needed'; store?: Store; tunnel?: (line: () => ConnectionLine) => Tunnel; deps?: Partial<LinkDeps> }

async function hubHost(line: () => ConnectionLine, o: HubOptions = {}) {
  const store = o.store ?? new Store()
  const adapters = scriptedAdapters()
  const mgr = new SessionManager(store, adapters, (e) => server.broadcast(e))
  const registry = storeRegistry(store)
  if (!registry.list().length) {
    registry.add({ id: 'm1', name: 'Laptop', sshTarget: 'laptop', remote: { shell: 'posix' }, addedAt: 1, acceptedVersions: null })
    if (o.connect) registry.setConnect('m1', o.connect)
  }
  const tunnels: Tunnel[] = []
  const events: NormalizedEvent[] = []
  const deps: LinkDeps = {
    hub: { version: APP_VERSION, protocolVersion: PROTOCOL_VERSION, dev: false },
    workOwed: (machineId) => mgr.linkedWorkOwed(machineId),
    broadcast: (e) => {
      events.push(e)
      server.broadcast(e)
      mgr.observeLinked(e)
    },
    terminal: (f) => server.pushTerminal(f),
    mirror: storeMirror(store),
    registry,
    tunnelFor: () => {
      const t = o.tunnel ? o.tunnel(line) : new CountingTunnel(line)
      tunnels.push(t)
      return t
    },
    retryMs: [50, 200],
    client: { maxBackoffMs: 100 },
    ...o.deps,
  }
  // The links read these as they go: a test can shorten the hold once its setup is done
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
  return { links, deps, store, mgr, call, row, events, tunnel: () => tunnels[0] as CountingTunnel }
}

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

describe('a machine that connects when needed (#1134)', () => {
  it('keeps the setting with the machine: a restarted hub reads it, and the row says it', async () => {
    const remote = await remoteHost()
    const store = new Store()
    const first = await hubHost(() => lineFor(remote.port), { store })
    expect(first.row().connect).toBe('at_start')
    expect(await first.call('machines.setConnect', { machineId: 'm1', connect: 'when_needed' })).toMatchObject({ connect: 'when_needed' })
    await first.links.stop()

    expect(storeRegistry(store).list()).toEqual([expect.objectContaining({ id: 'm1', connect: 'when_needed' })])
    const second = await hubHost(() => lineFor(remote.port), { store })
    expect(second.row()).toMatchObject({ connect: 'when_needed', status: 'disconnected' })
  })

  it('is not connected at start: no attempt is made, and its sessions are listed as last known', async () => {
    const remote = await remoteHost()
    const p = await remote.mgr.addProject(folder())
    const store = new Store()
    // Connected once, at start, so the mirror knows its project
    const first = await hubHost(() => lineFor(remote.port), { store })
    await eventually(() => first.row().status === 'connected')
    await first.call('machines.setConnect', { machineId: 'm1', connect: 'when_needed' })
    await first.links.stop()

    const hub = await hubHost(() => lineFor(remote.port), { store })
    expect(hub.row()).toMatchObject({ status: 'disconnected', error: null })
    // Long enough for an attempt and a retry at the test's backoff
    await new Promise((r) => setTimeout(r, 300))
    expect(hub.tunnel().opens).toBe(0)
    expect(hub.row().status).toBe('disconnected')
    expect(await hub.call('projects.list')).toEqual([expect.objectContaining({ id: `m1.${p.id}`, unreachable: true })])
  })

  it('a machine that connects at start does as before, and a need changes nothing for it', async () => {
    const remote = await remoteHost()
    const hub = await hubHost(() => lineFor(remote.port))
    await eventually(() => hub.row().status === 'connected')
    const opens = hub.tunnel().opens
    expect(await hub.call('machines.need', { machineId: 'm1' })).toMatchObject({ status: 'connected', connect: 'at_start' })
    expect(hub.tunnel().opens).toBe(opens)
  })

  it('connects when the window needs it, stays while needed, and disconnects once nothing has needed it for the hold', async () => {
    const remote = await remoteHost()
    const p = await remote.mgr.addProject(folder())
    const hold = 600 * SLOW
    const hub = await hubHost(() => lineFor(remote.port), { connect: 'when_needed', deps: { needHoldMs: hold, idleCheckMs: 50 } })
    expect(hub.row().status).toBe('disconnected')

    await hub.call('machines.need', { machineId: 'm1' })
    await eventually(() => hub.row().status === 'connected')
    expect(await hub.call('projects.list')).toEqual([expect.objectContaining({ id: `m1.${p.id}` })])
    // Said again well within the hold, as a window does while the project stays open: still up past the first hold
    const since = Date.now()
    while (Date.now() - since < hold * 1.5) {
      await new Promise((r) => setTimeout(r, hold / 4))
      await hub.call('machines.need', { machineId: 'm1' })
      expect(hub.row().status).toBe('connected')
    }
    await eventually(() => hub.row().status === 'disconnected')
    expect(hub.row().error).toBeNull()
    expect(hub.events.some((e: any) => e.type === 'machine_status' && e.machine.status === 'disconnected')).toBe(true)
  })

  it('stays connected past the hold while a session there is in a turn, and lets go once it is over', async () => {
    const remote = await remoteHost()
    const p = await remote.mgr.addProject(folder())
    // A hold longer than the setup takes under load; shortened once the turn is open
    const hub = await hubHost(() => lineFor(remote.port), { connect: 'when_needed', deps: { needHoldMs: 60_000, idleCheckMs: 50 } })
    await hub.call('machines.need', { machineId: 'm1' })
    await eventually(() => hub.row().status === 'connected')
    const s = await hub.call('agents.createSession', { projectId: `m1.${p.id}`, cwd: p.path, tool: 'claude' })
    // The scripted agent stops on an approval: its turn is open until it is answered
    await hub.call('agents.send', { sessionId: s.id, text: 'approve this' })
    await eventually(() => hub.events.some((e: any) => e.type === 'approval_request' && e.sessionId === s.id))
    hub.deps.needHoldMs = 100

    await new Promise((r) => setTimeout(r, 900))
    expect(hub.row().status).toBe('connected')

    const ask = hub.events.find((e: any) => e.type === 'approval_request') as any
    await hub.call('agents.respondApproval', { sessionId: s.id, requestId: ask.requestId, decision: 'allow' })
    await eventually(() => hub.row().status === 'disconnected')
  })

  it('the person disconnects it without unlinking it, and connects it again; connected so, it stays past the hold', async () => {
    const remote = await remoteHost()
    const p = await remote.mgr.addProject(folder())
    const hub = await hubHost(() => lineFor(remote.port), { connect: 'when_needed', deps: { needHoldMs: 200, idleCheckMs: 50 } })

    expect(await hub.call('machines.reconnect', { machineId: 'm1' })).toMatchObject({ status: 'connecting' })
    await eventually(() => hub.row().status === 'connected')
    await new Promise((r) => setTimeout(r, 600))
    expect(hub.row().status).toBe('connected')

    expect(await hub.call('machines.disconnect', { machineId: 'm1' })).toMatchObject({ status: 'disconnected', error: null })
    expect(hub.links.list().map((m) => m.id)).toEqual(['m1'])
    expect(await hub.call('projects.list')).toEqual([expect.objectContaining({ id: `m1.${p.id}`, unreachable: true })])
    const opens = hub.tunnel().opens
    await new Promise((r) => setTimeout(r, 300))
    expect(hub.tunnel().opens).toBe(opens)
  })

  it('a machine that connects at start can be disconnected too, and stays so until Connect', async () => {
    const remote = await remoteHost()
    const hub = await hubHost(() => lineFor(remote.port))
    await eventually(() => hub.row().status === 'connected')
    await hub.call('machines.disconnect', { machineId: 'm1' })
    const opens = hub.tunnel().opens
    await hub.call('machines.need', { machineId: 'm1' })
    await new Promise((r) => setTimeout(r, 300))
    expect(hub.row().status).toBe('disconnected')
    expect(hub.tunnel().opens).toBe(opens)
    await hub.call('machines.reconnect', { machineId: 'm1' })
    await eventually(() => hub.row().status === 'connected')
  })

  it('its sessions keep running there while it is not connected, and what they said is read once it is back', async () => {
    const remote = await remoteHost()
    const p = await remote.mgr.addProject(folder())
    const hub = await hubHost(() => lineFor(remote.port), { connect: 'when_needed' })
    await hub.call('machines.need', { machineId: 'm1' })
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
    await eventually(async () => (await remote.mgr.loadMessages(there)).some((m: any) => m.payload?.text === 'echo: while you were away'))
    await eventually(() => remote.mgr.listSessions().find((x) => x.id === there)?.state === 'waiting_input')
    await expect(hub.call('messages.load', { sessionId: s.id })).rejects.toMatchObject({ data: { reason: 'unreachable' } })

    const resyncs = hub.events.filter((e: any) => e.type === 'machine_resync').length
    await hub.call('machines.need', { machineId: 'm1' })
    await eventually(() => hub.row().status === 'connected')
    expect(hub.events.filter((e: any) => e.type === 'machine_resync').length).toBeGreaterThan(resyncs)
    const history = await hub.call('messages.load', { sessionId: s.id })
    expect(history.some((m: any) => m.payload?.text === 'echo: while you were away')).toBe(true)
  })

  it('a machine it cannot reach is tried while needed, then left disconnected instead of retried for good', async () => {
    const at: number[] = []
    const away: Tunnel = {
      open: async () => {
        at.push(Date.now())
        throw new Error('ssh: connect to host laptop port 22: Operation timed out')
      },
      onDown: () => {},
      close: async () => {},
    }
    const hub = await hubHost(() => lineFor(1), { connect: 'when_needed', tunnel: () => away, deps: { needHoldMs: 300, idleCheckMs: 50 } })
    await hub.call('machines.need', { machineId: 'm1' })
    await eventually(() => hub.row().status === 'unreachable')
    await eventually(() => hub.row().status === 'disconnected')
    const tried = at.length
    expect(tried).toBeGreaterThan(1)
    await new Promise((r) => setTimeout(r, 400))
    expect(at.length).toBe(tried)
  })

  it('an operation the person asks of a disconnected machine connects it first, and lets go after the hold once done', async () => {
    const remote = await remoteHost()
    const hub = await hubHost(() => lineFor(remote.port), { connect: 'when_needed', deps: { needHoldMs: 300, idleCheckMs: 50 } })
    // A direct tunnel has no shell, so the operation is refused; the link is up anyway, as it would be for ssh
    await expect(hub.call('machines.autostart', { machineId: 'm1' })).rejects.toThrow(/no shell/)
    await eventually(() => hub.row().status === 'connected')
    // Not pinned as Connect pins it: nothing needs it after the job
    await eventually(() => hub.row().status === 'disconnected')
  })

  it("the person's Disconnect holds against the window saying again that it is open; opening something again connects", async () => {
    const remote = await remoteHost()
    const hub = await hubHost(() => lineFor(remote.port), { connect: 'when_needed' })
    await hub.call('machines.need', { machineId: 'm1' })
    await eventually(() => hub.row().status === 'connected')
    await hub.call('machines.disconnect', { machineId: 'm1' })
    const opens = hub.tunnel().opens

    // The window's repeat while the same project stays open
    await hub.call('machines.need', { machineId: 'm1', repeat: true })
    await new Promise((r) => setTimeout(r, 300))
    expect(hub.row().status).toBe('disconnected')
    expect(hub.tunnel().opens).toBe(opens)

    // The window opening one of its projects or sessions again
    await hub.call('machines.need', { machineId: 'm1' })
    await eventually(() => hub.row().status === 'connected')
  })

  it('a link the idle rule closed comes back with the window\'s repeat', async () => {
    const remote = await remoteHost()
    const hub = await hubHost(() => lineFor(remote.port), { connect: 'when_needed', deps: { needHoldMs: 200, idleCheckMs: 50 } })
    await hub.call('machines.need', { machineId: 'm1' })
    await eventually(() => hub.row().status === 'connected')
    await eventually(() => hub.row().status === 'disconnected')
    await hub.call('machines.need', { machineId: 'm1', repeat: true })
    await eventually(() => hub.row().status === 'connected')
  })
})

/** A tunnel that fails its first openings, then reaches the host; `drop` ends the transport, as an ssh that exits does */
class FlakyTunnel implements Tunnel {
  private down: ((reason: string) => void) | undefined
  constructor(
    private readonly line: () => ConnectionLine,
    private fails: number,
  ) {}
  async open(): Promise<Endpoint> {
    if (this.fails-- > 0) throw new Error('ssh: connect to host laptop port 22: Operation timed out')
    const line = this.line()
    return { url: `ws://127.0.0.1:${line.port}`, token: line.token, line, localPort: line.port }
  }
  onDown(listener: (reason: string) => void): void {
    this.down = listener
  }
  drop(): void {
    this.down?.('ssh exited')
  }
  async close(): Promise<void> {}
}

describe('the backoff after a good connection (#1134)', () => {
  // With a cap of 5 minutes, a link that kept its count after connecting would wait minutes after its next drop
  it('starts again from its first step once a connection said hello', async () => {
    const remote = await remoteHost()
    let tunnel: FlakyTunnel | undefined
    const hub = await hubHost(() => lineFor(remote.port), {
      tunnel: (line) => (tunnel = new FlakyTunnel(line, 5)),
      deps: { retryMs: [10, 60_000] },
    })
    await eventually(() => hub.row().status === 'connected')
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

describe('the connect setting across builds (#1134)', () => {
  const row = {
    id: 'm1', name: 'Laptop', sshTarget: 'laptop', shell: 'posix', wslDistro: null, command: null, status: 'connected', error: null, versions: null,
    lastConnectedAt: null, localPort: null, sameLocalPort: false, hostStarted: null, install: null, operation: null, autostart: null, elevated: null,
  }

  it('reads a row from an older hub, which sends none, as connecting at start; and a value it does not know the same', () => {
    expect(MachineInfo.parse(row).connect).toBe('at_start')
    expect(MachineInfo.parse({ ...row, connect: 'on_tuesdays' }).connect).toBe('at_start')
  })

  it('reads a status a newer hub may send and this window does not know as unreachable', () => {
    expect(MachineInfo.parse({ ...row, status: 'asleep' }).status).toBe('unreachable')
  })

  it('reads a row an older host wrote, with no value in the column, as at start', () => {
    const store = new Store()
    store.machines.addLinkedMachine({ id: 'm1', name: 'Laptop', sshTarget: 'laptop', remote: { shell: 'posix' }, addedAt: 1, acceptedVersions: null })
    expect(store.machines.listLinkedMachines()[0]!.connect).toBe('at_start')
    store.machines.setLinkedMachineConnect('m1', 'when_needed')
    expect(store.machines.listLinkedMachines()[0]!.connect).toBe('when_needed')
    store.machines.setLinkedMachineConnect('m1', 'at_start')
    expect(store.machines.listLinkedMachines()[0]!.connect).toBe('at_start')
    store.close()
  })
})

describe("an agent's work on a machine that connects when needed connects it (#1134)", () => {
  /**
   * A remote with a checkout of the hub's repository and a worker that can resume, and a hub whose trusted project's
   * session h1 asks. The hub connected once, so its mirror knows the machine; then the machine is set to connect when
   * needed and disconnected, as it would stand after a restart of the hub
   */
  async function rig(o: { openMs?: number; deps?: Partial<LinkDeps> } = {}) {
    const remoteStore = new Store()
    remoteStore.projects.addProject({ id: 'p-app', path: checkout('git@github.com:me/app.git'), name: 'app-checkout' })
    seedSession(remoteStore, 'p-app', 'w1', 'worker', 'ext-w1')
    const remote = await remoteHost(remoteStore)
    const hubStore = new Store()
    hubStore.projects.addProject({ id: 'p-hub', path: checkout('https://github.com/me/app'), name: 'app' })
    seedSession(hubStore, 'p-hub', 'h1', 'worker', 'ext-h1')
    seedSession(hubStore, 'p-hub', 'h2', 'worker', 'ext-h2')
    // `openMs`: how long the link takes to open, as an ssh to a machine that has to start its host does
    // `net.down`: ssh no longer reaches the machine, as a laptop that was closed
    const net = { down: false }
    const slow = (line: () => ConnectionLine) => new CountingTunnel(async () => {
      await new Promise((r) => setTimeout(r, o.openMs ?? 0))
      if (net.down) throw new Error('ssh: connect to host laptop port 22: Operation timed out')
      return line()
    })
    const hub = await hubHost(() => lineFor(remote.port), { store: hubStore, tunnel: slow, ...(o.deps ? { deps: o.deps } : {}) })
    await hub.mgr.setProjectTrusted('p-hub', true)
    await eventually(() => hub.row().status === 'connected')
    await hub.call('machines.setConnect', { machineId: 'm1', connect: 'when_needed' })
    await hub.call('machines.disconnect', { machineId: 'm1' })
    const opens = hub.tunnel().opens
    const card = (caller: string) => hub.mgr.listSessions().find((x) => x.id === caller)?.pendingApproval
    /** Allows the card the call raises, and answers the call; a call refused before any card answers with its refusal */
    const answered = async <T,>(call: Promise<T>, caller = 'h1'): Promise<T> => {
      const allowed = (async () => {
        await eventually(() => !!card(caller))
        await hub.mgr.respondApproval(caller, card(caller)!.requestId, 'allow')
        return call
      })()
      return Promise.race([call, allowed])
    }
    // As the machine names its project: the folder's name
    const name = (await remote.mgr.listProjects()).find((p) => p.id === 'p-app')!.name
    const reader = linkedSessions(() => hub.links.all(), (method, params) => hub.call(method, params), 'Hub mac')
    return { remote, hub, hubStore, opens, answered, name, reader, net }
  }

  it('start_agent with the machine connects it, starts the child there and gets its answer', async () => {
    const { remote, hub, opens, answered } = await rig()
    expect(await answered(hub.mgr.startAgent('h1', { task: 'say hello', machine: 'Laptop' }))).toMatchObject({ ok: true, state: 'done', answer: expect.stringContaining('echo:') })
    expect(hub.row().status).toBe('connected')
    expect(hub.tunnel().opens).toBeGreaterThan(opens)
    expect(remote.mgr.listSessions().some((x) => x.projectId === 'p-app' && x.id !== 'w1')).toBe(true)
  })

  it('ask_project names its project as last listed, connects it, and the answer comes back', async () => {
    const { hub, answered, name } = await rig()
    expect(await answered(hub.mgr.askProject('h1', { project: `Laptop/${name}`, task: 'say hello' }))).toMatchObject({ ok: true, state: 'done', sessionId: 'm1.w1', answer: expect.stringContaining('say hello') })
    expect(hub.row().status).toBe('connected')
  })

  it('agent_session on a child there connects it to read where the child stands', async () => {
    const { hub, answered } = await rig()
    // Started while the person had it connected
    await hub.call('machines.reconnect', { machineId: 'm1' })
    await eventually(() => hub.row().status === 'connected')
    const r = await answered(hub.mgr.startAgent('h1', { task: 'say hello', machine: 'Laptop' }))
    if (!r.ok) throw new Error(r.error)
    await hub.call('machines.disconnect', { machineId: 'm1' })
    expect(await hub.mgr.agentSession('h1', { sessionId: r.sessionId, action: 'status' })).toMatchObject({ ok: true, state: 'at_rest' })
    expect(hub.row().status).toBe('connected')
  })

  it('a machine that connects at start and was disconnected is not connected by an agent: it is said to be away', async () => {
    const { hub } = await rig()
    await hub.call('machines.setConnect', { machineId: 'm1', connect: 'at_start' })
    await eventually(() => hub.row().status === 'connected')
    await hub.call('machines.disconnect', { machineId: 'm1' })
    const opens = hub.tunnel().opens
    const r = await hub.mgr.startAgent('h1', { task: 'say hello', machine: 'Laptop' })
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('cannot be reached') })
    expect(hub.tunnel().opens).toBe(opens)
  })

  it('looking a project name up does not connect it', async () => {
    const { hub, opens, name } = await rig()
    const r = await hub.mgr.askProject('h1', { project: 'no-such-project' })
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining(`${name} (on Laptop)`) })
    expect(hub.tunnel().opens).toBe(opens)
    expect(hub.row().status).toBe('disconnected')
  })

  // #1134 review H1: a machine still connecting was listed as away, and both calls were refused before they reached the need
  it('ask_project and start_agent at once, while the window has it connecting, both wait for the link and succeed', async () => {
    const { hub, answered, name } = await rig({ openMs: 1500 })
    await hub.call('machines.need', { machineId: 'm1' })
    expect(hub.row().status).toBe('connecting')
    const [asked, started] = await Promise.all([
      answered(hub.mgr.askProject('h1', { project: `Laptop/${name}`, task: 'say hello' }), 'h1'),
      answered(hub.mgr.startAgent('h2', { task: 'say hello', machine: 'Laptop' }), 'h2'),
    ])
    expect(asked).toMatchObject({ ok: true, state: 'done' })
    expect(started).toMatchObject({ ok: true, state: 'done' })
    expect(hub.row().status).toBe('connected')
  })

  // #1134 re-review: every read of its projects failed for the link, and the answer said it had no checkout to clone
  it('start_agent on it while ssh cannot reach it says it cannot be reached, not that it lacks the checkout', async () => {
    const { hub, answered, net } = await rig()
    net.down = true
    const r = await answered(hub.mgr.startAgent('h1', { task: 'say hello', machine: 'Laptop' }))
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('Laptop cannot be reached') })
    expect((r as { error: string }).error).not.toContain('clone')
    expect(hub.row().status).toBe('unreachable')
  })

  // #1134 review M1: the hold ran from when the link came up, not from the agent's work on it
  it("an agent's work on the machine while it is connected starts its hold again", async () => {
    const hold = 1000 * SLOW
    const { hub, reader } = await rig({ deps: { needHoldMs: hold, idleCheckMs: 50 } })
    await hub.call('machines.need', { machineId: 'm1' })
    await eventually(() => hub.row().status === 'connected')
    await new Promise((r) => setTimeout(r, hold * 0.7))
    expect(await reader.read('m1.w1', 1)).toMatchObject({ ok: true })
    // Past the hold from the window's need, within it from the read
    await new Promise((r) => setTimeout(r, hold * 0.7))
    expect(hub.row().status).toBe('connected')
    await eventually(() => hub.row().status === 'disconnected')
  })

  // #1134 review M2: a child whose turn ended with its background work still running there owes its report
  it('stays connected past the hold while a child there owes its report over its background work', async () => {
    // A hold longer than connecting takes under load; shortened once the work is owed
    const { hub } = await rig({ deps: { needHoldMs: 60_000, idleCheckMs: 50 } })
    const children = (hub.mgr as unknown as { children: { setLinkedReport(id: string, r: unknown): void; dropLinkedReport(id: string): void } }).children
    await hub.call('machines.need', { machineId: 'm1' })
    await eventually(() => hub.row().status === 'connected')
    // Its turn ended there with its work still running, as the machine's events would leave it
    children.setLinkedReport('m1.w1', { orchestratorId: 'h1', busy: false, paused: [{ id: 'bg1', kind: 'shell', description: 'npm test', status: 'running' }] })
    hub.deps.needHoldMs = 100
    await new Promise((r) => setTimeout(r, 600))
    expect(hub.row().status).toBe('connected')
    children.dropLinkedReport('m1.w1')
    await eventually(() => hub.row().status === 'disconnected')
  })

  // #1134 review: a restart parked the machine, and the report of a child working there waited for the next need
  it('a restarted hub connects it at start while a child there still owes its report', async () => {
    const { hub, hubStore, answered, remote } = await rig()
    // A turn that stops on an approval there: it runs on, and its report is owed
    expect(await answered(hub.mgr.startAgent('h1', { task: 'please approve the command', machine: 'Laptop', wait: false }))).toMatchObject({ ok: true, state: 'working' })
    await hub.links.stop()
    await hub.mgr.disposeAll()

    const again = await hubHost(() => lineFor(remote.port), { store: hubStore })
    expect(again.row().connect).toBe('when_needed')
    await eventually(() => again.row().status === 'connected')
  })
})
