import { parseArgs } from 'node:util'
import { dirname, join } from 'node:path'
import { APP_VERSION, PROTOCOL_VERSION } from '@cc/protocol'
import { Store } from '../../packages/agent-host/src/dev-services/store.js'
import { SessionManager } from '../../packages/agent-host/src/sessions/manager.js'
import { createRpcHandler } from '../../packages/agent-host/src/rpc.js'
import { TerminalService } from '../../packages/agent-host/src/dev-services/terminal.js'
import { CommandRunner } from '../../packages/agent-host/src/dev-services/commands.js'
import { HostServer } from '../../packages/agent-host/src/transport/server.js'
import { Links } from '../../packages/agent-host/src/links/links.js'
import { Router } from '../../packages/agent-host/src/links/router.js'
import { DirectTunnel, SshTunnel, type RemoteSpec } from '../../packages/agent-host/src/links/tunnel.js'
import { storeMirror, storeProjectOrder, storeRegistry } from '../../packages/agent-host/src/links/stored.js'
import { scriptedAdapters } from '../../packages/agent-host/src/links/scripted-agent.test-helpers.js'
import { projectsHome } from '../../packages/agent-host/src/dev-services/project-folder.js'
import { linkedViews } from '../../packages/agent-host/src/links/linked-views.js'
import { ExternalApps } from '../../packages/agent-host/src/apps/external/runtime.js'
import { storeRunLedger } from '../../packages/agent-host/src/app-run-ledger.js'
import { runtimeViewSource } from '../../packages/agent-host/src/app-view-source.js'
import { onExternalAppListChanged } from '../../packages/agent-host/src/app-list-events.js'
import { ViewHost } from '../../packages/agent-host/src/views/view-host.js'
import { OriginPorts, type PortBook } from '../../packages/agent-host/src/views/origin-ports.js'
import { randomBytes } from 'node:crypto'

/**
 * A host for the linked-hosts e2e (#82): the real store, session manager, RPC handler, terminals,
 * server and router, composed as `main.ts` composes them, with a scripted agent instead of Claude
 * or Codex so no model is involved (`scripted-agent.test-helpers.ts`).
 *
 * `--link '{"id":"m1","name":"Remote","port":N,"token":"…"}'` links it to another such host,
 * reached directly on loopback: the transport is the one thing that differs from a real link, and
 * `tunnel.test.ts` covers ssh with a fake `ssh` on PATH.
 */

const { values } = parseArgs({
  options: {
    port: { type: 'string' },
    db: { type: 'string' },
    token: { type: 'string' },
    link: { type: 'string' },
    /** Real ssh links, for probe 3 (docs/plans/remote-hub.md §8): a JSON array */
    'ssh-links': { type: 'string' },
    /**
     * The version this hub says it runs, as a release (not a dev build), for the version prompt's e2e (#82): the hub
     * then compares versions with a machine instead of connecting whatever they are (plan §4)
     */
    'hub-version': { type: 'string' },
  },
})

const token = values.token!
const store = new Store(values.db!)
const adapters = scriptedAdapters()
const mgr = new SessionManager(store, adapters, (e) => server.broadcast(e), () => null, join(dirname(values.db!), 'worktrees'))
// A new project's ~/Centralu (#515) is the one in this host's temporary HOME, never the home of whoever runs the suite
mgr.useProjectsHome(() => projectsHome(process.platform, process.env.HOME!))
let up = false
const toScreens = (f: Parameters<HostServer['pushTerminal']>[0]) => {
  if (up) server.pushTerminal(f)
}
const terminals = new TerminalService(toScreens)
const commands = new CommandRunner(toScreens)

const link = values.link ? (JSON.parse(values.link) as { id: string; name: string; port: number; token: string }) : null
type SshLink = { id: string; name: string; target: string; remote?: RemoteSpec; configFile?: string }
const sshLinks = values['ssh-links'] ? (JSON.parse(values['ssh-links']) as SshLink[]) : []
// The hub's own store keeps the links, as `main.ts` does; a restart of this host finds them there
const registry = storeRegistry(store)
for (const r of [
  ...(link ? [{ id: link.id, name: link.name, sshTarget: 'direct', remote: { shell: 'posix' as const }, addedAt: Date.now(), acceptedVersions: null }] : []),
  ...sshLinks.map((l) => ({ id: l.id, name: l.name, sshTarget: l.target, remote: l.remote ?? { shell: 'posix' as const }, addedAt: Date.now(), acceptedVersions: null })),
]) {
  if (!registry.list().some((x) => x.id === r.id)) registry.add(r)
}
/**
 * A machine added through the UI (Settings → Machines) with the ssh target `direct:<port>` is reached straight on
 * loopback, the way `--link` is (#82): the manual endpoint the UI's e2e adds a machine with. `direct:<port>:protocol=<n>`
 * makes that host's connection line claim another protocol, for the refusal across protocols. The transport is the one
 * thing that differs from a real link; `tunnel.test.ts` covers ssh.
 */
function directEndpoint(target: string): { port: number; protocolVersion: number } | null {
  const m = /^direct:(\d+)(?::protocol=(\d+))?$/.exec(target)
  return m ? { port: Number(m[1]), protocolVersion: m[2] ? Number(m[2]) : PROTOCOL_VERSION } : null
}

const hubVersion = values['hub-version']
const links = new Links({
  hub: hubVersion ? { version: hubVersion, protocolVersion: PROTOCOL_VERSION, dev: false } : { version: APP_VERSION, protocolVersion: PROTOCOL_VERSION, dev: true },
  broadcast: (e) => server.broadcast(e),
  terminal: (f) => server.pushTerminal(f),
  mirror: storeMirror(store),
  registry,
  tunnelFor: (record) => {
    const ssh = sshLinks.find((l) => l.id === record.id)
    if (ssh) return new SshTunnel({ target: ssh.target, remote: record.remote, configFile: ssh.configFile, log: (line) => console.error(line) })
    const direct = directEndpoint(record.sshTarget)
    if (direct) {
      return new DirectTunnel(() => ({ v: 1, port: direct.port, token, version: APP_VERSION, protocolVersion: direct.protocolVersion, dataDir: '', hostRunning: true }))
    }
    // Any other machine added through the UI goes over the real ssh, as in `main.ts`; a manual run can name its own ssh config
    if (!link || record.id !== link.id) {
      return new SshTunnel({ target: record.sshTarget, remote: record.remote, configFile: process.env.CC_LINKED_SSH_CONFIG, log: (line) => console.error(line) })
    }
    return new DirectTunnel(() => ({ v: 1, port: link!.port, token: link!.token, version: APP_VERSION, protocolVersion: PROTOCOL_VERSION, dataDir: '', hostRunning: true }))
  },
  log: (line) => console.error(line),
  retryMs: [300, 2000],
})
mgr.useLinkedSessions((id) => links.knowsSession(id))
mgr.useLinkedApps({ linked: (id) => links.linked(id), projectMachine: (id) => links.projectMachine(id) })
const allowedOrigins = (process.env.CC_HOST_ALLOWED_ORIGINS ?? '').split(',').filter(Boolean)
/*
 * Apps and their views, composed as `main.ts` composes them (remote-hub.md §11): the real runtime (an app is a real
 * `node` process scaffolded from the template), the real ViewHost with its port book in this host's store, and, on a
 * hub, a linked machine's views served from here through `linkedViews`. Discovery only scans until an app is needed.
 */
const externalApps = new ExternalApps({
  projects: () => store.projectRoots(),
  dataRoot: process.env.CC_DATA_DIR!,
  reservedIds: [],
  runs: storeRunLedger(store),
  emitChanged: () => {},
  emitRunsChanged: () => {},
})
externalApps.refresh()
// An app's place or status changed: the window (and a hub linked here) reads the list again, as main.ts wires it
onExternalAppListChanged(externalApps, () => {
  if (up) server.broadcast({ type: 'external_apps_changed' })
})
mgr.useExternalApps(externalApps)
const httpSecret = randomBytes(32).toString('base64url')
let port = 0
const views: ViewHost = new ViewHost({
  secret: httpSecret,
  allowedOrigins,
  source: runtimeViewSource(externalApps),
  ports: new OriginPorts({
    load: () => {
      const raw = store.appSetting('apps.viewPorts')
      return raw ? (JSON.parse(raw) as PortBook) : null
    },
    save: (book) => store.setAppSetting('apps.viewPorts', JSON.stringify(book)),
  }),
  hostPort: () => port || null,
  remote: linkedViews((method, params) => router.handle(method, params)),
})
const router: Router = new Router({
  local: createRpcHandler(mgr, adapters, { terminals, commands, machines: links, externalApps, views }),
  machines: () => links.all(),
  // The project order across machines, kept in this host's store as main.ts keeps it (#734)
  order: storeProjectOrder(store),
})
const server: HostServer = new HostServer({
  port: Number(values.port),
  token,
  allowedOrigins,
  onRpc: router.handle,
  http: { secret: httpSecret, routes: views.routes },
})
up = true
port = await server.listen()
links.start()
console.log(JSON.stringify({ ready: true, port }))

const stop = async () => {
  await links.stop()
  await views.dispose()
  await externalApps.dispose()
  terminals.disposeAll()
  commands.disposeAll()
  await mgr.disposeAll()
  await server.close()
  store.close()
  process.exit(0)
}
process.on('unhandledRejection', (reason) => console.error('[linked-host] unhandled rejection', reason))
process.on('SIGTERM', () => void stop())
process.on('SIGINT', () => void stop())
