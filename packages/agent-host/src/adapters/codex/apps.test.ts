import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent, PermissionPreset } from '@cc/protocol'
import * as kit from '../../apps/external/test-helpers.js'
import { SessionAppsHub, type AppSessionKey } from '../../sessions/session-apps.js'
import { attachWorld, type AttachWorld } from '../../sessions/session-apps.test-helpers.js'
import type { CreateSessionOpts, OrchestratorTools, SessionHandle } from '../contract.js'
import { bridgePath } from './bridge-path.js'

/**
 * External apps attached to a Codex session (M4 A-5) — an stdio bridge per app, loaded when a
 * thread starts or resumes.
 *
 * The fake is a single app-server client: it records the requests we send (thread settings) and
 * simulates server requests (elicitation). The app side is the real runtime and real apps (tool
 * lists, annotations).
 *
 * **Codex's behavior was confirmed only from source and types** (we could not re-verify by
 * running it while logged out, plan S-3/S-7). What this test watches is "what we send Codex, and
 * how we answer what Codex sends."
 */

type Req = { method: string; params: Record<string, unknown> }
type Fake = {
  requests: Req[]
  responses: { id: number | string; payload: unknown }[]
  trigger(r: { id: number | string; method: string; params?: unknown }): void
  /** Simulates an app-server notification (item/started, etc.) */
  note(n: { method: string; params?: unknown }): void
}

const state = vi.hoisted(() => ({ instances: [] as Fake[] }))

vi.mock('./client.js', () => ({
  CodexClient: class {
    requests: Req[] = []
    responses: { id: number | string; payload: unknown }[] = []
    constructor(private handlers: { onServerRequest: (r: unknown) => void; onNotification: (n: unknown) => void }) {
      state.instances.push(this as unknown as Fake)
    }
    note(n: unknown) {
      this.handlers.onNotification(n)
    }
    request(method: string, params: Record<string, unknown> = {}) {
      this.requests.push({ method, params })
      if (method === 'thread/start') return Promise.resolve({ thread: { id: 'thread-1' } })
      if (method === 'thread/resume') return Promise.resolve({ thread: { id: params.threadId } })
      return Promise.resolve({})
    }
    notify() {}
    respond(id: number | string, payload: unknown) {
      this.responses.push({ id, payload })
    }
    trigger(r: unknown) {
      this.handlers.onServerRequest(r)
    }
    async dispose() {}
  },
}))

const { CodexAdapter } = await import('./index.js')

let w: AttachWorld
let hub: SessionAppsHub
let handle: SessionHandle | null = null
let events: NormalizedEvent[] = []

const BRIDGE = { url: 'ws://127.0.0.1:5999', token: 'tok-bridge' }
const WORKER: AppSessionKey = { id: 'codex-s1', kind: 'worker', projectId: 'p1' }
const ORCH: AppSessionKey = { id: 'codex-o1', kind: 'orchestrator', projectId: null }

async function start(key: AppSessionKey, over: Partial<CreateSessionOpts> = {}) {
  state.instances.length = 0
  events = []
  handle = await new CodexAdapter().createSession(
    // A project's app only attaches in a trusted project (decision 4) — matching what the manager passes, this session belongs to a trusted project
    { sessionId: key.id, cwd: '/tmp', permissionPreset: 'normal', projectTrusted: key.projectId !== null, apps: hub.attach(key), orchestratorBridge: BRIDGE, ...over },
    (e) => events.push(e),
  )
  return state.instances[0]!
}
const threadConfig = (c: Fake, method: 'thread/start' | 'thread/resume') =>
  c.requests.find((r) => r.method === method)!.params.config as Record<string, unknown>
const mcpServers = (c: Fake, method: 'thread/start' | 'thread/resume' = 'thread/start') =>
  (threadConfig(c, method).mcp_servers ?? null) as Record<string, Record<string, unknown>> | null

beforeEach(() => {
  w = attachWorld(kit)
  w.plant('p1', 'notes')
  w.plant('p1', 'tasks')
  w.plant('p2', 'other')
  w.plant('user', 'helper')
  w.rt.refresh()
  // So a call that never finds its match (B-1) is not waited on for too long — the product's own value is 5 seconds
  hub = new SessionAppsHub(w.rt, { toolListWaitMs: 10_000, callJoinWaitMs: 300 })
})

afterEach(async () => {
  await handle?.dispose()
  handle = null
  hub.dispose()
  await w.dispose()
})

describe('thread/start — one bridge per app', () => {
  it('a bridge is loaded for every attached app: an address back to the host, session/server names, and the tool ceiling', async () => {
    const c = await start(WORKER)
    const servers = mcpServers(c)!
    expect(Object.keys(servers).sort()).toEqual(['app-notes', 'app-tasks'])
    expect(servers['app-notes']).toMatchObject({
      command: process.execPath,
      args: [bridgePath()],
      env: { CC_HOST_URL: BRIDGE.url, CC_HOST_TOKEN: BRIDGE.token, CC_SESSION_ID: 'codex-s1', CC_APP_SERVER: 'app-notes' },
      tool_timeout_sec: 300,
    })
    // A long-running call is returned with a run id before Codex's own 300-second ceiling (at 240 seconds) — the bridge carries this value to the host
    expect((servers['app-notes']!.env as Record<string, string>).CC_APP_WAIT_MS).toBe('240000')
    // A worker in a trusted project — neither the orchestrator's bridge nor document blocking is present
    expect(servers).not.toHaveProperty('centralu')
    expect(threadConfig(c, 'thread/start')).not.toHaveProperty('project_doc_max_bytes')
  })

  it('a session with no attached app has no bridge at all — most sessions start no extra process', async () => {
    const c = await start({ id: 'codex-s2', kind: 'worker', projectId: 'p2' })
    expect(mcpServers(c)).toBeNull()
  })

  const modes: [PermissionPreset, string][] = [
    ['auto', 'approve'],
    ['normal', 'writes'],
    ['safe', 'prompt'],
  ]
  for (const [preset, mode] of modes) {
    it(`${preset} → default_tools_approval_mode ${mode}, a read-only tool is approve under any preset`, async () => {
      const c = await start(WORKER, { permissionPreset: preset })
      expect(mcpServers(c)!['app-notes']).toMatchObject({
        default_tools_approval_mode: mode,
        tools: { peek: { approval_mode: 'approve' } },
      })
      // A tool that is not read-only has no per-tool entry — it follows the preset's own mode. run_status is the host's own read-only tool
      expect(Object.keys(mcpServers(c)!['app-notes']!.tools as object).sort()).toEqual(['peek', 'run_status'])
    })
  }
})

describe('thread/resume — servers are loaded again on resume too', () => {
  it("the app bridge is loaded onto a worker's resume (an app attached while the thread was running gets attached here)", async () => {
    const c = await start(WORKER, { resumeExternalId: 'thread-9' })
    await (handle as unknown as { ready: Promise<void> }).ready
    expect(Object.keys(mcpServers(c, 'thread/resume')!).sort()).toEqual(['app-notes', 'app-tasks'])
    expect(mcpServers(c, 'thread/resume')!['app-notes']).toMatchObject({ default_tools_approval_mode: 'writes' })
  })

  // An approved MCP server arrives as a user-folder app (occupying the app-helper slot) — no server is ever loaded raw (A-7)
  it("the orchestrator's resume loads both the centralu bridge and the user-folder app's bridge, plus document blocking", async () => {
    const c = await start(ORCH, {
      resumeExternalId: 'thread-o',
      orchestratorTools: {} as OrchestratorTools,
      toolProfile: 'orchestrator',
    })
    await (handle as unknown as { ready: Promise<void> }).ready
    const config = threadConfig(c, 'thread/resume')
    expect(config.project_doc_max_bytes).toBe(0)
    expect(Object.keys(mcpServers(c, 'thread/resume')!).sort()).toEqual(['app-helper', 'centralu'])
    expect(mcpServers(c, 'thread/resume')!['centralu']).toMatchObject({
      command: process.execPath,
      args: [bridgePath()],
      env: { CC_HOST_URL: BRIDGE.url, CC_HOST_TOKEN: BRIDGE.token, CC_SESSION_ID: 'codex-o1' },
    })
  })
})

describe('which attached apps this thread can call (#308, appAttachment)', () => {
  it('an app loaded at thread start is attached; one attached after it needs a restart; a bridge Codex reports failed is failed until it is ready', async () => {
    const c = await start(WORKER)
    expect(handle!.appAttachment!('app-notes')).toBe('attached')
    // An app that appears while the thread runs: Codex does not take it in (apps.md §9.2)
    w.plant('p1', 'fresh')
    w.rt.refresh()
    await kit.until(() => hub.refsFor(WORKER).map((r) => r.server), (s) => s.includes('app-fresh'))
    expect(handle!.appAttachment!('app-fresh')).toBe('restart')

    c.note({ method: 'mcpServer/startupStatus/updated', params: { name: 'app-tasks', status: 'failed', error: 'bridge exited' } })
    expect(handle!.appAttachment!('app-tasks')).toBe('failed')
    c.note({ method: 'mcpServer/startupStatus/updated', params: { name: 'app-tasks', status: 'ready', error: null } })
    expect(handle!.appAttachment!('app-tasks')).toBe('attached')
  })
})

describe('elicitation — app tool approval goes to our card, everything else stays as before', () => {
  const approval = (id: number, serverName: string, meta: Record<string, unknown> = { codex_approval_kind: 'mcp_tool_call' }) => ({
    id,
    method: 'mcpServer/elicitation/request',
    params: {
      threadId: 'thread-1',
      turnId: null,
      serverName,
      mode: 'form',
      message: `Allow ${serverName} to run a tool?`,
      requestedSchema: { type: 'object', properties: {} },
      _meta: { tool_title: 'poke', tool_params: { to: 3 }, ...meta },
    },
  })

  it("an attached app's tool approval becomes a card, and the person's answer goes back as an elicitation response", async () => {
    const c = await start(WORKER)
    c.trigger(approval(21, 'app-notes'))
    // Does not answer automatically — waits for the person
    expect(c.responses).toEqual([])
    const card = events.find((e) => e.type === 'approval_request')
    expect(card).toMatchObject({
      type: 'approval_request',
      requestId: 'codex-req-1',
      detail: { kind: 'other', raw: 'app-notes · poke {"to":3}' },
    })

    expect(handle!.respondApproval('codex-req-1', 'allow')).toBe(true)
    expect(c.responses).toContainEqual({ id: 21, payload: { action: 'accept', content: null, _meta: null } })

    c.trigger(approval(22, 'app-notes'))
    handle!.respondApproval('codex-req-2', 'deny')
    expect(c.responses).toContainEqual({ id: 22, payload: { action: 'decline', content: null, _meta: null } })

    c.trigger(approval(23, 'app-tasks', { 'codex/approval_kind': 'mcp_tool_call' }))
    handle!.respondApproval('codex-req-3', 'always')
    expect(c.responses).toContainEqual({ id: 23, payload: { action: 'accept', content: null, _meta: { persist: 'session' } } })
  })

  it('still rejects an unknown server, an unattached app- server, and an elicitation that is not a tool approval', async () => {
    const c = await start(WORKER)
    const DECLINE = { action: 'decline', content: null, _meta: null }
    c.trigger(approval(31, 'playwright'))
    // Looks like an app by name, but is a server we did not load onto this thread (e.g. from the user's own config.toml)
    c.trigger(approval(32, 'app-other'))
    // Even for an attached app, an input form that is not a tool approval has no screen to draw
    c.trigger(approval(33, 'app-notes', { codex_approval_kind: 'something_else' }))
    expect(c.responses).toEqual([
      { id: 31, payload: DECLINE },
      { id: 32, payload: DECLINE },
      { id: 33, payload: DECLINE },
    ])
    expect(events.filter((e) => e.type === 'approval_request')).toEqual([])
  })

  it("accepts centralu's own elicitation as before (not conflated with an app)", async () => {
    const c = await start(ORCH, { orchestratorTools: {} as OrchestratorTools, toolProfile: 'orchestrator' })
    c.trigger({ id: 41, method: 'mcpServer/elicitation/request', params: { serverName: 'centralu' } })
    expect(c.responses).toContainEqual({ id: 41, payload: { action: 'accept', content: null, _meta: null } })
  })
})

/**
 * Stopping a session also stops an app call that came in through the bridge (M4 A-5) — **even
 * without a turn.** A call that already returned early past 240 seconds keeps running even after
 * the turn ends. The bridge does not make this decision, so the host's adapter cuts it off. A
 * bridge call comes in through the host's session gate (`forSession`) — this test calls through
 * that same gate too.
 */
describe('stopping a session also stops its app calls — Codex', () => {
  it('interrupt cancels this session\'s app calls even with no turn running', async () => {
    const c = await start(WORKER)
    const p = hub.forSession(WORKER.id).call('app-notes', 'hold', {})
    await kit.until(() => w.records('notes').some((r) => r.t === 'holding'), Boolean)
    handle!.interrupt()
    expect((await p).isError).toBe(true)
    await kit.until(() => w.records('notes').some((r) => r.t === 'aborted'), Boolean)
    // Nothing was sent to Codex since there was no turn — the host is what stopped it
    expect(c.requests.some((r) => r.method === 'turn/interrupt')).toBe(false)
  })

  it('dispose also cancels this session\'s app calls', async () => {
    await start(WORKER)
    const p = hub.forSession(WORKER.id).call('app-notes', 'hold', {})
    await kit.until(() => w.records('notes').some((r) => r.t === 'holding'), Boolean)
    await handle!.dispose()
    handle = null
    expect((await p).isError).toBe(true)
  })
})

/**
 * The card on the in-conversation screen (M4 B-1) — Codex. A call coming in through the bridge
 * does not know the card id. The `item/started` (mcpToolCall: id, server, tool, arguments) the
 * adapter observed is recorded by the attachment layer, and the bridge's call is matched against it.
 */
describe('the in-conversation screen card id — Codex', () => {
  const mcpItem = (id: string, server: string, tool: string, args: unknown, status = 'inProgress') => ({
    threadId: 'thread-1',
    item: { type: 'mcpToolCall', id, server, tool, arguments: args, status },
  })

  it("item/started's mcpToolCall becomes the card for the call that came in through the bridge", async () => {
    const ids: Promise<string | null>[] = []
    hub.onCall((c) => ids.push(c.callId))
    const c = await start(WORKER)
    c.note({ method: 'item/started', params: mcpItem('call_7', 'app-notes', 'poke', { to: 7 }) })
    await hub.forSession(WORKER.id).call('app-notes', 'poke', { to: 7 })
    expect(await ids[0]).toBe('call_7')
  })

  it('a card that has already ended does not get matched, and a call from an unattached server or another thread is not recorded', async () => {
    const ids: Promise<string | null>[] = []
    hub.dispose()
    hub = new SessionAppsHub(w.rt, { toolListWaitMs: 10_000, callJoinWaitMs: 150 })
    hub.onCall((c) => ids.push(c.callId))
    const c = await start(WORKER)
    // A call rejected at approval — starts and ends immediately
    c.note({ method: 'item/started', params: mcpItem('call_denied', 'app-notes', 'poke', { to: 8 }) })
    c.note({ method: 'item/completed', params: mcpItem('call_denied', 'app-notes', 'poke', { to: 8 }, 'failed') })
    // A call from a child thread, and a call from a server we did not load
    c.note({ method: 'item/started', params: { ...mcpItem('call_child', 'app-notes', 'poke', { to: 8 }), threadId: 'thread-child' } })
    c.note({ method: 'item/started', params: mcpItem('call_other', 'app-other', 'poke', { to: 8 }) })
    await hub.forSession(WORKER.id).call('app-notes', 'poke', { to: 8 })
    expect(await ids[0]).toBeNull()
  })
})
