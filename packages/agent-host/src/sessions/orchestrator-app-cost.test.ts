import type { ExternalAppInfo } from '@cc/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import type { AttachedApp } from '../adapters/contract.js'
import type { AppRef, ExternalApps } from '../apps/external/runtime.js'
import { AppAccess } from './app-access.js'
import { SessionAppsHub, type AppSessionKey } from './session-apps.js'
import { definitionChars, servedDefinitions, type ToolServingCapabilities } from './tool-cost.js'

/**
 * What the orchestrator's tool list costs as the person trusts more projects that are apps (#1205). Since #1141 every
 * trusted project's root app was its own MCP server in the orchestrator, so the list grew with each one, used or not.
 * The orchestrator now reaches them on demand (find_apps / attach_app, through centralu_run): the list is Centralu's
 * definitions, its user-folder apps, and what it attached itself, whatever the number of root apps.
 *
 * Each root app here is the one create_app makes (packages/agent-host/app-template/server.mjs): the agent sees `show`
 * and `increment` (`reset` is the screen's alone), and the host adds `run_status`. Counted as the model is sent them:
 * `mcp__<server>__<tool>` with its description and input schema (`definitionChars`, the same count as tool-cost.ts).
 * Claude defers app tools behind tool search (only their names ride along); Codex loads them.
 */

const TEMPLATE_TOOLS = [
  {
    name: 'show',
    title: 'Show the count',
    description: 'Open the screen and return the current count.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'increment',
    title: 'Increment',
    description: 'Add to the count (default 1) and return the new count.',
    inputSchema: { type: 'object', properties: { by: { type: 'integer', default: 1, description: 'How much to add' } } },
    annotations: { readOnlyHint: false },
  },
]

type FakeApp = Pick<ExternalAppInfo, 'appId' | 'projectId' | 'root' | 'status' | 'name' | 'description' | 'shared'>

/** Only what the hub and AppAccess read of the runtime: the list, the known tools, and its change signal */
function fakeRuntime(apps: FakeApp[]): ExternalApps {
  return {
    list: () => apps as ExternalAppInfo[],
    knownTools: (_ref: AppRef) => TEMPLATE_TOOLS,
    tools: async () => TEMPLATE_TOOLS,
    onAppsChanged: () => () => {},
  } as unknown as ExternalApps
}

const rootApp = (n: number, status: FakeApp['status'] = 'stopped'): FakeApp => ({
  appId: `app${n}`,
  projectId: `p${n}`,
  root: true,
  status,
  name: `App ${n}`,
  description: 'A counter',
})

const ORCH: AppSessionKey = { id: 'orc', kind: 'orchestrator', projectId: null }
const CLAUDE: ToolServingCapabilities = { toolDeferral: true, instructionChannel: 'server' }
const CODEX: ToolServingCapabilities = { toolDeferral: false, instructionChannel: 'developer' }

type World = { hub: SessionAppsHub; access: AppAccess; projects: { id: string; name: string; trusted: boolean }[] }
let worlds: World[] = []

/** A hub and AppAccess over `rootApps` trusted projects that are apps, plus `extra` apps as given */
function world(rootApps: number, extra: FakeApp[] = []): World {
  const apps = [...Array.from({ length: rootApps }, (_, i) => rootApp(i + 1)), ...extra]
  const projects = apps.filter((a) => a.projectId !== null).map((a) => ({ id: a.projectId!, name: `Project ${a.projectId}`, trusted: a.status !== 'untrusted' }))
  const settings = new Map<string, string>()
  const holder: { access?: AppAccess } = {}
  const hub = new SessionAppsHub(fakeRuntime(apps), {
    onDemand: { attached: (id) => holder.access?.attached(id) ?? [], allowed: (s, a) => holder.access?.allowed(s, a) ?? false },
  })
  const access = (holder.access = new AppAccess({
    hub,
    store: {
      settings: { appSetting: (k) => settings.get(k) ?? null, setAppSetting: (k, v) => void settings.set(k, v), deleteAppSetting: (k) => void settings.delete(k) },
      permissions: { getProjectConsent: () => null },
    },
    session: (id) => (id === ORCH.id ? ORCH : null),
    projects: () => projects,
    ensureAccess: async () => ({ ok: false, error: 'no card in this test' }),
    attachedChanged: (id) => {
      hub.sessionAppsChanged(id)
      return 'now'
    },
  }))
  const w = { hub, access, projects }
  worlds.push(w)
  return w
}

afterEach(() => {
  for (const w of worlds) {
    w.access.dispose()
    w.hub.dispose()
  }
  worlds = []
})

/** The orchestrator's whole tool list on one CLI: Centralu's definitions and every attached app's tools */
function cost(attached: AttachedApp[], capabilities: ToolServingCapabilities) {
  const centralu = servedDefinitions('orchestrator', capabilities)
  const appTools = attached.flatMap((a) => (a.tools ?? []).map((t) => ({ name: `mcp__${a.server}__${t.name}`, description: t.description ?? '', inputSchema: t.inputSchema })))
  const appChars = appTools.reduce((n, t) => n + definitionChars(t.name, t.description, t.inputSchema), 0)
  const deferredApps = capabilities.toolDeferral === true
  return {
    servers: 1 + attached.length,
    tools: centralu.length + appTools.length,
    // What rides in every request: Centralu's resident definitions, the app tools Codex loads, or their names alone on Claude
    chars: centralu.filter((d) => d.resident).reduce((n, d) => n + d.chars, 0) + (deferredApps ? appTools.reduce((n, t) => n + t.name.length, 0) : appChars),
  }
}

describe("the orchestrator's tool list as root apps are trusted (#1205)", () => {
  it('stays the same size with 0, 3 and 10 trusted root apps, on Claude and on Codex', () => {
    for (const capabilities of [CLAUDE, CODEX]) {
      const sizes = [0, 3, 10].map((n) => cost(world(n).hub.attach(ORCH).current(), capabilities))
      expect(sizes, capabilities.instructionChannel).toEqual([sizes[0], sizes[0], sizes[0]])
    }
  })

  it('keeps the user-folder apps attached as before: an MCP server the person approved for the orchestrator is one (A-7)', () => {
    const user: FakeApp = { appId: 'browser', projectId: null, status: 'stopped', name: 'Browser', description: 'An approved MCP server' }
    expect(world(10, [user]).hub.attach(ORCH).current().map((a) => a.server)).toEqual(['app-browser'])
  })

  it("reaches a trusted project's root app by finding and attaching it, under its stable app-<id> name, and only then pays for it", async () => {
    const { hub, access } = world(10)
    const live = hub.attach(ORCH)
    expect(live.current()).toEqual([])
    const found = access.find(ORCH.id, 'app3')
    expect(found.ok && found.apps.map((a) => a.ref)).toEqual(['Project p3/app3'])
    expect(await access.attach(ORCH.id, 'Project p3/app3')).toMatchObject({ ok: true, server: 'app-app3', tools: ['show', 'increment'], when: 'now' })
    expect(live.current().map((a) => a.server)).toEqual(['app-app3'])
    expect((await live.tools('app-app3')).map((t) => t.name)).toEqual(['show', 'increment', 'run_status'])
    expect(hub.reach(ORCH, { projectId: 'p3', appId: 'app3' })).toEqual({ reachable: true })
    // Detached, it costs nothing again, and the same name comes back when it is attached again
    expect(access.detach(ORCH.id, 'Project p3/app3')).toMatchObject({ ok: true, server: 'app-app3' })
    expect(live.current()).toEqual([])
    expect(await access.attach(ORCH.id, 'app3')).toMatchObject({ ok: true, server: 'app-app3' })
  })

  it("is refused an untrusted project's root app: not listed, not attached, not callable", async () => {
    const { hub, access } = world(2, [rootApp(9, 'untrusted')])
    const live = hub.attach(ORCH)
    const found = access.find(ORCH.id)
    expect(found.ok && found.apps.map((a) => a.ref)).toEqual(['Project p1/app1', 'Project p2/app2'])
    expect(await access.attach(ORCH.id, 'Project p9/app9')).toMatchObject({ ok: false, error: expect.stringContaining('not trusted') })
    expect(live.current()).toEqual([])
    expect((await live.call('app-app9', 'show', {})).isError).toBe(true)
    expect(hub.reach(ORCH, { projectId: 'p9', appId: 'app9' })).toMatchObject({ reachable: false, reason: 'untrusted' })
  })

  it("never offers the orchestrator a project's inner app, shared or not: its scope is the user folder and the root apps", () => {
    const inner: FakeApp = { appId: 'board', projectId: 'p1', status: 'stopped', shared: true, name: 'Board', description: '' }
    const { access } = world(1, [inner])
    const found = access.find(ORCH.id)
    expect(found.ok && found.apps.map((a) => a.ref)).toEqual(['Project p1/app1'])
  })
})
