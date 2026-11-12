import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent, PermissionPreset } from '@cc/protocol'
import * as kit from '../../apps/external/test-helpers.js'
import { SessionAppsHub, type AppSessionKey } from '../../sessions/session-apps.js'
import { attachWorld, type AttachWorld } from '../../sessions/session-apps.test-helpers.js'
import type { CreateSessionOpts, CentraluTools, SessionHandle } from '../contract.js'

/**
 * External apps of a Codex session (#2231): reached through Centralu's bridge and its `app` tool, never a bridge per app, so
 * an app that comes mid-thread needs no restart.
 *
 * The fake is a single app-server client: it records the requests we send (thread settings) and simulates server requests
 * (elicitation). The app side is the real runtime and real apps.
 */

type Req = { method: string; params: Record<string, unknown> }
type Fake = {
  requests: Req[]
  responses: { id: number | string; payload: unknown }[]
  trigger(r: { id: number | string; method: string; params?: unknown }): void
  /** Simulates an app-server notification (item/started, etc.) */
  note(n: { method: string; params?: unknown }): void
}

const state = vi.hoisted(() => ({
  instances: [] as Fake[],
  /** The policy the thread reports in its start and resume responses */
  threadPolicy: undefined as unknown,
}))

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
      if (method === 'thread/start') return Promise.resolve({ thread: { id: 'thread-1' }, approvalPolicy: state.threadPolicy })
      if (method === 'thread/resume') return Promise.resolve({ thread: { id: params.threadId }, approvalPolicy: state.threadPolicy })
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
    { sessionId: key.id, cwd: '/tmp', permissionPreset: 'normal', projectTrusted: key.projectId !== null, apps: hub.attach(key), centraluBridge: BRIDGE, ...over },
    (e) => events.push(e),
  )
  return state.instances[0]!
}
const threadConfig = (c: Fake, method: 'thread/start' | 'thread/resume') =>
  c.requests.find((r) => r.method === method)!.params.config as Record<string, unknown>
const mcpServers = (c: Fake, method: 'thread/start' | 'thread/resume' = 'thread/start') =>
  (threadConfig(c, method).mcp_servers ?? null) as Record<string, Record<string, unknown>> | null

beforeEach(() => {
  state.threadPolicy = undefined
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

const tools = { apps: () => null } as unknown as CentraluTools

describe("thread/start — Centralu's bridge alone, whatever apps the session has (#2231)", () => {
  it('a session with apps loads only the centralu bridge: the apps are reached through its app tool', async () => {
    const c = await start(WORKER, { centraluTools: tools, toolProfile: 'reader' })
    expect(Object.keys(mcpServers(c) ?? {})).toEqual(['centralu'])
    expect(mcpServers(c)!.centralu).toMatchObject({ default_tools_approval_mode: 'approve', tool_timeout_sec: 300 })
  })

  it('a session with neither tools nor a bridge loads no server, apps or not — most sessions start no extra process', async () => {
    const c = await start(WORKER)
    expect(mcpServers(c)).toBeNull()
  })

  it("the Assistant's resume loads the same single bridge, plus document blocking", async () => {
    const c = await start(ORCH, { centraluTools: tools, resumeExternalId: 'thread-old', noSettingFiles: true })
    expect(Object.keys(mcpServers(c, 'thread/resume') ?? {})).toEqual(['centralu'])
  })

  for (const preset of ['safe', 'normal', 'auto'] as PermissionPreset[]) {
    it(`Centralu's own tools are approved up front under ${preset}: Codex never asks about an app call itself`, async () => {
      const c = await start(WORKER, { centraluTools: tools, toolProfile: 'reader', permissionPreset: preset })
      expect(mcpServers(c)!.centralu!.default_tools_approval_mode).toBe('approve')
    })
  }
})

/**
 * The person's own bypass (#382, #2231): under `normal` and `edits` the thread runs under the person's own policy, and the
 * host asks about an app call unless that policy is `never`. Read from what the thread says it runs under.
 */
describe("whether the person's own Codex policy lets an app call run unasked", () => {
  it('normal and edits: only a thread that runs approval policy never, on start and on resume', async () => {
    state.threadPolicy = 'never'
    await start(WORKER, { centraluTools: tools })
    expect(handle!.bypassesApprovals?.()).toBe(true)
    await handle!.dispose()
    await start(WORKER, { centraluTools: tools, permissionPreset: 'edits', resumeExternalId: 'thread-old' })
    expect(handle!.bypassesApprovals?.()).toBe(true)
    await handle!.dispose()
    for (const policy of ['on-request', { granular: {} }, undefined]) {
      state.threadPolicy = policy
      await start(WORKER, { centraluTools: tools })
      expect(handle!.bypassesApprovals?.(), JSON.stringify(policy)).toBe(false)
      await handle!.dispose()
    }
    handle = null
  })

  it('safe and auto never read as the person\'s bypass: they set the thread policy themselves', async () => {
    state.threadPolicy = 'never'
    for (const preset of ['safe', 'auto'] as PermissionPreset[]) {
      await start(WORKER, { centraluTools: tools, permissionPreset: preset })
      expect(handle!.bypassesApprovals?.(), preset).toBe(false)
      await handle!.dispose()
    }
    handle = null
  })
})

describe('elicitation — only our own server is accepted; no app stands behind one any more', () => {
  const elicit = (serverName: string, meta: Record<string, unknown> = { codex_approval_kind: 'mcp_tool_call' }) => ({
    id: 'e1',
    method: 'mcpServer/elicitation/request',
    params: { threadId: 'thread-1', turnId: 'turn-1', serverName, message: 'Allow?', _meta: meta },
  })

  it("declines a tool approval for an app- server: one of those is the repository's or the person's, never ours", async () => {
    const c = await start(WORKER, { centraluTools: tools, toolProfile: 'reader' })
    c.trigger(elicit('app-notes'))
    expect(c.responses).toEqual([{ id: 'e1', payload: { action: 'decline', content: null, _meta: null } }])
    expect(events.some((e) => e.type === 'approval_request')).toBe(false)
  })

  it("accepts centralu's own elicitation as before", async () => {
    const c = await start(WORKER, { centraluTools: tools, toolProfile: 'reader' })
    c.trigger(elicit('centralu'))
    expect(c.responses).toEqual([{ id: 'e1', payload: { action: 'accept', content: null, _meta: null } }])
  })
})

/**
 * **Stopping cuts every app call this session made — even with no turn running.** A call that already returned early past
 * 240 seconds keeps running even after the turn ends. The bridge does not make this decision, so the host's adapter cuts
 * it off. An `app` call comes in through the session's live attachment (`liveFor`) — this test calls through that too.
 */
describe('stopping a session also stops its app calls — Codex', () => {
  it("interrupt cancels this session's app calls even with no turn running", async () => {
    const c = await start(WORKER)
    const p = hub.liveFor(WORKER.id)!.call('app-notes', 'hold', {})
    await kit.until(() => w.records('notes').some((r) => r.t === 'holding'), Boolean)
    handle!.interrupt()
    expect((await p).isError).toBe(true)
    await kit.until(() => w.records('notes').some((r) => r.t === 'aborted'), Boolean)
    // Nothing was sent to Codex since there was no turn — the host is what stopped it
    expect(c.requests.some((r) => r.method === 'turn/interrupt')).toBe(false)
  })

  it("dispose also cancels this session's app calls", async () => {
    await start(WORKER)
    const p = hub.liveFor(WORKER.id)!.call('app-notes', 'hold', {})
    await kit.until(() => w.records('notes').some((r) => r.t === 'holding'), Boolean)
    await handle!.dispose()
    handle = null
    expect((await p).isError).toBe(true)
  })
})

/**
 * The card on the in-conversation screen (M4 B-1) — Codex. A call coming in through the bridge does not know the card id.
 * The `item/started` of an `app` call (mcpToolCall on the centralu server, with the app, tool and arguments inside it) is
 * recorded by the attachment layer, and the bridge's call is matched against it.
 */
describe('the in-conversation screen card id — Codex', () => {
  const mcpItem = (id: string, server: string, args: unknown, status = 'inProgress') => ({
    threadId: 'thread-1',
    item: { type: 'mcpToolCall', id, server, tool: 'app', arguments: args, status },
  })
  const poke = (to: number, app = 'notes') => ({ action: 'call', app, tool: 'poke', args: { to } })

  it("item/started's app call becomes the card for the call that came in through the bridge", async () => {
    const ids: Promise<string | null>[] = []
    hub.onCall((c) => ids.push(c.callId))
    const c = await start(WORKER)
    c.note({ method: 'item/started', params: mcpItem('call_7', 'centralu', poke(7)) })
    await hub.liveFor(WORKER.id)!.call('app-notes', 'poke', { to: 7 })
    expect(await ids[0]).toBe('call_7')
  })

  it('a card that has already ended does not get matched, and a call to another server, an app the session lacks, or another thread is not recorded', async () => {
    const ids: Promise<string | null>[] = []
    hub.dispose()
    hub = new SessionAppsHub(w.rt, { toolListWaitMs: 10_000, callJoinWaitMs: 150 })
    hub.onCall((c) => ids.push(c.callId))
    const c = await start(WORKER)
    // A call refused before it ran — starts and ends immediately
    c.note({ method: 'item/started', params: mcpItem('call_denied', 'centralu', poke(8)) })
    c.note({ method: 'item/completed', params: mcpItem('call_denied', 'centralu', poke(8), 'failed') })
    // A call from a child thread, one to a server of the same tool name that is not ours, and one naming an app this session lacks
    c.note({ method: 'item/started', params: { ...mcpItem('call_child', 'centralu', poke(8)), threadId: 'thread-child' } })
    c.note({ method: 'item/started', params: mcpItem('call_other', 'elsewhere', poke(8)) })
    c.note({ method: 'item/started', params: mcpItem('call_missing', 'centralu', poke(8, 'other')) })
    await hub.liveFor(WORKER.id)!.call('app-notes', 'poke', { to: 8 })
    expect(await ids[0]).toBeNull()
  })
})
