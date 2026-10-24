import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APP_VERSION, PROTOCOL_VERSION, autoCompactOf, sessionLiveDefaults } from '@cc/protocol'
import { Store } from '../dev-services/store.js'
import { SessionManager } from '../sessions/manager.js'
import { createRpcHandler } from '../rpc.js'
import { HostServer } from '../transport/server.js'
import { Links } from './links.js'
import { Router } from './router.js'
import { DirectTunnel, type ConnectionLine } from './tunnel.js'
import { storeMirror, storeRegistry } from './stored.js'
import { scriptedAdapters } from './scripted-agent.test-helpers.js'
import { eventually } from '../../../../tooling/test-timing.js'

/**
 * When agents compact (#1376) on a linked machine. The person's setting lives on the hub, a machine starts and wakes its
 * own sessions from its own preferences, so the hub tells every machine its setting at connect and when it changes, and a
 * session's menu asks the machine what its next start passes. Real hosts in one process, as reverse-asks.test.ts has them.
 */
const TOKEN = 'tok'
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

function folder(): string {
  const d = mkdtempSync(join(tmpdir(), 'cc-compact-link-'))
  cleanups.push(() => rmSync(d, { recursive: true, force: true }))
  return d
}

const lineFor = (port: number): ConnectionLine => ({ v: 1, port, token: TOKEN, version: APP_VERSION, protocolVersion: PROTOCOL_VERSION, dataDir: '/remote', hostRunning: true })

function seedSession(store: Store) {
  store.sessions.upsertSession({
    id: 'w1', projectId: 'p-remote', kind: 'worker', tool: 'claude', externalId: 'ext-w1', name: 'w1', autoNamed: false, state: 'idle',
    lastReadSeq: 0, lastSeq: 0, createdAt: Date.now(), waitingSince: null, live: false, model: 'sonnet', effort: null, verbosity: null,
    serviceTier: null, permissionPreset: 'normal', importedFrom: null, worktree: null, parentSessionId: null, scopeSessionIds: null,
    roleAppend: null, appId: null, ...sessionLiveDefaults(),
  })
}

/** The machine, optionally as a build from before the setting answers it */
async function machineHost(o: { older?: boolean } = {}) {
  const store = new Store()
  store.projects.addProject({ id: 'p-remote', path: folder(), name: 'remote-project' })
  seedSession(store)
  const adapters = scriptedAdapters()
  const mgr = new SessionManager(store, adapters, (e) => server.broadcast(e))
  const handler = createRpcHandler(mgr, adapters)
  const onRpc: typeof handler = (method, ...rest) =>
    o.older && (method === 'agents.autoCompact' || method === 'prefs.set')
      ? method === 'prefs.set'
        ? Promise.resolve(mgr.uiPreferences())
        : Promise.reject(new Error(`Unknown method: ${method}. This Centralu host does not have it; the window may be from another build.`))
      : handler(method, ...rest)
  const server: HostServer = new HostServer({ port: 0, token: TOKEN, onRpc, build: { commit: 'abc1234', protocolVersion: PROTOCOL_VERSION, version: APP_VERSION } })
  const port = await server.listen()
  cleanups.push(async () => {
    await mgr.disposeAll()
    await server.close()
  })
  return { mgr, port }
}

async function hubHost(machinePort: number) {
  const store = new Store()
  const adapters = scriptedAdapters()
  const mgr = new SessionManager(store, adapters, (e) => server.broadcast(e))
  const registry = storeRegistry(store)
  registry.add({ id: 'm1', name: 'Remote box', sshTarget: 'box', remote: { shell: 'posix' }, addedAt: 1, acceptedVersions: null })
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
    autoCompact: () => autoCompactOf(mgr.uiPreferences()),
  })
  const router = new Router({ local: createRpcHandler(mgr, adapters, { machines: links }), machines: () => links.all() })
  const server: HostServer = new HostServer({ port: 0, token: TOKEN, onRpc: router.handle })
  await server.listen()
  mgr.setUiPreferences({ autoCompact: { share: 0.5 } })
  links.start()
  cleanups.push(async () => {
    await links.stop()
    await mgr.disposeAll()
    await server.close()
  })
  return { mgr, router, links, machine: () => links.list()[0]! }
}

describe('when agents compact on a linked machine (#1376)', () => {
  it("the hub's setting reaches the machine at connect, and again when the hub changes it", async () => {
    const machine = await machineHost()
    expect(machine.mgr.uiPreferences().autoCompact).toBeUndefined()
    const hub = await hubHost(machine.port)
    await eventually(() => hub.machine().status === 'connected')
    await eventually(() => machine.mgr.uiPreferences().autoCompact?.share === 0.5)
    expect(machine.mgr.uiPreferences().autoCompact).toEqual({ controlled: true, share: 0.5, idleShare: 0.3, nudge: true, nudgeFirst: 0.3, nudgeSecond: null })

    // The person turns Centralu's control off on the hub: the machine hands control back too
    await hub.router.handle('prefs.set', { patch: { autoCompact: { controlled: false } } })
    await eventually(() => machine.mgr.uiPreferences().autoCompact?.controlled === false)
    expect(machine.mgr.uiPreferences().autoCompact).toEqual({ controlled: false, share: 0.5, idleShare: 0.3, nudge: true, nudgeFirst: 0.3, nudgeSecond: null })

    // The notices' settings are the hub's too (#1492), also the one that follows the share
    await hub.router.handle('prefs.set', { patch: { autoCompact: { nudge: false, nudgeFirst: 0.4, nudgeSecond: 0.45 } } })
    await eventually(() => machine.mgr.uiPreferences().autoCompact?.nudgeFirst === 0.4)
    expect(machine.mgr.uiPreferences().autoCompact).toEqual({ controlled: false, share: 0.5, idleShare: 0.3, nudge: false, nudgeFirst: 0.4, nudgeSecond: 0.45 })
    await hub.router.handle('prefs.set', { patch: { autoCompact: { nudgeSecond: null } } })
    await eventually(() => machine.mgr.uiPreferences().autoCompact?.nudgeSecond === null)
  })

  it('a hub that lowers its share under a second reminder it chose before still gets the whole setting accepted by the machine (#1504 review)', async () => {
    const machine = await machineHost()
    const hub = await hubHost(machine.port)
    await eventually(() => hub.machine().status === 'connected')
    await hub.router.handle('prefs.set', { patch: { autoCompact: { nudgeFirst: 0.2, nudgeSecond: 0.45 } } })
    await eventually(() => machine.mgr.uiPreferences().autoCompact?.nudgeSecond === 0.45)
    // The share alone moves under the second one: the hub takes the second down with it, and the machine takes all of it
    await hub.router.handle('prefs.set', { patch: { autoCompact: { share: 0.4 } } })
    await eventually(() => machine.mgr.uiPreferences().autoCompact?.share === 0.4)
    expect(machine.mgr.uiPreferences().autoCompact).toEqual({ controlled: true, share: 0.4, idleShare: 0.3, nudge: true, nudgeFirst: 0.2, nudgeSecond: 0.35 })
    expect(hub.mgr.uiPreferences().autoCompact).toEqual(machine.mgr.uiPreferences().autoCompact)
  })

  it("a linked session's menu asks the machine what its next start passes", async () => {
    const machine = await machineHost()
    const hub = await hubHost(machine.port)
    await eventually(() => hub.machine().status === 'connected')
    await eventually(() => machine.mgr.uiPreferences().autoCompact?.share === 0.5)
    const answer = await hub.router.handle('agents.autoCompact', { sessionId: 'm1.w1' })
    // The machine has read no window of this model yet: it passes nothing, and says so
    expect(answer).toEqual({ controlled: true, share: 0.5, tokens: null })
  })

  it('a machine from before the setting answers "Unknown method" to the menu, which means it applies nothing', async () => {
    const machine = await machineHost({ older: true })
    const hub = await hubHost(machine.port)
    await eventually(() => hub.machine().status === 'connected')
    await expect(hub.router.handle('agents.autoCompact', { sessionId: 'm1.w1' })).rejects.toThrow('Unknown method: agents.autoCompact')
    expect(machine.mgr.uiPreferences().autoCompact).toBeUndefined()
  })
})
