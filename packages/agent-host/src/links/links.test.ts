import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APP_VERSION, PROTOCOL_VERSION, sessionLiveDefaults, type HostActivity, type MachineInfo, type NormalizedEvent, type SessionInfo } from '@cc/protocol'
import { Store } from '../dev-services/store.js'
import { SessionManager } from '../sessions/manager.js'
import { createRpcHandler } from '../rpc.js'
import { HostServer } from '../transport/server.js'
import { Links, type LinkDeps } from './links.js'
import { fakeRegistry } from './fake-registry.test-helpers.js'
import { Router } from './router.js'
import { DirectTunnel, type ConnectionLine, type HostStart, type Tunnel } from './tunnel.js'
import { storeMirror, storeRegistry } from './stored.js'
import { scriptedAdapters } from './scripted-agent.test-helpers.js'

/**
 * Two real hosts in one process (#82): each with its own store, session manager, RPC handler and
 * server, the hub with the router and links `main.ts` wires, linked to the other as `m1` on
 * loopback. Only the transport differs from a real link (tunnel.test.ts covers ssh).
 */

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
    broadcast: (e) => server.broadcast(e),
    terminal: (f) => server.pushTerminal(f),
    mirror: storeMirror(store),
    registry,
    tunnelFor: () => new DirectTunnel(line),
    retryMs: [50, 200],
    client: { maxBackoffMs: 100 },
    ...extra,
  })
  mgr.useLinkedSessions((id) => links.knowsSession(id))
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

const until = async (pred: () => boolean | Promise<boolean>, ms = 5000) => {
  const t0 = Date.now()
  while (!(await pred())) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
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
  store.addProject({ id: projectId, path: folder(), name: 'remote-project' })
  for (const [id, kind, inProject] of sessions) seedSession(store, inProject ? projectId : null, id, kind)
  return { store, projectId }
}

function seedSession(store: Store, projectId: string | null, id: string, kind: SessionInfo['kind'] = 'worker') {
  store.upsertSession({
    id,
    projectId,
    kind,
    tool: 'claude',
    externalId: null,
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
  it('works a remote session end to end: lists, create, send, approve, with ids qualified and events under the hub’s numbers', async () => {
    const remote = await remoteHost()
    const remoteProject = await remote.mgr.addProject(folder())
    const hub = await hubHost(() => lineFor(remote.port))
    await hub.mgr.addProject(folder())
    await until(() => status(hub) === 'connected')
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
    await until(() => u.events().some((e) => e.type === 'message_delta' && e.text === 'echo: hello'))
    await u.call('agents.send', { sessionId: s.id, text: 'approve this' })
    await until(() => u.events().some((e) => e.type === 'approval_request'))
    const ask = u.events().find((e) => e.type === 'approval_request')!
    expect(ask.sessionId).toBe(s.id)
    await u.call('agents.respondApproval', { sessionId: s.id, requestId: ask.requestId, decision: 'allow' })
    await until(() => u.events().some((e) => e.type === 'message_delta' && e.text === 'approved'))

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
    await until(() => status(hub) === 'connected')
    const u = await ui(hub.port)
    expect((await u.call('sessions.list')).map((x: any) => x.id)).toEqual(['m1.worker1'])
    remote.server.broadcast({ type: 'session_title', sessionId: 'orch', title: 'secret plan', auto: true })
    remote.server.broadcast({ type: 'session_title', sessionId: 'worker1', title: 'visible', auto: true })
    await until(() => u.events().some((e) => e.type === 'session_title'))
    await new Promise((r) => setTimeout(r, 100))
    expect(u.events().filter((e) => e.type === 'session_title').map((e) => e.sessionId)).toEqual(['m1.worker1'])
    // Hub-only events of the remote stay there
    remote.server.broadcast({ type: 'themes_changed' })
    remote.server.broadcast({ type: 'external_apps_changed' })
    await until(() => u.events().some((e) => e.type === 'external_apps_changed'))
    expect(u.events().some((e) => e.type === 'themes_changed')).toBe(false)
  })

  it('relays terminal output under the machine’s prefix', async () => {
    const remote = await remoteHost()
    const hub = await hubHost(() => lineFor(remote.port))
    await until(() => status(hub) === 'connected')
    const u = await ui(hub.port)
    remote.server.pushTerminal({ terminalId: 'term-9', data: 'hi' })
    remote.server.pushTerminal({ terminalId: 'run-2', exitCode: 1 })
    await until(() => u.frames.filter((f) => f.kind === 'term' || f.kind === 'term_exit').length === 2)
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
    await until(() => status(hub) === 'connected')
    const u = await ui(hub.port)
    const s = await u.call('agents.createSession', { projectId: `m1.${p.id}`, cwd: p.path, tool: 'claude' })
    expect(s.live).toBe(true)
    await u.call('sessions.list')
    expect(await u.call('grid.set', { panels: [{ kind: 'session', sessionId: s.id }] })).toEqual([{ kind: 'session', sessionId: s.id }])

    await remote.close()
    await until(() => status(hub) !== 'connected')
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
    await until(() => status(hub) === 'connected')
    await until(() => u.events().filter((e: any) => e.type === 'machine_resync').length > resyncsBefore)
    const back = (await u.call('sessions.list')).find((x: any) => x.id === s.id)
    // The remote restarted without a keeper: its agent is gone, which the fresh list says and the UI wakes
    expect(back).toMatchObject({ live: false })
    expect(back.unreachable).toBeUndefined()
  })

  it('keeps the links and the mirror in its store: a restarted hub lists an away machine’s sessions at once', async () => {
    const remote = await remoteHost(0, seeded([['w1', 'worker', true]]).store)
    const hubStore = new Store()
    const first = await hubHost(() => lineFor(remote.port), hubStore)
    await until(() => status(first) === 'connected')
    await remote.close()
    await first.links.stop()
    // A new hub on the same store, the machine still away
    const second = await hubHost(() => lineFor(remote.port), hubStore, false)
    const u = await ui(second.port)
    expect(second.links.list().map((m) => m.id)).toEqual(['m1'])
    expect(await u.call('sessions.list')).toEqual([expect.objectContaining({ id: 'm1.w1', unreachable: true })])
  })

  it('holds the link at versions_differ until the person declines to align, and never across protocols', async () => {
    const remote = await remoteHost()
    let line = lineFor(remote.port, { version: '0.1.0-beta.1' })
    const hub = await hubHost(() => line)
    await until(() => status(hub) === 'versions_differ')
    const info = hub.links.list()[0]!
    expect(info.versions).toMatchObject({ older: 'remote', compatible: true, remote: { version: '0.1.0-beta.1' } })
    expect(info.error).toMatch(/Update Remote box, or connect anyway/)
    const u = await ui(hub.port)
    await expect(u.call('sessions.list')).resolves.toEqual([])

    const accepted: MachineInfo = await u.call('machines.acceptVersions', { machineId: 'm1' })
    expect(accepted.versions?.accepted).toBe(true)
    // The remote's own hello names its real version, which differs from what was accepted: asked again
    await until(() => status(hub) === 'connected' || status(hub) === 'versions_differ')

    line = lineFor(remote.port, { protocolVersion: PROTOCOL_VERSION + 1 })
    await u.call('machines.reconnect', { machineId: 'm1' })
    await until(() => hub.links.list()[0]!.versions?.compatible === false)
    expect(status(hub)).toBe('versions_differ')
    await expect(u.call('machines.acceptVersions', { machineId: 'm1' })).rejects.toThrow(/different protocols/)
  })

  it('a refused token asks the remote again once, then reports and backs off instead of looping', async () => {
    const remote = await remoteHost()
    let asked = 0
    const hub = await hubHost(() => {
      asked++
      return lineFor(remote.port, { token: 'rotated-but-serve-keeps-the-old-one' })
    })
    await until(() => status(hub) === 'refused')
    expect(hub.links.list()[0]!.error).toMatch(/restart `centralu serve` there/)
    const atRefusal = asked
    await new Promise((r) => setTimeout(r, 300))
    // Backoff from 50 ms doubling (the test's retry): a handful of asks, not one per event-loop turn
    expect(asked - atRefusal).toBeLessThanOrEqual(3)
    expect(atRefusal).toBe(2)
  })

  it('adds and removes a machine through the hub, and removing it takes its sessions and panels away', async () => {
    const remote = await remoteHost(0, seeded([['w1', 'worker', true]]).store)
    const hub = await hubHost(() => lineFor(remote.port), new Store(), false)
    const u = await ui(hub.port)
    await expect(u.call('machines.add', { name: 'x', sshTarget: '-oProxyCommand=evil' })).rejects.toThrow(/Not an ssh target/)
    await expect(u.call('machines.add', { name: 'x', sshTarget: 'box', shell: 'wsl' })).rejects.toThrow(/distro/)
    const added: MachineInfo = await u.call('machines.add', { name: 'Remote box', sshTarget: 'box' })
    expect(added).toMatchObject({ id: 'remote-box', shell: 'posix' })
    await until(() => status(hub) === 'connected')
    expect((await u.call('sessions.list')).map((s: any) => s.id)).toEqual(['remote-box.w1'])
    await u.call('grid.set', { panels: [{ kind: 'session', sessionId: 'remote-box.w1' }] })
    await u.call('machines.remove', { machineId: 'remote-box' })
    expect(await u.call('machines.list')).toEqual([])
    expect(await u.call('sessions.list')).toEqual([])
    expect(await u.call('grid.get', { tagged: true })).toEqual([])
    expect(u.events().some((e: any) => e.type === 'machine_resync' && e.machineId === 'remote-box')).toBe(true)
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
    await until(() => seen.includes('open'))
    await links.remove('m1')
    release()
    // The forward an ssh tunnel brought up after the removal would otherwise run until the host exits
    await until(() => seen.at(-1) === 'close' && seen.includes('opened'))
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
      await until(() => l.links.list()[0]!.status === 'connected')
      expect(l.starts()).toBe(1)
      expect(l.statuses).toContain('starting')
      expect(l.statuses).not.toContain('not_running')
      expect(l.links.list()[0]!.hostStarted).toMatchObject({ how: 'detached', note: null, at: expect.any(Number) })
      expect(l.logs.join('\n')).toMatch(/Remote box: no Centralu host is running there; starting one \(centralu serve --detach\)[\s\S]*Remote box: started its host; it keeps running after this link ends/)
    })

    it('says when the host runs only while the link is up, and why', async () => {
      const l = await linkTo(async () => ({ how: 'link_bound', note: 'Windows did not start Centralu through WMI (returned 2).' }))
      await until(() => l.links.list()[0]!.status === 'connected')
      expect(l.links.list()[0]!.hostStarted).toMatchObject({ how: 'link_bound', note: /through WMI/ })
      expect(l.logs.join('\n')).toMatch(/its host runs only while this link is up: Windows did not start Centralu through WMI/)
    })

    it('reports a start that failed as not running, with the reason, and tries again later', async () => {
      let fail = true
      const l = await linkTo(async () => {
        if (fail) throw new Error('centralu serve exited (1) before its host answered')
        return { how: 'detached', note: null }
      })
      await until(() => l.links.list()[0]!.status === 'not_running')
      expect(l.links.list()[0]!.error).toBe('Centralu could not be started on Remote box: centralu serve exited (1) before its host answered')
      fail = false
      await until(() => l.links.list()[0]!.status === 'connected')
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
          return out(done({ current: next, previous: old }))
        case 'prune':
          return out(done({ current: next, previous: old, removed: [], left: [] }))
        case 'tail':
          return out('host: the store was written by a newer Centralu\n')
        default:
          return out('')
      }
    }
    const startHost = async (): Promise<HostStart> => {
      runs.push('start')
      running = await remoteHost(0, new Store(), { version: runs.includes('tail') ? '0.0.1' : o.startsVersion })
      line = lineFor(running.port, { version: running === null ? '' : runs.includes('tail') ? '0.0.1' : o.startsVersion })
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
    await until(() => status(hub!) === 'versions_differ')
    return { hub, u, runs, activity }
  }

  it('says what would stop, holds the link while the host is down, reports each step, and answers once the new version said hello', async () => {
    const { hub, u, runs, activity } = await setup({ startsVersion: APP_VERSION })
    // The prompt's question, asked of the remote over a connection of its own while the link waits on versions
    expect(await u.call('machines.activity', { machineId: 'm1' })).toEqual({ activity })
    expect(hub.links.list()[0]!.install).toBeNull()
    const r = await u.call('machines.update', { machineId: 'm1' })
    expect(r).toMatchObject({ current: { version: APP_VERSION }, previous: { version: '0.0.1' }, machine: { install: { managed: true, current: { version: APP_VERSION } } } })
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
    await until(() => status(hub) === 'connected')
    expect(hub.links.list()[0]!.operation).toBeNull()
  })

  it('puts the old version back when the host that answers is not the new one, and says so', async () => {
    const { hub, u, runs } = await setup({ startsVersion: '0.0.9' })
    await expect(u.call('machines.update', { machineId: 'm1' })).rejects.toThrow(
      /Centralu .* did not start on box \(it did not answer within 30 s\); it runs Centralu 0\.0\.1 again\. The end of its host\.log: host: the store was written by a newer Centralu/,
    )
    expect(runs.filter((k) => k !== 'open')).toEqual(['preflight', 'node', 'install_beside', 'stop', 'pointers', 'start', 'tail', 'stop', 'pointers', 'start'])
    // Back on the old version, the prompt is there again
    await until(() => status(hub) === 'versions_differ')
    expect(hub.links.list()[0]!.versions?.remote.version).toBe('0.0.1')
  })
})
