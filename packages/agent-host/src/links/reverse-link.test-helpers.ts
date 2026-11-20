import { APP_VERSION, PROTOCOL_VERSION, type HubMailParams, type LinkedAppNoticeParams, type SessionInfo } from '@cc/protocol'
import type { AgentAdapter } from '../adapters/contract.js'
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
import { hubSelfId, storeMirror, storeProjectDeletes, storeRegistry } from './stored.js'
import { ScriptedAdapter, scriptedAdapters } from './scripted-agent.test-helpers.js'
import { TOKEN, cleanups, folder, lineFor, seedSession } from './links-world.test-helpers.js'
import { eventually } from '../../../../tooling/test-timing.js'
import { fixtureGit, namedFolder } from '../temp-dir.test-helpers.js'
import { mailPeers } from './mail-peers.js'
import type { HostMail } from '../mail/host-mail.js'
import { MailPerson, personSessions } from '../mail/person.js'
import { wireHostMail } from '../sessions/host-mail.test-helpers.js'
import { recordStartingHub, startedFromHubKey } from '../sessions/hub-preset.js'
import { REMOTE_AGENTS_KEY, type RemoteAgent } from '../sessions/remote-agents.js'
import { appsPeers, hubAppCalls, linkedNotices, machineAppCalls } from './apps-across.js'
import { memoryUpdateFolder } from '../lifecycle/update-resume.test-helpers.js'
import { hostApps } from './apps-across.test-helpers.js'

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

/** `mail: 'delivered'`: the host delivers its mail as main.ts starts it, on real timers, rather than when a test asks (`MailDelivery.process`) */
const LIVE = { schedule: (ms: number, fn: () => void) => {
  const t = setTimeout(fn, ms)
  return () => clearTimeout(t)
} }
function delivering(mail: HostMail, live: boolean): HostMail {
  if (live) {
    mail.delivery.start()
    cleanups.push(() => mail.delivery.stop())
  }
  return mail
}

/** The person's side of a host's mailbox (`mail.*` of the window), as main.ts wires it, for a host whose sessions run no turn */
function personOf(mgr: SessionManager, mail: HostMail): MailPerson {
  return new MailPerson(mail.service, mail.records, mail.delivery, {
    session: personSessions((id) => {
      const s = mgr.sessionInfo(id)
      return s ? { name: s.name, state: s.state } : undefined
    }, mail),
    projectLabel: (p) => mail.reach.projectLabel(p),
    untrusted: (p) => mail.reach.untrusted(p),
    turnOn: () => undefined,
    tellsNow: () => false,
    tell: async () => undefined,
    across: mail.across,
  })
}

/**
 * A project folder named `name`: an empty one, or with `origin` a git checkout of that repository with one commit, so start_agent
 * finds the same repository on the machine and a worktree can branch from it. Named, not the temp folder's random name: a machine
 * lists its projects to the hub by their folder's name, and a `find` matches words against it (#2261)
 */
function projectFolder(name: string, origin?: string): string {
  const dir = namedFolder(folder(), name)
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
/** `apps`: an app runtime wired as main.ts wires it (#1938); `'before'`, as a build from before `host.apps` (its offer's answer says nothing of apps) */
export async function machineHost(
  o: { without?: readonly string[]; sessions?: readonly string[]; askTimeoutMs?: number; askHoldMaxMs?: number; mailTimeoutMs?: number; fromHub?: readonly string[]; mail?: boolean | 'delivered'; origin?: string; apps?: true | 'before'; claude?: () => AgentAdapter } = {},
) {
  const store = new Store()
  store.projects.addProject({ id: 'p-remote', path: projectFolder('remote-project', o.origin), name: 'remote-project' })
  for (const id of o.sessions ?? ['w1']) seedSession(store, 'p-remote', id, 'worker', `ext-${id}`)
  for (const id of o.fromHub ?? []) store.settings.setAppSetting(startedFromHubKey(id), 'true')
  const id = hubSelfId(store)
  /** The machine's data folder's lists of the turns an update cut (#1618), which each host there reads and writes */
  const updateResume = memoryUpdateFolder()
  /** One host on the machine's store, wired as main.ts wires it: the first, and each one an update swaps in (`swapForUpdate`) */
  const boot = () => {
    // `claude`: Claude Code's sessions run in this adapter (the real one over a fake CLI, #2318) rather than the scripted agent
    const adapters = scriptedAdapters()
    if (o.claude) adapters.set('claude', o.claude())
    const mgr = new SessionManager(store, adapters, (e) => server.broadcast(e), undefined, { updateResume })
    const hubs = new LinkedHubs({
      call: (client, method, params, opts) => server.call(client, method, params, opts),
      lookupMs: 2000,
      record: (sessionId, hub) => recordStartingHub(store.settings, sessionId, hub),
      settings: store.settings,
      ...(o.askTimeoutMs ? { askTimeoutMs: o.askTimeoutMs } : {}),
      ...(o.askHoldMaxMs ? { askHoldMaxMs: o.askHoldMaxMs } : {}),
      ...(o.mailTimeoutMs ? { mailTimeoutMs: o.mailTimeoutMs } : {}),
    })
    mgr.useLinkedHubs(hubs)
    const mail: HostMail | null = o.mail ? delivering(wireHostMail(mgr, store, { hostId: id, ...(o.mail === 'delivered' ? { delivery: LIVE } : {}) }), o.mail === 'delivered') : null
    mail?.across.usePeers(mailPeers({ hostId: id, selfName: () => 'Remote box', hubs, settings: store.settings }))
    const apps = o.apps ? hostApps(store, mgr) : null
    apps?.linked.usePeers(appsPeers({ hubs, settings: store.settings }))
    if (apps) mgr.apps.useLinkedNotices(linkedNotices({ hubs }))
    const appsAcross =
      apps && o.apps === true ? { appsAcross: { calls: machineAppCalls(apps.rt, { projectName: apps.projectName }), notice: (hub: { id: string }, p: LinkedAppNoticeParams) => mgr.apps.linkedNoticeIn(hub.id, p) } } : {}
    const handler = without(createRpcHandler(mgr, adapters, { hubs, ...(mail ? { mailAcross: mail.across, mail: personOf(mgr, mail) } : {}), ...appsAcross }), o.without ?? [])
    return { adapters, mgr, hubs, mail, apps, handler }
  }
  let host = boot()
  /** What its answer to a hub's offer waits for, when a test holds it (`holdOffer`) */
  let held: Promise<void> | undefined
  /** What its answers to other methods wait for, when a test holds them (`holdMethod`) */
  const heldMethods = new Map<string, Promise<void>>()
  const serve = (port: number) =>
    new HostServer({
      port,
      token: TOKEN,
      onRpc: (method, ...rest) => {
        const wait = method === 'host.hubOffer' ? held : heldMethods.get(method)
        return wait ? wait.then(() => host.handler(method, ...rest)) : host.handler(method, ...rest)
      },
      onClientGone: (client) => host.hubs.gone(client),
      build: { commit: 'abc1234', protocolVersion: PROTOCOL_VERSION, version: APP_VERSION },
    })
  let server: HostServer = serve(0)
  const port = await server.listen()
  await host.mgr.setProjectTrusted('p-remote', true)
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await host.mgr.tenure.disposeAll()
    await server.close()
  }
  cleanups.push(close)
  const ask = (opts: { project: string; session?: string; task?: string }, signal?: AbortSignal) => host.mgr.askProject('w1', opts, signal)
  /** Its answers to a hub's offers from now on wait for `until` */
  const holdOffer = (until: Promise<void>) => void (held = until)
  /** Its answers to `method` from now on wait for `until` */
  const holdMethod = (method: string, until: Promise<void>) => void heldMethods.set(method, until)
  /** Its host goes away and comes back on the same port, as one swapped in place does; `until`: its answers to offers wait for it */
  const bounce = async (until?: Promise<void>) => {
    await server.close()
    held = until
    server = serve(port)
    await server.listen()
  }
  /**
   * A linked hub's update swaps its host (#1618): this one stops for the update, listing the turns it cuts, and a new host on the same store and
   * data folder comes up on the same port and continues them, as the machine's next host does
   */
  const swapForUpdate = async () => {
    host.mgr.tenure.stopForUpdate()
    await host.mgr.tenure.disposeAll()
    host.mail?.delivery.stop()
    await server.close()
    host = boot()
    server = serve(port)
    await server.listen()
  }
  /** The scripted agent of the current host (`ScriptedAdapter`), by tool */
  const agent = (tool: 'claude' | 'codex' = 'claude') => host.adapters.get(tool) as ScriptedAdapter
  return {
    store,
    get mgr() { return host.mgr },
    get server() { return server },
    get hubs() { return host.hubs },
    port,
    close,
    ask,
    get mail() { return host.mail },
    id,
    get apps() { return host.apps },
    bounce,
    holdOffer,
    holdMethod,
    swapForUpdate,
    agent,
  }
}

/** A hub linked to the machine as `m1` ("Remote box"), with a project and an ordinary session in it (the asked one) */
/**
 * `mail`: the hub's mail is wired (`wireHostMail`), and it takes mail from the sessions it started on the machine (#2067):
 * `true` as this build, `'before'` as a build from before `hub.mail` (asks only, no `mail` in its offer). `origin`: its
 * project is a checkout of that repository, so with the machine's of the same one start_agent can start a child there.
 * `store`: the store of a hub that ran before, for one started again on it: its project, session and machine are there already
 */
export async function hubHost(
  machinePort: number,
  o: { name?: string; reverse?: boolean; project?: string; preset?: SessionInfo['permissionPreset']; mail?: true | 'before' | 'delivered'; children?: readonly RemoteAgent[]; origin?: string; apps?: true; deps?: Partial<LinkDeps>; store?: Store } = {},
) {
  const store = o.store ?? new Store()
  const projectName = o.project ?? 'hub-project'
  if (!o.store) {
    store.projects.addProject({ id: 'p-hub', path: projectFolder(projectName, o.origin), name: projectName })
    seedSession(store, 'p-hub', 'h1', 'worker', 'ext-h1', { permissionPreset: o.preset ?? 'normal' })
  }
  // The children start_agent started on the machine, as the hub's record keeps them (read once, when the manager first asks)
  if (o.children) store.settings.setAppSetting(REMOTE_AGENTS_KEY, JSON.stringify(o.children))
  const adapters = scriptedAdapters()
  const mgr = new SessionManager(store, adapters, (e) => server.broadcast(e))
  const name = o.name ?? 'Hub mac'
  mgr.useHubName(() => name)
  const mail: HostMail | null = o.mail ? delivering(wireHostMail(mgr, store, { hostId: hubSelfId(store), ...(o.mail === 'delivered' ? { delivery: LIVE } : {}) }), o.mail === 'delivered') : null
  // Every `hub.mail` this hub was sent, as it read it
  const heard: HubMailParams[] = []
  const across = mail && o.mail !== 'before' ? mail.across : null
  // A project's app used from another machine (#1938), as main.ts wires it
  const apps = o.apps ? hostApps(store, mgr) : null
  const registry = storeRegistry(store)
  if (!o.store) registry.add({ id: 'm1', name: 'Remote box', sshTarget: 'box', remote: { shell: 'posix' }, addedAt: 1, acceptedVersions: null })
  const reverse: Partial<LinkDeps> =
    o.reverse === false
      ? {}
      : {
          hubSelf: () => ({ id: hubSelfId(store), name }),
          reverse: reverseCalls({
            allowed: (id) => store.machines.linkedMachineAsks(id),
            projects: () => mgr.projectsForMachines(),
            ask: (machine, params, signal, hold) => mgr.machineAsks.ask(machine, params, signal, hold),
            selfName: () => name,
            ...(across
              ? {
                  across: {
                    fromMachine: (machine: { id: string; name: string }, p: HubMailParams) => (heard.push(p), across.fromMachine(machine, p)),
                    rows: across.rows.bind(across),
                    answerFind: across.answerFind.bind(across),
                  },
                }
              : {}),
            ...(apps
              ? {
                  apps: {
                    calls: hubAppCalls(apps.rt, {
                      selfName: () => name,
                      parentProject: (id) => {
                        const parent = mgr.linkedHost.remoteAgentParent(id)
                        return parent ? mgr.sessionProject(parent) : null
                      },
                      projectName: apps.projectName,
                    }),
                    notice: (machine: { id: string }, p: LinkedAppNoticeParams) => mgr.apps.linkedNoticeIn(machine.id, p),
                  },
                }
              : {}),
          }),
          ...(across ? { hubMail: true } : {}),
          ...(apps ? { hubApps: true } : {}),
          ...(across ? { onOfferAnswered: (id: string, lacks: readonly string[]) => across.offerAnswered(id, lacks), openTasks: (id: string) => across.openTasksTo(id) } : {}),
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
    projectDeletes: storeProjectDeletes(store),
    tellPerson: () => {},
    tunnelFor: () => new DirectTunnel(() => lineFor(machinePort)),
    retryMs: [50, 200],
    client: { maxBackoffMs: 100 },
    ...(o.origin ? { ownerOf: (sessionId: string) => mgr.linkedHost.remoteAgentParent(sessionId) } : {}),
    ...reverse,
    ...o.deps,
  })
  const router = new Router({ local: createRpcHandler(mgr, adapters, { machines: links, ...(mail ? { mail: personOf(mgr, mail) } : {}) }), machines: () => links.all() })
  apps?.linked.usePeers(appsPeers({ machines: links }))
  if (apps) mgr.apps.useLinkedNotices(linkedNotices({ machines: links }))
  // Mail across linked machines (#2067 items 2 and 3), as main.ts wires it
  across?.usePeers(mailPeers({ hostId: hubSelfId(store), selfName: () => name, machines: links, parentOf: (id) => mgr.linkedHost.remoteAgentParent(id) }))
  // Unknown until the machine answers this connection's offer, as main.ts passes it
  if (across) mgr.useMachineTasks((id) => links.get(id)?.takesTasks)
  // With a checkout, its sessions start children on the machine (start_agent), as main.ts wires it
  if (o.origin) {
    mgr.layout.useLinkedSessions((id) => links.knowsSession(id))
    mgr.useLinkedReader(linkedSessions(() => links.all(), (method, params) => router.handle(method, params)))
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
  /** Ends a hub session's long job (a message with "long job" started it) */
  const finish = (sessionId: string, text: string) => {
    for (const a of adapters.values()) if (a instanceof ScriptedAdapter && a.tool === mgr.listSessions().find((s) => s.id === sessionId)?.tool) a.finish(sessionId, text)
  }
  return { store, mgr, links, router, server, card, answer, finish, machine, stop, name, id: hubSelfId(store), projectName, mail, heard, apps }
}

/** A machine and a hub linked to it, connected, with the hub's switch for the machine on unless told otherwise; the hub delivers its mail, the asks' tasks */
export async function rig(o: { on?: boolean; sessions?: readonly string[]; askTimeoutMs?: number; askHoldMaxMs?: number; preset?: SessionInfo['permissionPreset'] } = {}) {
  const machine = await machineHost({ sessions: o.sessions, askTimeoutMs: o.askTimeoutMs, askHoldMaxMs: o.askHoldMaxMs })
  const hub = await hubHost(machine.port, { preset: o.preset, mail: 'delivered' })
  await eventually(() => hub.machine().status === 'connected')
  if (o.on !== false) {
    await hub.router.handle('machines.setAsks', { machineId: 'm1', on: true })
    await eventually(() => machine.hubs.any)
  }
  return { machine, hub }
}
