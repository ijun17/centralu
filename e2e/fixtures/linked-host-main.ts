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
import { storeMirror, storeRegistry } from '../../packages/agent-host/src/links/stored.js'
import { scriptedAdapters } from '../../packages/agent-host/src/links/scripted-agent.test-helpers.js'

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
  },
})

const token = values.token!
const store = new Store(values.db!)
const adapters = scriptedAdapters()
const mgr = new SessionManager(store, adapters, (e) => server.broadcast(e), () => null, join(dirname(values.db!), 'worktrees'))
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
const links = new Links({
  hub: { version: APP_VERSION, protocolVersion: PROTOCOL_VERSION, dev: true },
  broadcast: (e) => server.broadcast(e),
  terminal: (f) => server.pushTerminal(f),
  mirror: storeMirror(store),
  registry,
  tunnelFor: (record) => {
    const ssh = sshLinks.find((l) => l.id === record.id)
    if (ssh) return new SshTunnel({ target: ssh.target, remote: record.remote, configFile: ssh.configFile, log: (line) => console.error(line) })
    return new DirectTunnel(() => ({ v: 1, port: link!.port, token: link!.token, version: APP_VERSION, protocolVersion: PROTOCOL_VERSION, dataDir: '', hostRunning: true }))
  },
  log: (line) => console.error(line),
  retryMs: [300, 2000],
})
mgr.useLinkedSessions((id) => links.knowsSession(id))
const router = new Router({
  local: createRpcHandler(mgr, adapters, { terminals, commands, machines: links }),
  machines: () => links.all(),
})
const server: HostServer = new HostServer({
  port: Number(values.port),
  token,
  allowedOrigins: (process.env.CC_HOST_ALLOWED_ORIGINS ?? '').split(',').filter(Boolean),
  onRpc: router.handle,
})
up = true
const port = await server.listen()
links.start()
console.log(JSON.stringify({ ready: true, port }))

const stop = async () => {
  await links.stop()
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
