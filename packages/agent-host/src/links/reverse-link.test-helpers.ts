import { APP_VERSION, PROTOCOL_VERSION, type HubMailParams, type SessionInfo } from '@cc/protocol'
import { Store } from '../dev-services/store.js'
import { SessionManager } from '../sessions/manager.js'
import { createRpcHandler } from '../rpc.js'
import { HostServer } from '../transport/server.js'
import { Links, type LinkDeps } from './links.js'
import { LinkedHubs } from './linked-hubs.js'
import { linkedSessions } from './linked-sessions.js'
import { reverseCalls } from './reverse-calls.js'
import { Router } from './router.js'
import { DirectTunnel } from './tunnel.js'
import { hubSelfId, storeMirror, storeRegistry } from './stored.js'
import { scriptedAdapters } from './scripted-agent.test-helpers.js'
import { TOKEN, cleanups, folder, lineFor, seedSession } from './links-world.test-helpers.js'
import { eventually } from '../../../../tooling/test-timing.js'
import { fixtureGit } from '../temp-dir.test-helpers.js'
import { mailFromMachine } from '../mail/from-machine.js'
import type { HostMail } from '../mail/host-mail.js'
import { wireHostMail } from '../sessions/host-mail.test-helpers.js'
import { startedFromHubKey } from '../sessions/hub-preset.js'
import { REMOTE_AGENTS_KEY, type RemoteAgent } from '../sessions/remote-agents.js'

/**
 * A linked machine and the hubs that link to it, for the reverse direction (#550: asks; #2067: mail). Real hosts in one
 * process, each with its own store, session manager, RPC handler and server, wired as main.ts wires them; only the
 * transport is loopback instead of ssh.
 */

/** An RPC handler without these methods, as a build from before them answers */
export function without(handler: ReturnType<typeof createRpcHandler>, methods: readonly string[]): ReturnType<typeof createRpcHandler> {
  return (method, ...rest) => {
    if (methods.includes(method)) return Promise.reject(new Error(`Unknown method: ${method}. This Centralu host does not have it; the window may be from another build.`))
    return handler(method, ...rest)
  }
}

/**
 * A project folder: an empty one, or with `origin` a git checkout of that repository with one commit, so start_agent
 * finds the same repository on the machine and a worktree can branch from it
 */
function projectFolder(origin?: string): string {
  const dir = folder()
  if (!origin) return dir
  fixtureGit(dir, ['init', '-q'])
  fixtureGit(dir, ['commit', '-q', '--allow-empty', '-m', 'first'])
  fixtureGit(dir, ['remote', 'add', 'origin', origin])
  return dir
}

/** The machine: a trusted project with an ordinary session (the caller), and the hubs that offer it the reverse direction */
/**
 * `fromHub`: sessions a hub started here (#1273's mark, read when the manager loads them); `mail`: this host's mail wired
 * (`wireHostMail`); `origin`: its project is a checkout of that repository (`projectFolder`), as the hub's may be
 */
export async function machineHost(o: { without?: readonly string[]; sessions?: readonly string[]; askTimeoutMs?: number; mailTimeoutMs?: number; fromHub?: readonly string[]; mail?: boolean; origin?: string } = {}) {
  const store = new Store()
  store.projects.addProject({ id: 'p-remote', path: projectFolder(o.origin), name: 'remote-project' })
  for (const id of o.sessions ?? ['w1']) seedSession(store, 'p-remote', id, 'worker', `ext-${id}`)
  for (const id of o.fromHub ?? []) store.settings.setAppSetting(startedFromHubKey(id), 'true')
  const adapters = scriptedAdapters()
  const mgr = new SessionManager(store, adapters, (e) => server.broadcast(e))
  const hubs = new LinkedHubs({ call: (client, method, params, opts) => server.call(client, method, params, opts), lookupMs: 2000, ...(o.askTimeoutMs ? { askTimeoutMs: o.askTimeoutMs } : {}), ...(o.mailTimeoutMs ? { mailTimeoutMs: o.mailTimeoutMs } : {}) })
  mgr.useLinkedHubs(hubs)
  const mail: HostMail | null = o.mail ? wireHostMail(mgr, store) : null
  const server: HostServer = new HostServer({
    port: 0,
    token: TOKEN,
    onRpc: without(createRpcHandler(mgr, adapters, { hubs }), o.without ?? []),
    onClientGone: (client) => hubs.gone(client),
    build: { commit: 'abc1234', protocolVersion: PROTOCOL_VERSION, version: APP_VERSION },
  })
  const port = await server.listen()
  await mgr.setProjectTrusted('p-remote', true)
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await mgr.tenure.disposeAll()
    await server.close()
  }
  cleanups.push(close)
  const ask = (opts: { project: string; session?: string; task?: string }, signal?: AbortSignal) => mgr.askProject('w1', opts, signal)
  return { store, mgr, server, hubs, port, close, ask, mail }
}

/** A hub linked to the machine as `m1` ("Remote box"), with a project and an ordinary session in it (the asked one) */
/**
 * `mail`: the hub's mail is wired (`wireHostMail`), and it takes mail from the sessions it started on the machine (#2067):
 * `true` as this build, `'before'` as a build from before `hub.mail` (asks only, no `mail` in its offer). `origin`: its
 * project is a checkout of that repository, so with the machine's of the same one start_agent can start a child there
 */
export async function hubHost(
  machinePort: number,
  o: { name?: string; reverse?: boolean; project?: string; preset?: SessionInfo['permissionPreset']; mail?: true | 'before'; children?: readonly RemoteAgent[]; origin?: string } = {},
) {
  const store = new Store()
  const projectName = o.project ?? 'hub-project'
  store.projects.addProject({ id: 'p-hub', path: projectFolder(o.origin), name: projectName })
  seedSession(store, 'p-hub', 'h1', 'worker', 'ext-h1', { permissionPreset: o.preset ?? 'normal' })
  // The children start_agent started on the machine, as the hub's record keeps them (read once, when the manager first asks)
  if (o.children) store.settings.setAppSetting(REMOTE_AGENTS_KEY, JSON.stringify(o.children))
  const adapters = scriptedAdapters()
  const mgr = new SessionManager(store, adapters, (e) => server.broadcast(e))
  const name = o.name ?? 'Hub mac'
  mgr.useHubName(() => name)
  const mail: HostMail | null = o.mail ? wireHostMail(mgr, store) : null
  // Every `hub.mail` this hub was sent, as it read it
  const heard: HubMailParams[] = []
  const fromMachine = mail && o.mail === true ? mailFromMachine({ service: mail.service, parentOf: (id) => mgr.linkedHost.remoteAgentParent(id), selfName: () => name }) : null
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
            ask: (machine, params, signal) => mgr.machineAsks.ask(machine, params, signal),
            selfName: () => name,
            ...(fromMachine ? { mail: (machine: { id: string; name: string }, p: HubMailParams) => (heard.push(p), fromMachine(machine, p)) } : {}),
          }),
          ...(o.mail === true ? { hubMail: true } : {}),
        }
  const links = new Links({
    hub: { version: APP_VERSION, protocolVersion: PROTOCOL_VERSION, dev: false },
    broadcast: (e) => {
      server.broadcast(e)
      mgr.linkedHost.observeLinked(e)
    },
    terminal: (f) => server.pushTerminal(f),
    mirror: storeMirror(store),
    registry,
    tunnelFor: () => new DirectTunnel(() => lineFor(machinePort)),
    retryMs: [50, 200],
    client: { maxBackoffMs: 100 },
    ...(o.origin ? { ownerOf: (sessionId: string) => mgr.linkedHost.remoteAgentParent(sessionId) } : {}),
    ...reverse,
  })
  const router = new Router({ local: createRpcHandler(mgr, adapters, { machines: links }), machines: () => links.all() })
  // With a checkout, its sessions start children on the machine (start_agent), as main.ts wires it
  if (o.origin) {
    mgr.layout.useLinkedSessions((id) => links.knowsSession(id))
    mgr.useLinkedReader(linkedSessions(() => links.all(), (method, params) => router.handle(method, params), name))
  }
  const server: HostServer = new HostServer({ port: 0, token: TOKEN, onRpc: router.handle })
  await server.listen()
  links.start()
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    await links.stop()
    await mgr.tenure.disposeAll()
    await server.close()
  }
  cleanups.push(stop)
  const card = () => mgr.listSessions().find((s) => s.id === 'h1')?.pendingApproval
  const answer = async (decision: 'allow' | 'deny') => {
    await eventually(() => !!card())
    const c = card()!
    mgr.inputs.respondApproval('h1', c.requestId, decision)
    await eventually(() => card()?.requestId !== c.requestId)
    return c
  }
  const machine = () => links.list()[0]!
  return { store, mgr, links, router, server, card, answer, machine, stop, name, id: hubSelfId(store), projectName, mail, heard }
}

/** A machine and a hub linked to it, connected, with the hub's switch for the machine on unless told otherwise */
export async function rig(o: { on?: boolean; sessions?: readonly string[]; askTimeoutMs?: number; preset?: SessionInfo['permissionPreset'] } = {}) {
  const machine = await machineHost({ sessions: o.sessions, askTimeoutMs: o.askTimeoutMs })
  const hub = await hubHost(machine.port, { preset: o.preset })
  await eventually(() => hub.machine().status === 'connected')
  if (o.on !== false) {
    await hub.router.handle('machines.setAsks', { machineId: 'm1', on: true })
    await eventually(() => machine.hubs.any)
  }
  return { machine, hub }
}
