import { afterEach, describe, expect, it, vi } from 'vitest'
import WsSocket, { WebSocketServer } from 'ws'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fakeExe } from '../fake-exe.test-helpers.js'
import { APP_VERSION, PROTOCOL_VERSION, sessionLiveDefaults, type HostActivity, type MachineInfo, type NormalizedEvent, type SessionInfo } from '@cc/protocol'
import { Store } from '../dev-services/store.js'
import { SessionManager } from '../sessions/manager.js'
import { createRpcHandler } from '../rpc.js'
import { HostServer } from '../transport/server.js'
import { Links, type LinkDeps } from './links.js'
import { linkedSessions } from './linked-sessions.js'
import { fakeRegistry } from './fake-registry.test-helpers.js'
import { Router } from './router.js'
import { DirectTunnel, type ConnectionLine, type HostStart, type Tunnel } from './tunnel.js'
import { NodeTooOld } from './node-floor.js'
import { storeMirror, storeRegistry } from './stored.js'
import { scriptedAdapters } from './scripted-agent.test-helpers.js'
import { eventually } from '../../../../tooling/test-timing.js'

/**
 * Two real hosts in one process (#82): each with its own store, session manager, RPC handler and
 * server, the hub with the router and links `main.ts` wires, linked to the other as `m1` on
 * loopback. Only the transport differs from a real link (tunnel.test.ts covers ssh).
 */

/** `nodeFloor()` of the host's copy of the npm manifest, which a test can make unreadable */
const flags = vi.hoisted(() => ({ floorBroken: false }))
vi.mock('./install.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./install.js')>()
  return {
    ...actual,
    nodeFloor: () => {
      if (flags.floorBroken) throw new Error('centralu-package.json is missing from this host')
      return actual.nodeFloor()
    },
  }
})

const TOKEN = 'tok'
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

async function remoteHost(port = 0, store = new Store(), o: { version?: string; activity?: () => HostActivity } = {}) {
    const adapters = scriptedAdapters()
  const mgr = new SessionManager(store, adapters, (e) => server.broadcast(e))
  const server: HostServer = new HostServer({
    port,
    token: TOKEN,
    onRpc: createRpcHandler(mgr, adapters, o.activity ? { activity: o.activity } : {}),
    build: { commit: 'abc1234', protocolVersion: PROTOCOL_VERSION, version: o.version ?? APP_VERSION },
  })
  const p = await server.listen()
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await mgr.disposeAll()
    await server.close()
  }
  cleanups.push(close)
  return { server, mgr, store, port: p, close }
}

type Hub = Awaited<ReturnType<typeof hubHost>>

async function hubHost(line: () => ConnectionLine, store = new Store(), add = true, extra: Partial<LinkDeps> = {}) {
    const adapters = scriptedAdapters()
  const mgr = new SessionManager(store, adapters, (e) => server.broadcast(e))
  const registry = storeRegistry(store)
  if (add && !registry.list().length) registry.add({ id: 'm1', name: 'Remote box', sshTarget: 'box', remote: { shell: 'posix' }, addedAt: 1, acceptedVersions: null })
  const links = new Links({
    hub: { version: APP_VERSION, protocolVersion: PROTOCOL_VERSION, dev: false },
    broadcast: (e) => {
      server.broadcast(e)
      mgr.observeLinked(e)
    },
    terminal: (f) => server.pushTerminal(f),
    mirror: storeMirror(store),
    registry,
    tunnelFor: () => new DirectTunnel(line),
    retryMs: [50, 200],
    client: { maxBackoffMs: 100 },
    ...extra,
  })
  mgr.useLinkedSessions((id) => links.knowsSession(id))
  mgr.useLinkedApps({ linked: (id) => links.linked(id), projectMachine: (id) => links.projectMachine(id) })
  mgr.useLinkedReader(linkedSessions(() => links.all(), (method, params) => router.handle(method, params), 'Hub mac'))
  const router = new Router({ local: createRpcHandler(mgr, adapters, { machines: links }), machines: () => links.all() })
  const server: HostServer = new HostServer({ port: 0, token: TOKEN, onRpc: router.handle })
  const port = await server.listen()
  links.start()
  cleanups.push(async () => {
    await links.stop()
    await mgr.disposeAll()
    await server.close()
  })
  return { server, mgr, links, store, port }
}

/** A UI on the hub: its own socket, every frame kept */
async function ui(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const frames: Record<string, any>[] = []
  const pending = new Map<string, (f: any) => void>()
  let n = 0
  await new Promise<void>((resolve) => {
    ws.onopen = () => ws.send(JSON.stringify({ kind: 'hello', token: TOKEN, protocolVersion: PROTOCOL_VERSION }))
    ws.onmessage = (m) => {
      const f = JSON.parse(String(m.data))
      frames.push(f)
      if (f.kind === 'hello_ok') resolve()
      if (f.kind === 'res') pending.get(f.id)?.(f)
    }
  })
  cleanups.push(() => ws.close())
  const call = (method: string, params: unknown = {}) =>
    new Promise<any>((resolve, reject) => {
      const id = String(++n)
      pending.set(id, (f) => (f.ok ? resolve(f.result) : reject(Object.assign(new Error(f.error.message), f.error))))
      ws.send(JSON.stringify({ kind: 'rpc', id, method, params }))
    })
  const events = () => frames.filter((f) => f.kind === 'event').map((f) => f.event as NormalizedEvent & Record<string, any>)
  return { call, frames, events }
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

const status = (hub: Hub) => hub.links.list()[0]!.status

function folder(): string {
  const d = mkdtempSync(join(tmpdir(), 'cc-links-'))
  cleanups.push(() => rmSync(d, { recursive: true, force: true }))
  return d
}

/** A remote's store with one project and these sessions, written before its host reads it */
function seeded(sessions: [id: string, kind: SessionInfo['kind'], inProject: boolean][]): { store: Store; projectId: string } {
  const store = new Store()
  const projectId = 'p-remote'
  store.projects.addProject({ id: projectId, path: folder(), name: 'remote-project' })
  for (const [id, kind, inProject] of sessions) seedSession(store, inProject ? projectId : null, id, kind)
  return { store, projectId }
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
    // A coordinator is a session with a visibility list (store.ts)
    scopeSessionIds: kind === 'coordinator' ? ['worker1'] : null,
    roleAppend: null,
    appId: null,
    ...sessionLiveDefaults(),
  })
}

describe('a hub linked to another host (#82)', () => {
  /*
   * Three builds (review of #936): a linked machine newer than the hub raises a card the hub cannot read. The hub's own
   * windows show a fallback with allow and deny only, but a window from before #844 on that hub still offers "always",
   * and the machine would keep it for its own kind. So the hub refuses "always" for a card it read as a fallback.
   */
  it('refuses "always" for a linked machine\'s card the hub could not read, and passes allow on', async () => {
    const remote = await remoteHost()
    await remote.mgr.addProject(folder())
    const hub = await hubHost(() => lineFor(remote.port))
    await eventually(() => status(hub) === 'connected')
    const u = await ui(hub.port)
    const projects = await u.call('projects.list')
    const s = await u.call('agents.createSession', { projectId: projects[0].id, cwd: projects[0].path, tool: 'claude' })
    const remoteId = s.id.slice(3)
    const newer = { kind: 'project_access', access: 'terminals', from: { id: 'p1', name: 'web' }, to: { id: 'p2', name: 'api' }, text: 'export the sprites' }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    remote.server.broadcast({ type: 'approval_request', sessionId: remoteId, requestId: 'r-newer', detail: newer } as unknown as NormalizedEvent)
    remote.server.broadcast({ type: 'approval_request', sessionId: remoteId, requestId: 'r-known', detail: { kind: 'command', command: 'ls', cwd: '/' } } as unknown as NormalizedEvent)
    await eventually(() => u.events().filter((e) => e.type === 'approval_request').length === 2)
    warn.mockRestore()
    expect(u.events().find((e) => e.requestId === 'r-newer')!.detail).toMatchObject({ kind: 'other', about: 'unknown_card' })
    const answered: [string, string][] = []
    const real = remote.mgr.respondApproval.bind(remote.mgr)
    remote.mgr.respondApproval = ((id: string, requestId: string, decision: string, ...rest: unknown[]) => {
      answered.push([requestId, decision])
      return (real as (...a: unknown[]) => unknown)(id, requestId, decision, ...rest)
    }) as typeof remote.mgr.respondApproval
    await expect(u.call('agents.respondApproval', { sessionId: s.id, requestId: 'r-newer', decision: 'always' })).rejects.toThrow(/cannot be allowed always/)
    // A card the hub read is answered "always" as before
    await u.call('agents.respondApproval', { sessionId: s.id, requestId: 'r-known', decision: 'always' }).catch(() => {})
    await u.call('agents.respondApproval', { sessionId: s.id, requestId: 'r-newer', decision: 'allow' }).catch(() => {})
    await eventually(() => answered.length === 2)
    expect(answered).toEqual([['r-known', 'always'], ['r-newer', 'allow']])
  })

  it('works a remote session end to end: lists, create, send, approve, with ids qualified and events under the hub’s numbers', async () => {
    const remote = await remoteHost()
    const remoteProject = await remote.mgr.addProject(folder())
    const hub = await hubHost(() => lineFor(remote.port))
    await hub.mgr.addProject(folder())
    await eventually(() => status(hub) === 'connected')
    const u = await ui(hub.port)

    const projects = await u.call('projects.list')
    expect(projects.map((p: any) => [p.id.startsWith('m1.'), p.machine ?? null])).toEqual([
      [false, null],
      [true, 'm1'],
    ])
    expect(projects[1].id).toBe(`m1.${remoteProject.id}`)

    const s = await u.call('agents.createSession', { projectId: projects[1].id, cwd: projects[1].path, tool: 'claude' })
    expect(s).toMatchObject({ id: expect.stringMatching(/^m1\./), projectId: projects[1].id, machine: 'm1' })
    // The session lives on the remote, not on the hub
    expect(remote.mgr.listSessions().map((x) => x.id)).toEqual([s.id.slice(3)])
    expect(hub.mgr.listSessions()).toEqual([])

    await u.call('agents.send', { sessionId: s.id, text: 'hello' })
    await eventually(() => u.events().some((e) => e.type === 'message_delta' && e.text === 'echo: hello'))
    await u.call('agents.send', { sessionId: s.id, text: 'approve this' })
    await eventually(() => u.events().some((e) => e.type === 'approval_request'))
    const ask = u.events().find((e) => e.type === 'approval_request')!
    expect(ask.sessionId).toBe(s.id)
    await u.call('agents.respondApproval', { sessionId: s.id, requestId: ask.requestId, decision: 'allow' })
    await eventually(() => u.events().some((e) => e.type === 'message_delta' && e.text === 'approved'))

    // Every event reached the UI under the hub's own sequence, in order, with the remote's session qualified
    const seqs = u.frames.filter((f) => f.kind === 'event').map((f) => f.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
    for (const e of u.events()) if ('sessionId' in e && e.sessionId) expect(e.sessionId).toBe(s.id)

    const history = await u.call('messages.load', { sessionId: s.id })
    expect(history.length).toBeGreaterThan(3)
    for (const m of history) {
      expect(m.sessionId).toBe(s.id)
      if (m.payload?.sessionId) expect(m.payload.sessionId).toBe(s.id)
    }
  })

  it('shows neither the remote orchestrator nor its coordinators, nor passes their events on', async () => {
    const { store } = seeded([
      ['orch', 'orchestrator', false],
      ['coord', 'coordinator', true],
      ['worker1', 'worker', true],
    ])
    const remote = await remoteHost(0, store)
    const hub = await hubHost(() => lineFor(remote.port))
    await eventually(() => status(hub) === 'connected')
    const u = await ui(hub.port)
    expect((await u.call('sessions.list')).map((x: any) => x.id)).toEqual(['m1.worker1'])
    remote.server.broadcast({ type: 'session_title', sessionId: 'orch', title: 'secret plan', auto: true })
    remote.server.broadcast({ type: 'session_title', sessionId: 'worker1', title: 'visible', auto: true })
    /*
     * The orchestrator's title went out first, and a link relays a machine's events in order, as they come (#845):
     * once the worker's has arrived, the orchestrator's would have before it
     */
    await eventually(() => u.events().some((e) => e.type === 'session_title' && e.sessionId === 'm1.worker1'))
    expect(u.events().filter((e) => e.type === 'session_title').map((e) => e.sessionId)).toEqual(['m1.worker1'])
    // Hub-only events of the remote stay there
    remote.server.broadcast({ type: 'themes_changed' })
    // An agent there applying its own update (#665) must not relaunch this window
    remote.server.broadcast({ type: 'update_apply_request', requestId: 'r1' })
    remote.server.broadcast({ type: 'update_apply_go', requestId: 'r1', ticket: 't1' })
    remote.server.broadcast({ type: 'external_apps_changed' })
    // A project the remote made (#515) reaches the hub's windows, which re-read the merged list
    remote.server.broadcast({ type: 'projects_changed' })
    await eventually(() => u.events().some((e) => e.type === 'external_apps_changed'))
    await eventually(() => u.events().some((e) => e.type === 'projects_changed'))
    expect(u.events().some((e) => e.type === 'themes_changed')).toBe(false)
    expect(u.events().some((e) => e.type === 'update_apply_request' || e.type === 'update_apply_go')).toBe(false)
  })

  it('shows a project setting another client wrote on the linked machine (#719)', async () => {
    const { store, projectId } = seeded([])
    const remote = await remoteHost(0, store)
    const hub = await hubHost(() => lineFor(remote.port))
    await eventually(() => status(hub) === 'connected')
    const u = await ui(hub.port)
    // Another window of that machine, reaching it directly, not through the hub
    const other = await ui(remote.port)
    const trustedOnHub = async () => (await u.call('projects.list')).find((p: any) => p.id === `m1.${projectId}`)?.trusted
    expect(await trustedOnHub()).toBe(false)
    await other.call('projects.setTrusted', { projectId, trusted: true })
    await eventually(() => u.events().some((e) => e.type === 'projects_changed'))
    expect(await trustedOnHub()).toBe(true)
    const heard = u.events().filter((e) => e.type === 'projects_changed').length
    await other.call('projects.setCommands', { projectId, commands: [{ command: 'pnpm dev' }] })
    await eventually(() => u.events().filter((e) => e.type === 'projects_changed').length > heard)
    expect((await u.call('projects.list')).find((p: any) => p.id === `m1.${projectId}`)?.commands).toEqual([{ command: 'pnpm dev' }])
  })

  it('relays terminal output under the machine’s prefix', async () => {
    const remote = await remoteHost()
    const hub = await hubHost(() => lineFor(remote.port))
    await eventually(() => status(hub) === 'connected')
    const u = await ui(hub.port)
    remote.server.pushTerminal({ terminalId: 'term-9', data: 'hi' })
    remote.server.pushTerminal({ terminalId: 'run-2', exitCode: 1 })
    await eventually(() => u.frames.filter((f) => f.kind === 'term' || f.kind === 'term_exit').length === 2)
    expect(u.frames.filter((f) => f.kind === 'term' || f.kind === 'term_exit')).toEqual([
      { kind: 'term', terminalId: 'm1.term-9', data: 'hi' },
      { kind: 'term_exit', terminalId: 'm1.run-2', exitCode: 1 },
    ])
  })

  it('answers for a machine that went away from the mirror, keeps its grid panel, and says when it is back', async () => {
    const remoteStore = new Store()
    const remote = await remoteHost(0, remoteStore)
    const p = await remote.mgr.addProject(folder())
    const hub = await hubHost(() => lineFor(remote.port))
    await eventually(() => status(hub) === 'connected')
    const u = await ui(hub.port)
    const s = await u.call('agents.createSession', { projectId: `m1.${p.id}`, cwd: p.path, tool: 'claude' })
    expect(s.live).toBe(true)
    await u.call('sessions.list')
    expect(await u.call('grid.set', { panels: [{ kind: 'session', sessionId: s.id }] })).toEqual([{ kind: 'session', sessionId: s.id }])

    await remote.close()
    await eventually(() => status(hub) !== 'connected')
    const listed = await u.call('sessions.list')
    expect(listed).toEqual([expect.objectContaining({ id: s.id, live: true, unreachable: true, machine: 'm1' })])
    expect(await u.call('projects.list')).toEqual([expect.objectContaining({ id: `m1.${p.id}`, unreachable: true })])
    expect(await u.call('grid.get', { tagged: true })).toEqual([{ kind: 'session', sessionId: s.id }])
    const err = await u.call('agents.send', { sessionId: s.id, text: 'x' }).catch((e) => e)
    expect(err).toMatchObject({ retryable: true, data: { machine: 'm1', reason: 'unreachable' } })
    expect(u.events().some((e: any) => e.type === 'machine_status' && e.machine.status === 'unreachable')).toBe(true)

    // The remote comes back on the same port, a new lifetime: the UI is told to read that machine again
    const resyncsBefore = u.events().filter((e: any) => e.type === 'machine_resync').length
    await remoteHost(remote.port, remoteStore)
    await eventually(() => status(hub) === 'connected')
    await eventually(() => u.events().filter((e: any) => e.type === 'machine_resync').length > resyncsBefore)
    const back = (await u.call('sessions.list')).find((x: any) => x.id === s.id)
    // The remote restarted without a keeper: its agent is gone, which the fresh list says and the UI wakes
    expect(back).toMatchObject({ live: false })
    expect(back.unreachable).toBeUndefined()
  })

  it('keeps the links and the mirror in its store: a restarted hub lists an away machine’s sessions at once', async () => {
    const remote = await remoteHost(0, seeded([['w1', 'worker', true]]).store)
    const hubStore = new Store()
    const first = await hubHost(() => lineFor(remote.port), hubStore)
    await eventually(() => status(first) === 'connected')
    await remote.close()
    await first.links.stop()
    // A new hub on the same store, the machine still away
    const second = await hubHost(() => lineFor(remote.port), hubStore, false)
    const u = await ui(second.port)
    expect(second.links.list().map((m) => m.id)).toEqual(['m1'])
    expect(await u.call('sessions.list')).toEqual([expect.objectContaining({ id: 'm1.w1', unreachable: true })])
  })

  it('connects to a remote on another app version when the protocol matches, naming the older side so an update is offered; another protocol is held (#689)', async () => {
    const remote = await remoteHost(0, new Store(), { version: '0.1.0-beta.1' })
    let line = lineFor(remote.port, { version: '0.1.0-beta.1' })
    const hub = await hubHost(() => line)
    await eventually(() => status(hub) === 'connected')
    const info = hub.links.list()[0]!
    expect(info.versions).toMatchObject({ older: 'remote', compatible: true, remote: { version: '0.1.0-beta.1' } })
    const u = await ui(hub.port)
    await expect(u.call('sessions.list')).resolves.toEqual([])

    line = lineFor(remote.port, { protocolVersion: PROTOCOL_VERSION + 1 })
    await u.call('machines.reconnect', { machineId: 'm1' })
    await eventually(() => hub.links.list()[0]!.versions?.compatible === false)
    expect(status(hub)).toBe('versions_differ')
    expect(hub.links.list()[0]!.error).toMatch(/protocol/)
    await expect(u.call('machines.acceptVersions', { machineId: 'm1' })).rejects.toThrow(/different protocols/)
  })

  it('tells a PowerShell machine’s person to type centralu.cmd and npm.cmd, never the bare names a default execution policy blocks (#688)', async () => {
    const remote = await remoteHost()
    const store = new Store()
    storeRegistry(store).add({ id: 'm1', name: 'Remote box', sshTarget: 'box', remote: { shell: 'powershell' }, addedAt: 1, acceptedVersions: null })
    const hub = await hubHost(() => lineFor(remote.port, { token: 'rotated-but-serve-keeps-the-old-one' }), store, false)
    await eventually(() => status(hub) === 'refused')
    expect(hub.links.list()[0]!.error).toMatch(/restart `centralu\.cmd serve` there/)
    const dev = await hubHost(() => lineFor(1), store, false, {
      installer: { runtime: () => ({ node: { version: '24.21.0', archives: {} } }), script: () => '', registry: {} },
      tunnelFor: () => Object.assign(new DirectTunnel(() => lineFor(1)), { exec: async () => ({ code: 0, stderr: '', stdout: '' }) }),
      hub: { version: APP_VERSION, protocolVersion: PROTOCOL_VERSION, dev: true },
    })
    await expect((await ui(dev.port)).call('machines.install', { machineId: 'm1' })).rejects.toThrow(/\(npm\.cmd i -g centralu\)/)
  })

  it('a refused token asks the remote again once, then reports and backs off instead of looping', async () => {
    const remote = await remoteHost()
    // Each ask, and each time the row was reported refused, in order: so a slow check of the row cannot miscount
    const timeline: string[] = []
    const asks: number[] = []
    /** When the remote refused each socket: noted before the link's client hears of it */
    const refusals: number[] = []
    class Noting extends WsSocket {
      constructor(...args: ConstructorParameters<typeof WsSocket>) {
        super(...args)
        this.on('close', (code) => void (code === 4001 && refusals.push(performance.now())))
      }
    }
    const hub = await hubHost(
      () => {
        timeline.push('ask')
        asks.push(performance.now())
        return lineFor(remote.port, { token: 'rotated-but-serve-keeps-the-old-one' })
      },
      new Store(),
      true,
      {
        log: (l) => void (l.includes(': refused: ') && timeline.push('refused')),
        client: { maxBackoffMs: 100, WebSocketImpl: Noting as unknown as typeof WsSocket },
      },
    )
    await eventually(() => status(hub) === 'refused')
    expect(hub.links.list()[0]!.error).toMatch(/restart `centralu serve` there/)
    // Asked again once at the first refusal, then reported
    expect(timeline.indexOf('refused')).toBe(2)
    /*
     * Backoff from 50 ms doubling (the test's retry), not one ask per event-loop turn: measured from each refusal to
     * the ask after it, a wait a loaded machine only lengthens (#845). A count of asks within a fixed sleep let a
     * loop through where each round took long enough, and a wait from ask to ask holds the round's own time
     */
    await eventually(() => asks.length >= 5)
    const waits = [2, 3, 4].map((k) => asks[k]! - refusals[k - 1]!)
    // A timer may fire a ms early
    expect(waits[0]).toBeGreaterThanOrEqual(45)
    expect(waits[1]).toBeGreaterThanOrEqual(95)
    expect(waits[2]).toBeGreaterThanOrEqual(190)
  })

  it('adds and removes a machine through the hub, and removing it takes its sessions and panels away', async () => {
    const remote = await remoteHost(0, seeded([['w1', 'worker', true]]).store)
    const hub = await hubHost(() => lineFor(remote.port), new Store(), false)
    const u = await ui(hub.port)
    await expect(u.call('machines.add', { name: 'x', sshTarget: '-oProxyCommand=evil' })).rejects.toThrow(/Not an ssh target/)
    await expect(u.call('machines.add', { name: 'x', sshTarget: 'box', shell: 'wsl' })).rejects.toThrow(/distro/)
    const added: MachineInfo = await u.call('machines.add', { name: 'Remote box', sshTarget: 'box' })
    expect(added).toMatchObject({ id: 'remote-box', shell: 'posix' })
    await eventually(() => status(hub) === 'connected')
    expect((await u.call('sessions.list')).map((s: any) => s.id)).toEqual(['remote-box.w1'])
    await u.call('grid.set', { panels: [{ kind: 'session', sessionId: 'remote-box.w1' }] })
    await u.call('machines.remove', { machineId: 'remote-box' })
    expect(await u.call('machines.list')).toEqual([])
    expect(await u.call('sessions.list')).toEqual([])
    expect(await u.call('grid.get', { tagged: true })).toEqual([])
    expect(u.events().some((e: any) => e.type === 'machine_resync' && e.machineId === 'remote-box')).toBe(true)
  })

  it('keeps grid panels of a machine’s apps while the hub knows it, refuses a stranger’s, and drops them with the machine (plan §11.8)', async () => {
    const remote = await remoteHost(0, seeded([['w1', 'worker', true]]).store)
    const hub = await hubHost(() => lineFor(remote.port), new Store(), false)
    const u = await ui(hub.port)
    await u.call('machines.add', { name: 'Remote box', sshTarget: 'box' })
    await eventually(() => status(hub) === 'connected')
    // The mirror learns the machine's projects from the list the window reads
    await u.call('projects.list')
    const panels = [
      { kind: 'app', projectId: 'remote-box.p-remote', appId: 'board' },
      { kind: 'app', projectId: null, appId: 'notes', machine: 'remote-box' },
      { kind: 'app', projectId: null, appId: 'notes' },
      // A project the mirror never heard of, and a machine nobody linked: nothing the hub could place
      { kind: 'app', projectId: 'remote-box.p-gone', appId: 'board' },
      { kind: 'app', projectId: null, appId: 'notes', machine: 'stranger' },
    ]
    const kept = [panels[0], panels[1], panels[2]]
    expect(await u.call('grid.set', { panels })).toEqual(kept)
    expect(await u.call('grid.get', { tagged: true })).toEqual(kept)

    await u.call('machines.remove', { machineId: 'remote-box' })
    expect(await u.call('grid.get', { tagged: true })).toEqual([{ kind: 'app', projectId: null, appId: 'notes' }])
  })

  it('closes what the tunnel opened when the machine is removed while it was opening', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const seen: string[] = []
    const tunnel: Tunnel = {
      open: async () => {
        seen.push('open')
        await gate
        seen.push('opened')
        return { url: 'ws://127.0.0.1:1', token: TOKEN, line: lineFor(1), localPort: 1 }
      },
      onDown() {},
      close: async () => void seen.push('close'),
    }
    const store = new Store()
    const registry = storeRegistry(store)
    registry.add({ id: 'm1', name: 'Remote box', sshTarget: 'box', remote: { shell: 'posix' }, addedAt: 1, acceptedVersions: null })
    const links = new Links({
      hub: { version: APP_VERSION, protocolVersion: PROTOCOL_VERSION, dev: false },
      broadcast: () => {},
      terminal: () => {},
      mirror: storeMirror(store),
      registry,
      tunnelFor: () => tunnel,
    })
    cleanups.push(() => links.stop())
    links.start()
    await eventually(() => seen.includes('open'))
    await links.remove('m1')
    release()
    // The forward an ssh tunnel brought up after the removal would otherwise run until the host exits
    await eventually(() => seen.at(-1) === 'close' && seen.includes('opened'))
    expect(seen).toEqual(['open', 'close', 'opened', 'close'])
  })

  describe('a remote host the link finds not running (remote-hub.md §10.9, decision 7)', () => {
    /** Links over a tunnel whose remote host runs once `startHost` has run, with every status and log line kept */
    async function linkTo(start: () => Promise<HostStart>) {
      const remote = await remoteHost()
      let running = false
      let starts = 0
      const tunnel = Object.assign(new DirectTunnel(() => lineFor(remote.port, { hostRunning: running })), {
        startHost: async () => {
          starts++
          const r = await start()
          running = true
          return r
        },
      })
      const store = new Store()
      const registry = storeRegistry(store)
      registry.add({ id: 'm1', name: 'Remote box', sshTarget: 'box', remote: { shell: 'posix' }, addedAt: 1, acceptedVersions: null })
      const statuses: string[] = []
      const logs: string[] = []
      const links = new Links({
        hub: { version: APP_VERSION, protocolVersion: PROTOCOL_VERSION, dev: false },
        broadcast: (e) => {
          if (e.type === 'machine_status') statuses.push(e.machine.status)
        },
        terminal: () => {},
        mirror: storeMirror(store),
        registry,
        tunnelFor: () => tunnel,
        log: (l) => void logs.push(l),
        retryMs: [50, 200],
        client: { maxBackoffMs: 100 },
      })
      cleanups.push(() => links.stop())
      links.start()
      return { links, statuses, logs, starts: () => starts }
    }

    it('starts it without asking, says so in the row and the log, and connects', async () => {
      const l = await linkTo(async () => ({ how: 'detached', note: null }))
      await eventually(() => l.links.list()[0]!.status === 'connected')
      expect(l.starts()).toBe(1)
      expect(l.statuses).toContain('starting')
      expect(l.statuses).not.toContain('not_running')
      expect(l.links.list()[0]!.hostStarted).toMatchObject({ how: 'detached', note: null, at: expect.any(Number) })
      expect(l.logs.join('\n')).toMatch(/Remote box: no Centralu host is running there; starting one \(centralu serve --detach\)[\s\S]*Remote box: started its host; it keeps running after this link ends/)
    })

    it('says when the host runs only while the link is up, and why', async () => {
      const l = await linkTo(async () => ({ how: 'link_bound', note: 'Windows did not start Centralu through WMI (returned 2).' }))
      await eventually(() => l.links.list()[0]!.status === 'connected')
      expect(l.links.list()[0]!.hostStarted).toMatchObject({ how: 'link_bound', note: /through WMI/ })
      expect(l.logs.join('\n')).toMatch(/its host runs only while this link is up: Windows did not start Centralu through WMI/)
    })

    it('reports a start that failed as not running, with the reason, and tries again later', async () => {
      let fail = true
      const l = await linkTo(async () => {
        if (fail) throw new Error('centralu serve exited (1) before its host answered')
        return { how: 'detached', note: null }
      })
      await eventually(() => l.links.list()[0]!.status === 'not_running')
      expect(l.links.list()[0]!.error).toBe('Centralu could not be started on Remote box: centralu serve exited (1) before its host answered')
      fail = false
      await eventually(() => l.links.list()[0]!.status === 'connected')
      expect(l.starts()).toBeGreaterThanOrEqual(2)
    })
  })
})

describe('machines.install (#82, plan §10.2)', () => {
  it('installs the hub’s version through the machine’s own shell, step by step, and refuses where it cannot', async () => {
    const reg = await fakeRegistry(['centralu', '@centralu/linux-x64'].map((name) => ({ name, version: APP_VERSION, files: { 'package.json': '{}' } })))
    cleanups.push(() => reg.close())
    const runs: string[] = []
    const answers = [
      'motd\nCENTRALU-PREFLIGHT os=Linux arch=x86_64 glibc=2.39 musl=0 freeKb=99999999 tar=1 gzip=1 fetch=curl sha=sha256sum\n',
      'CENTRALU-INSTALL node ok\n',
      `CENTRALU-INSTALL done ${JSON.stringify({ current: { version: APP_VERSION, node: '24.21.0' }, previous: { version: '0.0.1', node: '24.21.0' }, removed: ['0.0.0'], left: [] })}\n`,
    ]
    const tunnel = Object.assign(new DirectTunnel(() => lineFor(1)), { exec: async (cmd: string) => ({ code: 0, stderr: '', stdout: answers[runs.push(cmd) - 1] ?? '' }) })
    const installer = { runtime: () => ({ node: { version: '24.21.0', archives: { 'linux-x64': { file: 'node-v24.21.0-linux-x64.tar.gz', sha256: 'a'.repeat(64) } } } }), script: () => '// the installer', registry: { registry: reg.url } }
    const hub = await hubHost(() => lineFor(1), new Store(), true, { tunnelFor: () => tunnel, installer })
    const u = await ui(hub.port)
    const r = await u.call('machines.install', { machineId: 'm1' })
    expect(r).toMatchObject({ machine: { id: 'm1' }, current: { version: APP_VERSION }, previous: { version: '0.0.1' }, removed: ['0.0.0'] })
    // Preflight, Node, then the installer, each a script for the machine’s shell
    expect(runs).toHaveLength(3)
    expect(runs.every((c) => c.startsWith('printf %s '))).toBe(true)
    expect(Buffer.from(runs[2]!.split(' ')[2]!, 'base64').toString('utf8')).toContain('/node/v24.21.0/bin/node')
    // Refused where it cannot: an unknown machine, and a development hub, whose version is not published
    await expect(u.call('machines.install', { machineId: 'nope' })).rejects.toThrow(/No linked machine/)
    const dev = await hubHost(() => lineFor(1), new Store(), true, { tunnelFor: () => tunnel, installer, hub: { version: APP_VERSION, protocolVersion: PROTOCOL_VERSION, dev: true } })
    await expect((await ui(dev.port)).call('machines.install', { machineId: 'm1' })).rejects.toThrow(/development build is not published/)
    expect(runs).toHaveLength(3)
  })
})

describe('a machine whose Node is below the floor (#699)', () => {
  const PINNED = '24.21.0'
  const OLD = { managed: false, current: null, previous: null, node: '22.12.0' }
  const MANAGED = { managed: true, current: { version: APP_VERSION, node: PINNED }, previous: null, node: PINNED }

  /**
   * A machine on Node 22.12.0 (what its connection line reports), linked from a hub that can install.
   * `startHost` is what the machine's launcher answers; the scripted install steps switch the line to
   * the managed install, the way the machine's own launcher would then answer
   */
  async function linkTo(o: {
    startHost: (n: number) => Promise<HostStart>
    line?: Partial<ConnectionLine>
    dev?: boolean
    remote?: { shell: 'posix'; command?: string }
    /** Every command fails, as an install does on a machine that cannot download */
    failInstall?: boolean
    /** What the commands after the install answer (an uninstall); the machine is then back as it was */
    later?: string[]
  }) {
    const reg = await fakeRegistry(['centralu', '@centralu/linux-x64'].map((name) => ({ name, version: APP_VERSION, files: { 'package.json': '{}' } })))
    cleanups.push(() => reg.close())
    const remote = await remoteHost()
    const runs: string[] = []
    const calls: string[] = []
    let installed = false
    let running = false
    let starts = 0
    /** How many times the link opened the tunnel: each retry opens it again */
    let opens = 0
    const answers = [
      'CENTRALU-PREFLIGHT os=Linux arch=x86_64 glibc=2.39 musl=0 freeKb=99999999 tar=1 gzip=1 fetch=curl sha=sha256sum\n',
      'CENTRALU-INSTALL node ok\n',
      `CENTRALU-INSTALL done ${JSON.stringify({ current: { version: APP_VERSION, node: PINNED }, previous: null, removed: [], left: [] })}\n`,
    ]
    const tunnel = Object.assign(new DirectTunnel(() => (opens++, lineFor(remote.port, { hostRunning: running, install: installed ? MANAGED : OLD, ...o.line }))), {
      exec: async (cmd: string) => {
        runs.push(cmd)
        if (o.failInstall) return { code: 1, stderr: 'curl: (6) Could not resolve host', stdout: '' }
        const i = runs.length - 1
        if (i >= 3) {
          const out = o.later?.[i - 3] ?? ''
          if (out.includes('uninstalled')) {
            installed = false
            running = false
          }
          return { code: 0, stderr: '', stdout: out }
        }
        installed = runs.length >= 3
        return { code: 0, stderr: '', stdout: answers[i] ?? '' }
      },
      startHost: async () => {
        calls.push(installed ? 'managed' : 'system')
        const r = await o.startHost(++starts)
        running = true
        return r
      },
    })
    const store = new Store()
    storeRegistry(store).add({ id: 'm1', name: 'Remote box', sshTarget: 'box', remote: o.remote ?? { shell: 'posix' }, addedAt: 1, acceptedVersions: null })
    const logs: string[] = []
    const links = new Links({
      hub: { version: APP_VERSION, protocolVersion: PROTOCOL_VERSION, dev: o.dev === true },
      broadcast: () => {},
      terminal: () => {},
      mirror: storeMirror(store),
      registry: storeRegistry(store),
      tunnelFor: () => tunnel,
      log: (l) => void logs.push(l),
      retryMs: [50, 200],
      client: { maxBackoffMs: 100 },
      installer: { runtime: () => ({ node: { version: PINNED, archives: { 'linux-x64': { file: `node-v${PINNED}-linux-x64.tar.gz`, sha256: 'a'.repeat(64) } } } }), script: () => '// the installer', registry: { registry: reg.url } },
    })
    cleanups.push(() => links.stop())
    links.start()
    /** Waits until the link has opened the tunnel twice more: a retry has run through, and the next has begun (#845) */
    const retried = async () => {
      const at = opens
      await eventually(() => opens >= at + 2)
    }
    return { links, runs, calls, logs, row: () => links.list()[0]!, starts: () => starts, retried }
  }

  it('installs the pinned Node before it tries to start a host under the old one, and says so in one sentence', async () => {
    const l = await linkTo({ startHost: async () => ({ how: 'detached', note: null }) })
    await eventually(() => l.row().status === 'connected')
    // The system Node is never asked to start the host: preflight, Node, Centralu, then the managed launcher starts it
    expect(l.calls).toEqual(['managed'])
    expect(l.runs).toHaveLength(3)
    const note = 'Centralu installed its own Node 24.21.0 on Remote box, because the Node on Remote box (22.12.0) is older than 22.14.0, the oldest Centralu runs on.'
    expect(l.row().hostStarted?.note).toBe(note)
    expect(l.logs.join('\n')).toContain(note)
  })

  it('does the same when the machine’s launcher refuses its Node, naming the one it found', async () => {
    const l = await linkTo({
      line: { install: undefined },
      startHost: async (n) => {
        if (n === 1) throw new NodeTooOld('centralu serve needs Node 22.14.0 or newer and this is Node 22.13.1', 'refused', '22.13.1')
        return { how: 'detached', note: null }
      },
    })
    await eventually(() => l.row().status === 'connected')
    expect(l.calls).toEqual(['system', 'managed'])
    expect(l.row().hostStarted?.note).toBe('Centralu installed its own Node 24.21.0 on Remote box, because the Node on Remote box (22.13.1) is older than 22.14.0, the oldest Centralu runs on.')
  })

  it('switches too when the host crashed at startup (exit 3221225477) under a Node it cannot name', async () => {
    let n = 0
    const l = await linkTo({
      line: { install: undefined },
      startHost: async () => {
        if (++n === 1) throw new NodeTooOld('centralu serve exited (3221225477) before its host answered', 'crashed', null)
        return { how: 'detached', note: null }
      },
    })
    await eventually(() => l.row().status === 'connected')
    expect(l.calls).toEqual(['system', 'managed'])
    expect(l.row().hostStarted?.note).toBe('Centralu installed its own Node 24.21.0 on Remote box, because Centralu crashed on start under the Node on Remote box, and 22.14.0 is the oldest Centralu runs on.')
  })

  it('installs once: a host that still fails under the Node it installed is reported as it is', async () => {
    const l = await linkTo({
      startHost: async () => {
        throw new NodeTooOld('centralu serve exited (3221225477) before its host answered', 'crashed', null)
      },
    })
    await eventually(() => l.calls.length >= 2 && l.row().status === 'not_running')
    await l.retried()
    expect(l.runs).toHaveLength(3)
    expect(l.row().error).toBe('Centralu could not be started on Remote box: centralu serve exited (3221225477) before its host answered')
  })

  it('tries a failing install once, not at every retry (each one is a download)', async () => {
    const l = await linkTo({ failInstall: true, startHost: async () => ({ how: 'detached', note: null }) })
    await eventually(() => l.row().status === 'not_running')
    await l.retried()
    // Preflight failed once; the retries (every 50 to 200 ms here) report instead of trying again
    expect(l.runs).toHaveLength(1)
    expect(l.row().error).toMatch(/older than 22\.14\.0[\s\S]*installing it failed/)
    expect(l.calls).toEqual([])
  })

  it('does not blame a Node at or above the floor for a crash, and installs nothing', async () => {
    const l = await linkTo({
      line: { install: { managed: false, current: null, previous: null, node: '22.20.0' } },
      startHost: async () => {
        throw new NodeTooOld('centralu serve exited (3221225477) before its host answered', 'crashed', null)
      },
    })
    await eventually(() => l.row().status === 'not_running')
    expect(l.row().error).toBe('Centralu could not be started on Remote box: centralu serve exited (3221225477) before its host answered')
    expect(l.runs).toHaveLength(0)
  })

  it('treats the floor as unknown when this host’s copy of it is missing: no machine is judged, and the log says so', async () => {
    flags.floorBroken = true
    cleanups.push(() => void (flags.floorBroken = false))
    const l = await linkTo({ startHost: async () => ({ how: 'detached', note: null }) })
    await eventually(() => l.row().status === 'connected')
    expect(l.runs).toHaveLength(0)
    expect(l.starts()).toBe(1)
    expect(l.logs.filter((x) => x.includes('the Node floor could not be read'))).toHaveLength(1)
  })

  it('does not put back what the person removed: after `machines.uninstall` a below-floor machine is named, not installed again', async () => {
    const l = await linkTo({ later: ['CENTRALU-NOT-FOUND\n', 'CENTRALU-NOT-FOUND\n', 'CENTRALU-INSTALL uninstalled\n'], startHost: async () => ({ how: 'detached', note: null }) })
    await eventually(() => l.row().status === 'connected')
    expect(l.runs).toHaveLength(3)
    await l.links.uninstall('m1')
    await eventually(() => l.row().status === 'not_running')
    expect(l.row().error).toMatch(/older than 22\.14\.0[\s\S]*removed from there on request/)
    await l.retried()
    expect(l.runs).toHaveLength(6)
  })

  it('names the floor and asks for a Node update where it may not install: a development hub, or a command of the person’s own', async () => {
    const dev = await linkTo({ dev: true, startHost: async () => ({ how: 'detached', note: null }) })
    await eventually(() => dev.row().status === 'not_running')
    expect(dev.row().error).toBe(
      'The Node on Remote box (22.12.0) is older than 22.14.0, the oldest Centralu runs on, and this computer did not install its own Node there (this development build is not published): update Node there, and Centralu starts again.',
    )
    expect(dev.runs).toHaveLength(0)
    expect(dev.calls).toEqual([])
    const own = await linkTo({ remote: { shell: 'posix', command: 'my-centralu' }, startHost: async () => ({ how: 'detached', note: null }) })
    await eventually(() => own.row().status === 'not_running')
    expect(own.row().error).toMatch(/older than 22\.14\.0[\s\S]*it runs a command of its own in place of centralu/)
    expect(own.runs).toHaveLength(0)
  })
})

describe('machines.install from a hub running a local build (#689)', () => {
  it('installs the release the local build was cut from, and says so; the row it leaves connects although the versions differ', async () => {
    const reg = await fakeRegistry(['centralu', '@centralu/linux-x64'].map((name) => ({ name, version: APP_VERSION, files: { 'package.json': '{}' } })))
    cleanups.push(() => reg.close())
    const remote = await remoteHost()
    const runs: string[] = []
    const answers = [
      'CENTRALU-PREFLIGHT os=Linux arch=x86_64 glibc=2.39 musl=0 freeKb=99999999 tar=1 gzip=1 fetch=curl sha=sha256sum\n',
      'CENTRALU-INSTALL node ok\n',
      `CENTRALU-INSTALL done ${JSON.stringify({ current: { version: APP_VERSION, node: '24.21.0' }, previous: null, removed: [], left: [] })}\n`,
    ]
    const tunnel = Object.assign(new DirectTunnel(() => lineFor(remote.port)), { exec: async (cmd: string) => ({ code: 0, stderr: '', stdout: answers[runs.push(cmd) - 1] ?? '' }) })
    const installer = { runtime: () => ({ node: { version: '24.21.0', archives: { 'linux-x64': { file: 'node-v24.21.0-linux-x64.tar.gz', sha256: 'a'.repeat(64) } } } }), script: () => '// the installer', registry: { registry: reg.url } }
    const local = `${APP_VERSION}.local.2`
    const logs: string[] = []
    const hub = await hubHost(() => lineFor(remote.port), new Store(), true, { tunnelFor: () => tunnel, installer, log: (l) => logs.push(l), hub: { version: local, protocolVersion: PROTOCOL_VERSION, dev: false } })
    const u = await ui(hub.port)
    const r = await u.call('machines.install', { machineId: 'm1' })
    expect(r).toMatchObject({ current: { version: APP_VERSION }, note: expect.stringContaining(`local build ${local}`) })
    const script = Buffer.from(runs[2]!.split(' ')[2]!, 'base64').toString('utf8')
    const params = JSON.parse(Buffer.from(/"\$f" "([A-Za-z0-9+/=]+)"/.exec(script)![1]!, 'base64').toString('utf8')) as { version: string; hub: string }
    expect(params.version).toBe(APP_VERSION)
    expect(logs.some((l) => l.includes(`installing the release it was cut from, ${APP_VERSION}`))).toBe(true)
    // The remote now runs the base release, not the hub's exact version, and the link takes it
    await eventually(() => status(hub) === 'connected')
    expect(hub.links.list()[0]!.versions).toMatchObject({ older: null, compatible: true })
  })
})

describe('machines.update never installs an older release than the remote runs (#689)', () => {
  it('refuses with the two versions named, and touches nothing there', async () => {
    const remote = await remoteHost(0, new Store(), { version: '9.0.0' })
    const ran: string[] = []
    const tunnel = Object.assign(new DirectTunnel(() => lineFor(remote.port, { version: '9.0.0' })), { exec: async (cmd: string) => (ran.push(cmd), { code: 0, stderr: '', stdout: '' }) })
    const installer = { runtime: () => ({ node: { version: '24.21.0', archives: {} } }), script: () => '// the installer', registry: {} }
    const hub = await hubHost(() => lineFor(remote.port, { version: '9.0.0' }), new Store(), true, { tunnelFor: () => tunnel, installer })
    await eventually(() => status(hub) === 'connected' && hub.links.list()[0]!.versions?.remote.version === '9.0.0')
    const u = await ui(hub.port)
    await expect(u.call('machines.update', { machineId: 'm1' })).rejects.toThrow(new RegExp(`Remote box runs Centralu 9\\.0\\.0, newer than ${APP_VERSION.replaceAll('.', '\\.')}.*would downgrade`))
    expect(ran).toEqual([])
    expect(hub.links.list()[0]!.operation).toBeNull()
  })
})

describe('machines.update through the link (#82, plan §10.5)', () => {
  const NODE = '24.21.0'
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  /** What each remote command is, read back from the script the hub sent */
  const classify = (cmd: string): string => {
    if (cmd.includes('serve --stop')) return 'stop'
    const b64 = /^printf %s (\S+) \|/.exec(cmd)?.[1]
    const script = b64 ? Buffer.from(b64, 'base64').toString('utf8') : ''
    if (script.includes('CENTRALU-PREFLIGHT')) return 'preflight'
    if (script.includes('say node ok')) return 'node'
    if (script.includes('host.log')) return 'tail'
    const arg = /"\$f" "([A-Za-z0-9+/=]+)"/.exec(script)?.[1]
    const p = arg ? (JSON.parse(Buffer.from(arg, 'base64').toString('utf8')) as { action?: string; activate?: boolean }) : null
    return p?.action ?? (p?.activate === false ? 'install_beside' : 'install')
  }

  async function setup(o: { startsVersion: string }) {
    const reg = await fakeRegistry(['centralu', '@centralu/linux-x64'].map((name) => ({ name, version: APP_VERSION, files: { 'package.json': '{}' } })))
    cleanups.push(() => reg.close())
    const activity: HostActivity = { working: 2, approvals: 1, questions: 0, background: 0, terminals: 1, commandRuns: 0 }
    let running = await remoteHost(0, new Store(), { version: '0.0.1', activity: () => activity })
    let line = lineFor(running.port, { version: '0.0.1' })
    const runs: string[] = []
    const old = { version: '0.0.1', node: NODE }
    const next = { version: APP_VERSION, node: NODE }
    const done = (o: unknown) => `CENTRALU-INSTALL done ${JSON.stringify(o)}\n`
    let hub: Hub | null = null
    const exec = async (cmd: string) => {
      const kind = classify(cmd)
      runs.push(kind)
      const out = (stdout: string) => ({ code: 0, stderr: '', stdout })
      switch (kind) {
        case 'preflight':
          return out('CENTRALU-PREFLIGHT os=Linux arch=x86_64 glibc=2.39 musl=0 freeKb=99999999 tar=1 gzip=1 fetch=curl sha=sha256sum\n')
        case 'node':
          return out('CENTRALU-INSTALL node ok\n')
        case 'install_beside':
          return out(done({ installed: next, current: old, previous: null, removed: [], left: [] }))
        case 'stop': {
          await running.close()
          line = { ...line, hostRunning: false }
          // The person presses Reconnect while the host is down: the link must not open, or start a host, now
          hub!.links.reconnect('m1')
          await sleep(200)
          return out('{"v":1,"stop":{"ok":true,"wasRunning":true,"how":"asked"}}\n')
        }
        case 'pointers':
          return out(done(starts === '0.0.1' ? { current: old, previous: null } : { current: next, previous: old }))
        case 'prune':
          return out(done({ current: next, previous: old, removed: [], left: [] }))
        case 'tail':
          return out('host: the store was written by a newer Centralu\n')
        default:
          return out('')
      }
    }
    let starts = o.startsVersion
    const startHost = async (): Promise<HostStart> => {
      runs.push('start')
      running = await remoteHost(0, new Store(), { version: runs.includes('tail') ? '0.0.1' : starts })
      line = lineFor(running.port, { version: running === null ? '' : runs.includes('tail') ? '0.0.1' : starts })
      // What the pointers say once that host runs: after an update the old one is kept to go back to
      if (starts === APP_VERSION && !runs.includes('tail')) line = { ...line, install: { managed: true, current: next, previous: old, node: NODE } }
      else if (starts === '0.0.1') line = { ...line, install: { managed: true, current: old, previous: null, node: NODE } }
      return { how: 'detached', note: null }
    }
    const tunnel = Object.assign(
      new DirectTunnel(() => {
        runs.push('open')
        return line
      }),
      { exec, startHost },
    )
    const installer = { runtime: () => ({ node: { version: NODE, archives: { 'linux-x64': { file: `node-v${NODE}-linux-x64.tar.gz`, sha256: 'a'.repeat(64) } } } }), script: () => '// the installer', registry: { registry: reg.url } }
    hub = await hubHost(() => line, new Store(), true, { tunnelFor: () => tunnel, installer, checkMs: 1_500 })
    const u = await ui(hub.port)
    // An older remote on one protocol connects (#689); the update is offered, not required
    await eventually(() => status(hub!) === 'connected')
    return { hub, u, runs, activity, setStarts: (v: string) => (starts = v) }
  }

  it('rolls back to the version before, which is older than this hub, and checks it by its connection line (measured 2026-10-11)', async () => {
    // A rolled-back host is older than the hub, so the link does not open to it (plan §4) and no hello
    // comes: on a real Windows PC every rollback timed out and put the newer version back
    const { hub, u, setStarts } = await setup({ startsVersion: APP_VERSION })
    await u.call('machines.update', { machineId: 'm1' })
    await eventually(() => status(hub) === 'connected')
    setStarts('0.0.1')
    const r = await u.call('machines.rollback', { machineId: 'm1' })
    expect(r).toMatchObject({ current: { version: '0.0.1' } })
    await eventually(() => hub.links.list()[0]!.versions?.remote.version === '0.0.1' && status(hub) === 'connected')
  })

  it('says what would stop, holds the link while the host is down, reports each step, and answers once the new version said hello', async () => {
    const { hub, u, runs, activity } = await setup({ startsVersion: APP_VERSION })
    // The prompt's question, asked of the remote over a connection of its own while the link waits on versions
    expect(await u.call('machines.activity', { machineId: 'm1' })).toEqual({ activity })
    expect(hub.links.list()[0]!.install).toBeNull()
    const r = await u.call('machines.update', { machineId: 'm1' })
    expect(r).toMatchObject({ current: { version: APP_VERSION }, previous: { version: '0.0.1' }, machine: { install: { managed: true, current: { version: APP_VERSION } } } })
    // The row as it is after the operation, not mid-way: it said `updating` with the last step (#482)
    expect(r.machine.status).not.toBe('updating')
    expect(r.machine.operation).toBeNull()
    // Nothing opened the link between stopping the old host and starting the new one, though Reconnect was pressed
    const between = runs.slice(runs.indexOf('stop'), runs.indexOf('start'))
    expect(between).toEqual(['stop', 'pointers'])
    expect(runs.filter((k) => k !== 'open')).toEqual(['preflight', 'node', 'install_beside', 'stop', 'pointers', 'start', 'prune'])
    const steps = u
      .events()
      .filter((e) => e.type === 'machine_status' && e.machine.operation)
      .map((e) => e.machine.operation.step as string)
    expect([...new Set(steps)]).toEqual(['preflight', 'registry', 'node', 'centralu', 'stop', 'switch', 'start', 'check', 'prune'])
    expect(u.events().some((e) => e.type === 'machine_status' && e.machine.status === 'updating')).toBe(true)
    await eventually(() => status(hub) === 'connected')
    expect(hub.links.list()[0]!.operation).toBeNull()
  })

  it('puts the old version back when the host that answers is not the new one, and says so', async () => {
    const { hub, u, runs } = await setup({ startsVersion: '0.0.9' })
    await expect(u.call('machines.update', { machineId: 'm1' })).rejects.toThrow(
      /Centralu .* did not start on box \(it did not answer within 30 s\); it runs Centralu 0\.0\.1 again\. The end of its host\.log: host: the store was written by a newer Centralu/,
    )
    expect(runs.filter((k) => k !== 'open')).toEqual(['preflight', 'node', 'install_beside', 'stop', 'pointers', 'start', 'tail', 'stop', 'pointers', 'start'])
    // Back on the old version, the prompt is there again
    await eventually(() => hub.links.list()[0]!.versions?.remote.version === '0.0.1' && status(hub) === 'connected')
  })
})

describe('machines.autostart (#82, plan §10.4, owner decision 4)', () => {
  /** A machine whose `serve --autostart` keeps its state here, answering as serve.mjs does */
  async function setup(o: { how?: 'systemd' | 'task' | null; refuse?: string; gate?: Promise<void> } = {}) {
    const remote = await remoteHost()
    const how = o.how === undefined ? 'systemd' : o.how
    let on = false
    const runs: string[] = []
    const exec = async (cmd: string) => {
      const action = /serve --autostart (on|off|status)/.exec(cmd)?.[1]
      runs.push(action ?? cmd)
      if (o.gate && action === 'on') await o.gate
      if (o.refuse && action === 'on') return { code: 1, stderr: '', stdout: `${JSON.stringify({ v: 1, autostart: { ok: false, on, how, linger: null, message: o.refuse } })}\n` }
      if (action === 'on' || action === 'off') on = action === 'on' && how !== null
      return { code: 0, stderr: '', stdout: `${JSON.stringify({ v: 1, autostart: { ok: true, on, how, linger: on ? false : null } })}\n` }
    }
    const tunnel = Object.assign(new DirectTunnel(() => lineFor(remote.port, { autostart: { on, how, linger: on ? false : null } })), { exec })
    const hub = await hubHost(() => lineFor(remote.port), new Store(), true, { tunnelFor: () => tunnel })
    await eventually(() => status(hub) === 'connected')
    return { hub, u: await ui(hub.port), runs, isOn: () => on }
  }

  it('reads it from the connection line at link start, off by default', async () => {
    const { hub, runs } = await setup()
    expect(hub.links.list()[0]!.autostart).toEqual({ on: false, how: 'systemd', linger: null })
    // Nothing was asked over ssh to know it
    expect(runs).toEqual([])
  })

  it('turns it on and off through the Centralu there, and the row follows what the machine answered', async () => {
    const { hub, u, runs, isOn } = await setup()
    const r = await u.call('machines.autostart', { machineId: 'm1', on: true })
    expect(r).toMatchObject({ autostart: { on: true, how: 'systemd', linger: false }, machine: { id: 'm1', autostart: { on: true, linger: false } } })
    expect(isOn()).toBe(true)
    await eventually(() => u.events().some((e) => e.type === 'machine_status' && e.machine.autostart?.on === true))
    // Reading asks the machine, changing nothing
    expect((await u.call('machines.autostart', { machineId: 'm1' })).autostart).toEqual({ on: true, how: 'systemd', linger: false })
    expect((await u.call('machines.autostart', { machineId: 'm1', on: false })).autostart).toEqual({ on: false, how: 'systemd', linger: null })
    expect(runs).toEqual(['on', 'status', 'off'])
    expect(hub.links.list()[0]!.autostart?.on).toBe(false)
    // The link was never dropped for it: nothing starts or stops there
    expect(status(hub)).toBe('connected')
  })

  it('says on the row while it runs, and a change asked meanwhile is refused naming it (#850)', async () => {
    let release!: () => void
    const { hub, u } = await setup({ gate: new Promise<void>((r) => (release = r)) })
    const turning = u.call('machines.autostart', { machineId: 'm1', on: true })
    await eventually(() => hub.links.list()[0]!.operation !== null, 2000)
    // The row says so, as for an install or an update: the window greys out the buttons that would be refused
    expect(hub.links.list()[0]!.operation).toMatchObject({ kind: 'autostart', step: 'on', target: null })
    await eventually(() => u.events().some((e) => e.type === 'machine_status' && e.machine.operation?.kind === 'autostart'))
    await expect(u.call('machines.autostart', { machineId: 'm1', on: false })).rejects.toThrow('Remote box is busy with autostart; wait until it is done')
    release()
    expect((await turning).autostart.on).toBe(true)
    expect(hub.links.list()[0]!.operation).toBeNull()
    expect((await u.call('machines.autostart', { machineId: 'm1', on: false })).autostart.on).toBe(false)
  })

  it('passes on the machine’s refusal in one sentence, and keeps the row as the machine has it', async () => {
    const { hub, u } = await setup({ how: 'task', refuse: 'Task Scheduler did not take the task: Access is denied.' })
    await expect(u.call('machines.autostart', { machineId: 'm1', on: true })).rejects.toThrow(
      'Centralu on box could not be set to start at boot: Task Scheduler did not take the task: Access is denied.',
    )
    expect(hub.links.list()[0]!.autostart).toEqual({ on: false, how: 'task', linger: null })
    await expect(u.call('machines.autostart', { machineId: 'nope', on: true })).rejects.toThrow(/No linked machine/)
  })

  it('is refused where the hub has no shell on the machine', async () => {
    const remote = await remoteHost()
    const hub = await hubHost(() => lineFor(remote.port))
    await eventually(() => status(hub) === 'connected')
    await expect((await ui(hub.port)).call('machines.autostart', { machineId: 'm1', on: true })).rejects.toThrow(/no shell on Remote box/)
  })
})

describe('machines.sshHosts and machines.probe (#514)', () => {
  it('lists the ssh config’s hosts through the hub, each marked with the machines linked through it, and probes one', async () => {
    const remote = await remoteHost()
    const home = folder()
    mkdirSync(join(home, '.ssh'))
    writeFileSync(join(home, '.ssh', 'config'), 'Host *\n  User me\nHost box laptop\n')
    // A fake ssh: `-G` resolves as OpenSSH does; anything else is the probe, answered as a POSIX shell would
    const ssh = fakeExe(
      home,
      'ssh',
      `const a = process.argv.slice(2)
if (a[0] === '-G') { process.stdout.write('user me\\nhostname ' + a[2] + '.lan\\nport 22\\n'); process.exit(0) }
process.stderr.write('sh: powershell: not found\\n')
process.exit(127)
`,
    )
    const hub = await hubHost(() => lineFor(remote.port), new Store(), true, { ssh: { ssh, home } })
    const u = await ui(hub.port)
    expect(await u.call('machines.sshHosts')).toEqual({
      configFile: ['~', '.ssh', 'config'].join(sep),
      notes: [],
      hosts: [
        { alias: 'box', hostName: 'box.lan', user: 'me', port: 22, source: `${['~', '.ssh', 'config'].join(sep)}:3`, linked: [{ machineId: 'm1', name: 'Remote box', shell: 'posix', wslDistro: null }] },
        { alias: 'laptop', hostName: 'laptop.lan', user: 'me', port: 22, source: `${['~', '.ssh', 'config'].join(sep)}:3`, linked: [] },
      ],
    })
    expect(await u.call('machines.probe', { sshTarget: 'laptop' })).toMatchObject({ sshTarget: 'laptop', reachable: true, os: 'posix' })
    await expect(u.call('machines.probe', { sshTarget: '-oProxyCommand=x' })).rejects.toThrow(/Not an ssh target/)
  })
})

describe("the hub's orchestrator reads the linked machines (#82 phase 4)", () => {
  /** A conversation in the store: the person's line, then the agent's, `n` exchanges, seq from 1 */
  function talk(store: Store, sessionId: string, lines: [user: string, agent: string][]) {
    store.messages.appendMessages(
      lines.flatMap(([user, agent], i) => [
        { sessionId, seq: 2 * i + 1, role: 'user' as const, kind: 'text' as const, payload: { text: user }, ts: 1_700_000_000_000 + i },
        { sessionId, seq: 2 * i + 2, role: 'assistant' as const, kind: 'text' as const, payload: { text: agent }, ts: 1_700_000_000_000 + i },
      ]),
    )
  }

  /** A remote with a worker, its orchestrator and a coordinator, each with something said; a hub with its own orchestrator and worker */
  async function rig(o: { worktreeChild?: boolean } = {}) {
    const { store: remoteStore } = seeded([
      ['w1', 'worker', true],
      ['orch', 'orchestrator', false],
      ['coord', 'coordinator', true],
    ])
    // A conversation the agent can resume, so an instruction reaches it
    seedSession(remoteStore, 'p-remote', 'w1', 'worker', 'ext-w1')
    talk(remoteStore, 'w1', [
      ['set up the nightly backup', 'The zebracrossing job now runs at 02:00.'],
      ...Array.from({ length: 30 }, (_, i): [string, string] => [`step ${i}`, `done ${i}`]),
    ])
    talk(remoteStore, 'orch', [['plan', 'zebracrossing is the remote orchestrator’s own note']])
    talk(remoteStore, 'coord', [['lead', 'zebracrossing from a coordinator']])
    // A child under w1 makes it a worktree manager there: a seat that directs, whose input the injection gate guards (#120)
    if (o.worktreeChild) seedSession(remoteStore, 'p-remote', 'kid', 'worker')
    if (o.worktreeChild) remoteStore.sessions.upsertSession({ ...remoteStore.sessions.listSessions().find((s) => s.id === 'kid')!, parentSessionId: 'w1' })
    const remote = await remoteHost(0, remoteStore)

    const hubStore = new Store()
    const hubProject = 'p-hub'
    hubStore.projects.addProject({ id: hubProject, path: folder(), name: 'hub-project' })
    seedSession(hubStore, null, 'hub-orch', 'orchestrator', 'ext-hub-orch')
    seedSession(hubStore, hubProject, 'h1', 'worker')
    talk(hubStore, 'h1', [['where is the backup', 'zebracrossing lives on the server']])
    const hub = await hubHost(() => lineFor(remote.port), hubStore)
    await eventually(() => status(hub) === 'connected')
    const tool = async (name: string, args: Record<string, unknown> = {}) =>
      (await hub.mgr.runOrchestratorTool('hub-orch', name, args)) as { text: string; isError?: boolean }
    return { remote, hub, tool }
  }

  it('lists a linked machine’s sessions beside this computer’s, named by the machine, without its orchestrator or coordinators', async () => {
    const { tool } = await rig()
    const lines = (await tool('list_sessions')).text.split('\n').filter((l) => l.startsWith('- '))
    expect(lines).toEqual([
      expect.stringMatching(/^- h1 \[h1\] · project hub-project · claude · idle/),
      expect.stringMatching(/^- w1 \[m1\.w1\] · project remote-project on Remote box · claude · idle/),
    ])
  })

  it('reads a linked machine’s conversation there, around the spot recall found', async () => {
    const { tool } = await rig()
    const end = await tool('read_session', { sessionId: 'm1.w1', limit: 4 })
    expect(end.isError).toBeFalsy()
    expect(end.text).toContain('done 29')
    expect(end.text).not.toContain('zebracrossing')

    const found = await tool('recall', { query: 'zebracrossing' })
    // This computer's hit and the machine's, taken in turns; never the machine's orchestrator or coordinator
    expect(found.text).toContain('[hub-project] h1')
    expect(found.text).toContain('[remote-project on Remote box] w1')
    expect(found.text).not.toMatch(/remote orchestrator|coordinator/)
    const around = /read_session\(sessionId="m1\.w1", around=(\d+)\)/.exec(found.text)
    expect(around).not.toBeNull()
    const there = await tool('read_session', { sessionId: 'm1.w1', around: Number(around![1]), limit: 4 })
    expect(there.text).toContain('The zebracrossing job now runs at 02:00.')
  })

  it('neither reads nor directs the machine’s orchestrator', async () => {
    const { tool, remote } = await rig()
    const hidden = await tool('read_session', { sessionId: 'm1.orch' })
    expect(hidden).toMatchObject({ isError: true, text: expect.stringContaining('Not a session this machine shares') })
    const sent = await tool('send_to_session', { sessionId: 'm1.orch', text: 'do it' })
    expect(sent).toMatchObject({ isError: true, text: expect.stringContaining('Not a session this machine shares') })
    expect(remote.store.messages.loadMessages('orch', 5).map((m) => (m.payload as { text?: string }).text)).not.toContain('do it')
  })

  /** What the hub's orchestrator was told: the text of each message in its own session */
  const told = (hub: Hub) => hub.store.messages.loadMessages('hub-orch', 50).map((m) => String((m.payload as { text?: string }).text ?? ''))

  it('sends to a machine’s session as the hub’s orchestrator, and reports the end of that turn once (step 2)', async () => {
    const { tool, remote, hub } = await rig()
    // What the hub relayed: an event reaches its windows in the same call that hands it to the manager's reports
    const u = await ui(hub.port)
    const turnsEnded = () => u.events().filter((e) => e.type === 'turn_complete' && e.sessionId === 'm1.w1').length
    expect(await tool('send_to_session', { sessionId: 'm1.w1', text: 'run the backup', reportBack: true })).toMatchObject({
      text: 'Sent: m1.w1 (I will let you know once it is done)',
    })
    // Recorded there as an instruction from this orchestrator, named with this computer
    await eventually(() => remote.store.loadMessages('w1', 5).some((m) => (m.payload as { text?: string }).text === 'run the backup'))
    const there = remote.store.loadMessages('w1', 5).find((m) => (m.payload as { text?: string }).text === 'run the backup')!
    expect(there.payload).toMatchObject({ from: { name: 'hub-orch on Hub mac' } })
    await eventually(() => told(hub).some((t) => t.startsWith('[Centralu] The assigned work finished.')))
    const report = told(hub).find((t) => t.startsWith('[Centralu]'))!
    expect(report).toContain('id: m1.w1')
    expect(report).toMatch(/Project: .+ on Remote box/)
    expect(report).toContain('echo: run the backup')
    await eventually(() => turnsEnded() === 1)

    // No report was asked for this time: none comes, and the first one is not repeated
    await tool('send_to_session', { sessionId: 'm1.w1', text: 'and again' })
    await eventually(() => turnsEnded() === 2)
    /*
     * The hub has seen that turn end, so a report of it would be on its way. The next report asked for is the next
     * one to come (#845): one of that turn would have begun before it, on the same path, where a fixed sleep could
     * end before a late one arrived
     */
    await tool('send_to_session', { sessionId: 'm1.w1', text: 'and a third time', reportBack: true })
    await eventually(() => told(hub).filter((t) => t.startsWith('[Centralu]')).length >= 2)
    const reports = told(hub).filter((t) => t.startsWith('[Centralu]'))
    expect(reports).toHaveLength(2)
    expect(reports[1]).toContain('echo: and a third time')
  })

  it('reaches a machine’s session that has children (a former worktree manager, #561) as an instruction, not as someone else’s words (step 2)', async () => {
    const { tool, remote } = await rig({ worktreeChild: true })
    expect(remote.mgr.toolProfileOf('w1')).toBe('reader')
    await tool('send_to_session', { sessionId: 'm1.w1', text: 'merge the branch' })
    await eventually(() => remote.store.loadMessages('w1', 5).some((m) => (m.payload as { text?: string }).text === 'echo: merge the branch'))
  })

  it('changes a machine’s session’s settings there, and says so to the hub’s windows (step 2)', async () => {
    const { tool, remote, hub } = await rig()
    const u = await ui(hub.port)
    expect(await tool('update_session_settings', { sessionId: 'm1.w1', model: 'scripted-1' })).toMatchObject({ text: expect.stringContaining('Changed: m1.w1') })
    expect(remote.mgr.listSessions().find((s) => s.id === 'w1')!.model).toBe('scripted-1')
    await eventually(() => u.events().some((e: any) => e.type === 'settings_changed' && e.sessionId === 'm1.w1' && e.model === 'scripted-1'))
  })

  it('creates a session in a machine’s project with its first instruction, and asks for the id when two machines share the name (step 2)', async () => {
    const { tool, remote, hub } = await rig()
    const made = await tool('create_session', { project: 'm1.p-remote', name: 'Backups', firstMessage: 'hello there' })
    expect(made.text).toMatch(/^Created: Backups \[m1\.[0-9a-f-]+\] — sent the first instruction$/)
    const s = remote.mgr.listSessions().find((x) => x.name === 'Backups')!
    expect(s).toMatchObject({ projectId: 'p-remote', permissionPreset: 'normal' })
    await eventually(() => remote.store.loadMessages(s.id, 5).some((m) => (m.payload as { text?: string }).text === 'echo: hello there'))

    // By name: the machine's project is found by the name its window shows; one name on two machines is not guessed
    const name = (await remote.mgr.listProjects()).find((p) => p.id === 'p-remote')!.name
    expect((await tool('create_session', { project: name })).text).toMatch(/^Created: .+ \[m1\./)
    hub.store.projects.addProject({ id: 'p-dup', path: folder(), name })
    const both = await tool('create_session', { project: name })
    expect(both).toMatchObject({ isError: true })
    expect(both.text).toContain(`${name} [p-dup] on this computer`)
    expect(both.text).toContain(`${name} [m1.p-remote] on Remote box`)
  })

  it('makes a project on a machine once the person allows the card that names it (step 2)', async () => {
    const { tool, remote, hub } = await rig()
    const parent = folder()
    const pending = tool('create_project', { name: 'fresh', parent, machine: 'Remote box' })
    await eventually(() => !!hub.mgr.listSessions().find((s) => s.id === 'hub-orch')?.pendingApproval)
    const card = hub.mgr.listSessions().find((s) => s.id === 'hub-orch')!.pendingApproval!
    expect(card.detail).toEqual({ kind: 'project_create', name: 'fresh', path: join(parent, 'fresh'), machine: 'Remote box' })
    // Nothing is made before the answer
    expect((await remote.mgr.listProjects()).some((p) => p.path === join(parent, 'fresh'))).toBe(false)
    await hub.mgr.respondApproval('hub-orch', card.requestId, 'allow')
    const r = await pending
    expect(r.text).toMatch(/^Made the project "fresh" \[m1\.[^\]]+\], an empty folder at ".+" on Remote box\./)
    expect((await remote.mgr.listProjects()).some((p) => p.path === join(parent, 'fresh'))).toBe(true)
    expect(hub.store.projects.listProjects().some((p) => p.path === join(parent, 'fresh'))).toBe(false)

    expect(await tool('create_project', { name: 'x', machine: 'Nowhere' })).toMatchObject({
      isError: true,
      text: expect.stringContaining('No linked machine is called Nowhere'),
    })
  })

  it('a machine reads at most 200 lines and finds at most 50 hits for one call from a hub', async () => {
    const { store } = seeded([['long', 'worker', true]])
    talk(store, 'long', Array.from({ length: 150 }, (_, i): [string, string] => [`ask ${i} quokka`, `answer ${i} quokka`]))
    const remote = await remoteHost(0, store)
    const reader = remote.mgr.hostReader()
    for (const [asked, got] of [[1, 1], [40, 40], [199, 199], [200, 200], [201, 200], [5000, 200]] as const) {
      expect((await reader.read('long', asked)).lines).toHaveLength(got)
    }
    // Hits close together in one session are one story (dedupeNearbyHits), so the cap is reached only with gaps of 40
    talk(store, 'long', Array.from({ length: 2400 }, (_, i): [string, string] => [i % 21 === 0 ? `wombat ${i}` : `filler ${i}`, 'ok']))
    for (const [asked, got] of [[1, 1], [12, 12], [50, 50], [51, 50], [500, 50]] as const) {
      expect(await reader.recall('wombat', asked)).toHaveLength(got)
    }
  })

  it('lists an unreachable machine’s sessions as last known, and says it could not search it', async () => {
    const { tool, remote, hub } = await rig()
    await tool('list_sessions')
    await remote.close()
    await eventually(() => status(hub) !== 'connected')
    const list = (await tool('list_sessions')).text
    // From the headers mirror, which names a project as the window does (its folder's name; the seed's folder is a temporary one)
    expect(list).toMatch(/^- w1 \[m1\.w1\] · project cc-links-\w+ on Remote box · claude · idle · not reachable right now$/m)
    const found = await tool('recall', { query: 'zebracrossing' })
    expect(found.text).toContain('[hub-project] h1')
    expect(found.text).toContain('Not searched: Remote box (not reachable right now).')
    const read = await tool('read_session', { sessionId: 'm1.w1' })
    expect(read).toMatchObject({ isError: true, text: expect.stringContaining('Remote box is not reachable right now') })
  })
})

describe('ask_project reaches the projects of linked machines (#700)', () => {
  /** A remote with one project and one worker; a hub with a trusted project and an ordinary session in it (the caller) */
  async function rig() {
    const { store: remoteStore } = seeded([['w1', 'worker', true]])
    // A conversation the agent can resume, so a task reaches it
    seedSession(remoteStore, 'p-remote', 'w1', 'worker', 'ext-w1')
    const remote = await remoteHost(0, remoteStore)
    const hubStore = new Store()
    hubStore.projects.addProject({ id: 'p-hub', path: folder(), name: 'hub-project' })
    seedSession(hubStore, 'p-hub', 'h1', 'worker', 'ext-h1')
    const hub = await hubHost(() => lineFor(remote.port), hubStore)
    hub.mgr.setProjectTrusted('p-hub', true)
    await eventually(() => status(hub) === 'connected')
    const name = (await remote.mgr.listProjects()).find((p) => p.id === 'p-remote')!.name
    const ask = (opts: { project: string; session?: string; task?: string }) => hub.mgr.askProject('h1', opts)
    const card = () => hub.mgr.listSessions().find((s) => s.id === 'h1')?.pendingApproval
    const answer = async (decision: 'allow' | 'always' | 'deny') => {
      await eventually(() => !!card())
      const c = card()!
      await hub.mgr.respondApproval('h1', c.requestId, decision)
      // The next card is a new one: this one is gone before the caller asks again
      await eventually(() => card()?.requestId !== c.requestId)
      return c
    }
    return { remote, hub, name, ask, card, answer }
  }

  it('asks a session of a project on a linked machine: it runs there, and its answer comes back (unique bare name)', async () => {
    const { remote, name, ask, answer, hub } = await rig()
    const call = ask({ project: name, task: 'say hello' })
    const c = await answer('allow')
    // The card names the machine, and the target as that machine's own
    expect(c.detail).toMatchObject({ kind: 'project_access', access: 'delegate', to: { id: 'm1.p-remote', name, machine: 'Remote box', trusted: false }, session: { id: 'm1.w1' } })
    const r = await call
    expect(r).toMatchObject({ ok: true, state: 'done', project: `m1/${name}`, sessionId: 'm1.w1' })
    expect((r as { answer: string }).answer).toContain('echo: [A session in the project "hub-project" asks this project')
    // It ran on the machine, as an instruction from the hub's session, and the answer is that machine's last words
    const there = remote.store.messages.loadMessages('w1', 10).find((m) => (m.payload as { text?: string }).text?.includes('say hello'))!
    expect(there.payload).toMatchObject({ from: { name: expect.stringContaining('on Hub mac') } })
    expect(hub.mgr.listSessions().find((s) => s.id === 'h1')!.state).not.toBe('error')
  })

  // The machine counts its session one level below the hub's caller while it works on the task (#838 item 12)
  it('tells the machine the depth its session works at, which ends with the turn', async () => {
    const { remote, name, ask, answer } = await rig()
    const sent = vi.spyOn(remote.mgr, 'sendFromHub')
    const call = ask({ project: name, task: 'say hello' })
    await answer('allow')
    expect(await call).toMatchObject({ ok: true, state: 'done' })
    expect(sent).toHaveBeenCalledWith('w1', expect.stringContaining('say hello'), expect.any(String), { depth: 1 })
    await eventually(() => remote.store.appSetting('hub_ask_depth:w1') === null)
  })

  it('finds the project by machine/name, by the machine’s name, and by qualified id; "always" is read as once', async () => {
    const { name, ask, answer, hub } = await rig()
    for (const project of [`m1/${name}`, `Remote box/${name}`, `remote BOX/${name.toUpperCase()}`, 'm1.p-remote']) {
      const call = ask({ project, task: 'x' })
      await answer('deny')
      expect(await call).toMatchObject({ ok: false, error: expect.stringContaining(`${name} on Remote box`) })
    }
    // Nothing is remembered for a project of another machine: the next ask raises its card again
    const again = ask({ project: name, task: 'x' })
    await answer('always')
    await again
    expect(hub.store.permissions.listProjectConsents()).toEqual([])
    const third = ask({ project: name, task: 'x' })
    await answer('deny')
    await third
  })

  it('refuses a name that is on two machines with both choices, and a machine-qualified name settles it', async () => {
    const { name, ask, hub, answer } = await rig()
    hub.store.projects.addProject({ id: 'p-dup', path: folder(), name })
    const refused = await ask({ project: name, task: 'x' })
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining('More than one project is called') })
    const text = (refused as { error: string }).error
    expect(text).toContain(`${name} [p-dup] on this computer`)
    expect(text).toContain(`${name} [m1.p-remote] on Remote box`)
    // Either choice then works: the id of this computer's, the qualified name of the machine's
    expect(await ask({ project: 'p-dup', task: 'x' })).toMatchObject({ ok: false, error: expect.stringContaining('no ordinary session') })
    const call = ask({ project: `m1/${name}`, task: 'x' })
    await answer('deny')
    expect(await call).toMatchObject({ ok: false, error: expect.stringContaining('on Remote box') })
  })

  it('lists the other projects with the machine each is on, and names a machine it cannot reach instead of dropping its projects', async () => {
    const { remote, hub, name, ask } = await rig()
    const missing = await ask({ project: 'no-such-project', task: 'x' })
    expect((missing as { error: string }).error).toBe(`No project named "no-such-project". The other projects are: ${name} (on Remote box).`)

    await remote.close()
    await eventually(() => status(hub) !== 'connected')
    // The project is known from the headers mirror, so the refusal says why it cannot be asked
    for (const project of [name, `m1/${name}`]) {
      expect(await ask({ project, task: 'x' })).toMatchObject({
        ok: false,
        error: `Remote box is not reachable right now, so ${name} on Remote box cannot be asked. Try again once its link is back.`,
      })
    }
    expect(((await ask({ project: 'no-such-project', task: 'x' })) as { error: string }).error).toBe(
      `No project named "no-such-project". The other projects are: ${name} (on Remote box, not reachable right now). Not asked, and its projects may be missing: Remote box (not reachable right now).`,
    )
    // A project the hub never saw, on a machine that is down
    expect(await ask({ project: 'm1/never-seen', task: 'x' })).toMatchObject({ ok: false, error: expect.stringContaining('Remote box is not reachable right now, so "m1/never-seen" cannot be asked there') })
  })

  it('says the session is waiting on the person there, and waits again for the answer once it is given', async () => {
    const { remote, name, ask, answer } = await rig()
    const first = ask({ project: name, task: 'please approve the command' })
    await answer('allow')
    expect(await first).toMatchObject({ ok: true, state: 'working', sessionId: 'm1.w1', notice: expect.stringContaining('approval there') })
    // The same caller asking again with a task is told to wait, not to start a second one
    expect(await ask({ project: name, task: 'again' })).toMatchObject({ ok: false, error: expect.stringContaining('still working on your last task') })
    await eventually(() => !!remote.mgr.listSessions().find((s) => s.id === 'w1')?.pendingApproval)
    await remote.mgr.respondApproval('w1', remote.mgr.listSessions().find((s) => s.id === 'w1')!.pendingApproval!.requestId, 'allow')
    expect(await ask({ project: name })).toMatchObject({ ok: true, state: 'done', answer: 'approved' })
  })
  it('sends nothing when the person started a turn in the session while the question stood', async () => {
    const { remote, name, ask, answer, card } = await rig()
    const call = ask({ project: name, task: 'say hello' })
    await eventually(() => !!card())
    // The person works in that session there while the card is up: a turn that waits on them
    await remote.mgr.send('w1', 'please approve my command')
    await eventually(() => remote.mgr.listSessions().find((s) => s.id === 'w1')?.state === 'waiting_approval')
    await answer('allow')
    expect(await call).toMatchObject({ ok: false, error: expect.stringContaining('started a turn of its own while the question to the person stood') })
    // The task did not join their turn: it is nowhere in the conversation there
    expect(remote.store.messages.loadMessages('w1', 20).some((m) => (m.payload as { text?: string }).text?.includes('say hello'))).toBe(false)
    expect(remote.store.messages.loadMessages('w1', 20).some((m) => (m.payload as { text?: string }).text?.includes("through Centralu's ask_project"))).toBe(false)
  })

  it("withdraws the card when the caller's project loses trust, and sends nothing to the machine", async () => {
    const { remote, hub, name, ask, card } = await rig()
    const call = ask({ project: name, task: 'say hello' })
    await eventually(() => !!card())
    void hub.mgr.setProjectTrusted('p-hub', false)
    expect(card()).toBeFalsy()
    expect(await call).toMatchObject({ ok: false, error: expect.stringContaining("This session's project is not trusted") })
    expect(remote.store.messages.loadMessages('w1', 20).some((m) => (m.payload as { text?: string }).text?.includes('say hello'))).toBe(false)
  })

  it('refuses an approval that comes after the trust it rested on is gone, and sends nothing to the machine', async () => {
    const { remote, hub, name, ask, answer, card } = await rig()
    const call = ask({ project: name, task: 'say hello' })
    await eventually(() => !!card())
    // Taken away at the store, so only the read after the answer can see it
    hub.store.projects.setProjectTrusted('p-hub', false)
    await answer('allow')
    expect(await call).toMatchObject({ ok: false, error: expect.stringContaining("This session's project is not trusted") })
    expect(remote.store.messages.loadMessages('w1', 20).some((m) => (m.payload as { text?: string }).text?.includes('say hello'))).toBe(false)
  })

  it('ends the wait with a sentence when the link drops after the task was sent, instead of "still working" for good', async () => {
    const { remote, name, ask, answer } = await rig()
    const first = ask({ project: name, task: 'please approve the command' })
    await answer('allow')
    expect(await first).toMatchObject({ ok: true, state: 'working', notice: expect.stringContaining('approval there') })
    await remote.close()
    // The next call is told what happened to the task, not that it still works
    let last: Awaited<ReturnType<typeof ask>> | undefined
    await eventually(async () => {
      last = await ask({ project: name })
      return !last.ok || last.state !== 'working'
    })
    expect(last).toMatchObject({
      ok: false,
      error: expect.stringMatching(/the link to Remote box dropped before the turn ended.*may still be running there/),
    })
  })
})

describe('start_agent starts a child on a linked machine (#1038)', () => {
  /** A git folder whose `origin` is `url`, with one commit so a worktree can branch from it */
  function checkout(url: string | null): string {
    const dir = folder()
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' })
    git('init', '-q')
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'first')
    if (url) git('remote', 'add', 'origin', url)
    return dir
  }

  /**
   * A remote with two projects, one a checkout of the hub's repository written another way, and a hub whose trusted
   * project's session h1 starts the child
   */
  async function rig() {
    const remoteStore = new Store()
    remoteStore.projects.addProject({ id: 'p-other', path: checkout('git@github.com:me/other.git'), name: 'other' })
    remoteStore.projects.addProject({ id: 'p-app', path: checkout('git@github.com:Me/App.git'), name: 'app-checkout' })
    const remote = await remoteHost(0, remoteStore)
    const hubStore = new Store()
    hubStore.projects.addProject({ id: 'p-hub', path: checkout('https://github.com/me/app'), name: 'app' })
    seedSession(hubStore, 'p-hub', 'h1', 'worker', 'ext-h1')
    const hub = await hubHost(() => lineFor(remote.port), hubStore)
    await hub.mgr.setProjectTrusted('p-hub', true)
    await eventually(() => status(hub) === 'connected')
    const card = () => hub.mgr.listSessions().find((s) => s.id === 'h1')?.pendingApproval
    const answer = async (decision: 'allow' | 'always' | 'deny') => {
      await eventually(() => !!card())
      const c = card()!
      await hub.mgr.respondApproval('h1', c.requestId, decision)
      return c
    }
    const start = (opts: Partial<Parameters<SessionManager['startAgent']>[1]> = {}) =>
      hub.mgr.startAgent('h1', { task: 'say hello', machine: 'Remote box', ...opts })
    const agent = (sessionId: string, action: 'status' | 'send' | 'wait' | 'stop' | 'delete', text?: string) =>
      hub.mgr.agentSession('h1', { sessionId, action, ...(text ? { text } : {}) })
    // As the machine names its projects (the folder's name), which is what the hub reads
    const nameOf = async (id: string) => (await remote.mgr.listProjects()).find((p) => p.id === id)!.name
    const told = () => hub.store.loadMessages('h1', 50).map((m) => (m.payload as { text?: string }).text ?? '').filter((t) => t.startsWith('[Centralu]'))
    return { remote, remoteStore, hub, card, answer, start, agent, told, nameOf }
  }

  it("starts it in the machine's checkout of the same repository, behind a card that names the machine, and waits for its answer", async () => {
    const { remote, remoteStore, hub, answer, start, agent, nameOf } = await rig()
    const call = start()
    const c = await answer('allow')
    expect(c.detail).toMatchObject({ kind: 'agent_start', machine: 'Remote box', project: { id: 'm1.p-app', name: await nameOf('p-app') }, preset: 'normal' })
    const r = await call
    expect(r).toMatchObject({ ok: true, state: 'done', notice: expect.stringContaining('works on Remote box') })
    if (!r.ok) return
    expect((r as { answer: string }).answer).toContain('echo: [A session working on this repository on another computer')
    // It is a session of that project there, recorded on that machine one level below the caller
    const child = remote.mgr.listSessions().find((s) => `m1.${s.id}` === r.sessionId)!
    expect(child).toMatchObject({ projectId: 'p-app', permissionPreset: 'normal' })
    expect(remoteStore.appSetting(`agent_depth:${child.id}`)).toBe('1')
    // The caller's own: listed with its machine, and followed through the link
    const listAgents = (id: string) => (hub.mgr as unknown as { delegationFlow: { listAgents(id: string): unknown } }).delegationFlow.listAgents(id)
    expect(listAgents('h1')).toEqual([expect.objectContaining({ sessionId: r.sessionId, machine: 'Remote box', state: 'finished' })])
    expect(await agent(r.sessionId, 'status')).toMatchObject({ ok: true, state: 'at_rest', answer: expect.stringContaining('echo:') })
    // A card for another machine has no "always": the next start asks again
    const again = start({ task: 'once more' })
    await answer('always')
    expect(await again).toMatchObject({ ok: true })
    expect(hub.store.permissions.listProjectConsents()).toEqual([])
    const third = start({ task: 'and again' })
    await answer('deny')
    expect(await third).toMatchObject({ ok: false, error: expect.stringContaining('did not allow this session to start an agent on Remote box') })
  })

  it('refuses with what the machine has when none of its projects is a checkout of this repository', async () => {
    const { remoteStore, start, card, nameOf } = await rig()
    const there = remoteStore.projects.listProjects().find((p) => p.id === 'p-app')!.path
    execFileSync('git', ['-C', there, 'remote', 'set-url', 'origin', 'git@github.com:me/elsewhere.git'], { stdio: 'ignore' })
    const r = await start()
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('Remote box has no checkout of https://github.com/me/app') })
    expect((r as { error: string }).error).toContain(`"${await nameOf('p-other')}" (git@github.com:me/other.git)`)
    expect((r as { error: string }).error).toContain(`"${await nameOf('p-app')}" (git@github.com:me/elsewhere.git)`)
    expect(await start({ machine: 'nowhere' })).toMatchObject({ ok: false, error: expect.stringContaining('No linked machine is called "nowhere"') })
    expect(card()).toBeFalsy()
  })

  it('reports the end of a turn it was not waited on to the session that started it, and takes sends, a stop and a delete', async () => {
    const { remote, answer, start, agent, told } = await rig()
    const call = start({ wait: false })
    await answer('allow')
    const r = await call
    expect(r).toMatchObject({ ok: true, state: 'working', reported: true })
    if (!r.ok) return
    await eventually(() => told().some((t) => t.startsWith('[Centralu] The assigned work finished')))
    // More work, waited on: its answer is the call's, and no second report comes
    expect(await agent(r.sessionId, 'send', 'and now this')).toMatchObject({ ok: true, state: 'working' })
    expect(await agent(r.sessionId, 'wait')).toMatchObject({ ok: true, state: 'done', answer: expect.stringContaining('and now this') })
    const reports = told().filter((t) => t.startsWith('[Centralu] The assigned work finished')).length
    // A turn that waits on the person there, stopped from here
    expect(await agent(r.sessionId, 'send', 'please approve the command')).toMatchObject({ ok: true, state: 'working' })
    const id = r.sessionId.slice('m1.'.length)
    await eventually(() => remote.mgr.listSessions().find((s) => s.id === id)?.state === 'waiting_approval')
    expect(await agent(r.sessionId, 'stop')).toMatchObject({ ok: true, state: 'stopped' })
    // Deleted there, into that machine's trash, and no longer the hub's to follow
    expect(await agent(r.sessionId, 'delete')).toMatchObject({ ok: true, state: 'deleted', notice: expect.stringContaining("Remote box's trash") })
    expect(remote.mgr.listSessions().some((s) => s.id === id)).toBe(false)
    expect(await agent(r.sessionId, 'status')).toMatchObject({ ok: false, error: expect.stringContaining('is not a session this session started') })
    expect(told().filter((t) => t.startsWith('[Centralu] The assigned work finished')).length).toBe(reports)
  })

  it('starts it in a new worktree there on the branch asked for', async () => {
    const { remote, answer, start } = await rig()
    // That machine's own rule: a worktree is made only in a project trusted there
    const refused = start({ branch: 'feat-remote' })
    await answer('allow')
    expect(await refused).toMatchObject({ ok: false, error: expect.stringContaining('Worktree sessions need a trusted project') })
    await remote.mgr.setProjectTrusted('p-app', true)
    const call = start({ branch: 'feat-remote' })
    expect((await answer('allow')).detail).toMatchObject({ worktree: { branch: 'feat-remote' } })
    const r = await call
    if (!r.ok) throw new Error(r.error)
    expect(remote.mgr.listSessions().find((s) => `m1.${s.id}` === r.sessionId)?.worktree).toMatchObject({ branch: 'feat-remote' })
  })

  it('tells the parent when the link drops, and reports the turn that ended meanwhile once the link is back', async () => {
    const { remote, remoteStore, hub, answer, start, agent, told } = await rig()
    // A turn that waits on the person there never ends by itself
    const call = start({ task: 'please approve the command', wait: false })
    await answer('allow')
    const r = await call
    if (!r.ok) throw new Error(r.error)
    const id = r.sessionId.slice('m1.'.length)
    await eventually(() => remote.mgr.listSessions().find((s) => s.id === id)?.state === 'waiting_approval')
    await remote.close()
    await eventually(() => told().some((t) => t.includes('The link to Remote box dropped while')))
    expect(await agent(r.sessionId, 'status')).toMatchObject({ ok: false, error: expect.stringContaining('Remote box cannot be asked') })
    // Back on the same port: its process went with the host, so the turn is over, and its report comes now
    await remoteHost(remote.port, remoteStore)
    await eventually(() => status(hub) === 'connected')
    await eventually(() => told().some((t) => t.startsWith('[Centralu] The assigned work')), 10_000)
  })
})

/*
 * The forward's local end is a loopback port another account on the hub can take first (#838). A remote whose line says
 * `proof` is asked to prove it holds the token before the hello carries it there.
 */
describe('a link to a host that can prove it holds the token', () => {
  it('comes up with the real host', async () => {
    const remote = await remoteHost()
    const hub = await hubHost(() => lineFor(remote.port, { proof: true }))
    await eventually(() => status(hub) === 'connected')
  })

  // A host from before the proof, still running after an update, closes on `prove` (#838 review): said as that
  it('says the machine runs an older host than the one installed, and to restart it, when the host refuses the proof', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    cleanups.push(() => new Promise<void>((r) => wss.close(() => r())))
    wss.on('connection', (ws) => ws.on('message', () => ws.close(4001, 'not a hello')))
    const hub = await hubHost(() => lineFor((wss.address() as { port: number }).port, { proof: true }))
    await eventually(() => status(hub) === 'refused')
    expect(hub.links.list()[0]!.error).toMatch(/runs an older Centralu host than the one installed there.*Restart it there: `centralu serve --stop`/)
  })

  it('never sends the token to whatever else holds the port', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    cleanups.push(() => new Promise<void>((r) => wss.close(() => r())))
    const got: string[] = []
    // It answers like a host would after a hello, and with a proof it cannot make
    wss.on('connection', (ws) => ws.on('message', (d) => {
      got.push(String(d))
      const f = JSON.parse(String(d)) as { kind: string; nonce?: string }
      ws.send(JSON.stringify(f.kind === 'prove' ? { kind: 'proof', nonce: f.nonce, mac: 'A'.repeat(43) } : { kind: 'hello_ok', protocolVersion: PROTOCOL_VERSION, resyncRequired: false, currentSeq: 0 }))
    }))
    const hub = await hubHost(() => lineFor((wss.address() as { port: number }).port, { proof: true }))
    await eventually(() => got.length >= 2)
    expect(got.join('\n')).not.toContain(`"${TOKEN}"`)
    expect(got.every((g) => JSON.parse(g).kind === 'prove')).toBe(true)
    expect(status(hub)).not.toBe('connected')
  })
})
