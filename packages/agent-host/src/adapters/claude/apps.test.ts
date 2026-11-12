import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as kit from '../../apps/external/test-helpers.js'
import { SessionAppsHub, type AppSessionKey } from '../../sessions/session-apps.js'
import { attachWorld, type AttachWorld } from '../../sessions/session-apps.test-helpers.js'
import type { CreateSessionOpts, CentraluTools, SessionHandle } from '../contract.js'
import { REPO_WORK_FIRST } from '../../sessions/centralu-tools.js'

/**
 * A Claude session's apps (#2231): reached through Centralu's in-process server and its `app` tool, never a server per app.
 *
 * The only fake here is `query`: it never starts the CLI, and just records the options passed to the SDK. Centralu's server is
 * built with the **real** `createSdkMcpServer`, and the test stands in for the CLI, sending JSON-RPC directly — on the app
 * side, everything is a real runtime and a real app process (a fixture). So this checks, end to end, that "an `app` call
 * the CLI makes travels the runtime's one path, tagged as a session caller, and gets recorded."
 */

type Sent = { jsonrpc: '2.0'; id?: number; method?: string; result?: Record<string, unknown>; error?: unknown }

const captured = vi.hoisted(() => ({
  options: null as Record<string, unknown> | null,
  /** Messages the CLI would emit — the stream yields them once the test pushes them in (conversation-view matching, B-1). */
  feed: [] as unknown[],
  wake: null as (() => void) | null,
}))

vi.mock('@anthropic-ai/claude-agent-sdk', async (importActual) => ({
  ...(await importActual<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: (args: { options: Record<string, unknown> }) => {
    captured.options = args.options
    return {
      // Only yields messages the test pushed in, and waits quietly when there are none.
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const next = captured.feed.shift()
          if (next !== undefined) {
            yield next
            continue
          }
          await new Promise<void>((r) => (captured.wake = r))
        }
      },
      interrupt: async () => {},
      close: () => {},
      supportedCommands: async () => [],
      getContextUsage: async () => undefined,
    }
  },
}))

const { ClaudeAdapter } = await import('./index.js')

let w: AttachWorld
let hub: SessionAppsHub
let handle: SessionHandle | null = null

const WORKER: AppSessionKey = { id: 'claude-s1', kind: 'worker', projectId: 'p1' }
const servers = () => (captured.options?.mcpServers ?? {}) as Record<string, { type?: string; name?: string; instance?: unknown }>

/** Notices the last session raised */
let notices: string[] = []
/** The tool calls the last session put in its conversation, by id */
let toolCalls: string[] = []

async function start(key: AppSessionKey, over: Partial<CreateSessionOpts> = {}) {
  notices = []
  toolCalls = []
  // The bundle's one member the `app` tool reads: the session's live attachment, as SessionTools hands it (#2231)
  const centraluTools = { apps: () => hub.liveFor(key.id) } as unknown as CentraluTools
  handle = await new ClaudeAdapter().createSession(
    // A project's apps attach only in a trusted project (decision 4) — this session belongs to a trusted project, matching what the manager passes.
    { sessionId: key.id, cwd: '/tmp', permissionPreset: 'normal', projectTrusted: key.projectId !== null, apps: hub.attach(key), centraluTools, toolProfile: 'reader', ...over },
    (e) => {
      if (e.type === 'notice') notices.push(e.text)
      if (e.type === 'tool_call') toolCalls.push(e.callId)
    },
  )
  return handle
}

/** Attaches to Centralu's server the way the CLI would — exactly the transport shape the SDK's v1 server receives. */
async function connect(server = 'centralu') {
  const sent: Sent[] = []
  const pipe = {
    onmessage: undefined as ((m: unknown) => void) | undefined,
    onclose: undefined as (() => void) | undefined,
    onerror: undefined as ((e: Error) => void) | undefined,
    async start() {},
    async send(m: Sent) {
      sent.push(m)
    },
    async close() {},
  }
  const cfg = servers()[server] as { instance: { connect(t: unknown): Promise<void> } }
  await cfg.instance.connect(pipe)
  let id = 0
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const my = ++id
    pipe.onmessage!({ jsonrpc: '2.0', id: my, method, params })
    const res = await kit.until(() => sent.find((m) => m.id === my), (m) => m !== undefined, 15_000)
    if (res!.error) throw new Error(JSON.stringify(res!.error))
    return res!.result!
  }
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-cli', version: '0' } })
  pipe.onmessage!({ jsonrpc: '2.0', method: 'notifications/initialized' })
  return { request, sent }
}

beforeEach(() => {
  captured.options = null
  captured.feed = []
  captured.wake = null
  w = attachWorld(kit)
  w.plant('p1', 'notes')
  w.plant('p1', 'tasks')
  w.plant('user', 'helper')
  w.rt.refresh()
  // So an unmatched call (B-1) does not wait long — the product's own value is 5 seconds.
  hub = new SessionAppsHub(w.rt, { toolListWaitMs: 10_000, callJoinWaitMs: 300 })
})

afterEach(async () => {
  await handle?.dispose()
  handle = null
  hub.dispose()
  await w.dispose()
})

/** An `app` call as the CLI sends it to Centralu's server */
const appCall = (app: string, tool: string, args: Record<string, unknown> = {}, meta?: Record<string, unknown>) => ({
  name: 'app',
  arguments: { action: 'call', app, tool, args },
  ...(meta ? { _meta: meta } : {}),
})

describe("apps through Centralu's one server (#2231)", () => {
  it("loads Centralu's server alone, whatever apps the session has, and an ordinary worker still reads the user's own settings", async () => {
    await start(WORKER)
    expect(Object.keys(servers())).toEqual(['centralu'])
    const { request } = await connect()
    const { tools } = (await request('tools/list')) as { tools: { name: string }[] }
    expect(tools.map((t) => t.name)).toContain('app')
    // Only the Assistant turns off reading settings files — an app being attached (in a trusted project) never changes a worker's own settings load.
    expect(captured.options).not.toHaveProperty('settingSources')
  })

  it("lists the session's apps, and one app's tools with the read-only mark and the schema the app declared", async () => {
    await start(WORKER)
    const { request } = await connect()
    const apps = (await request('tools/call', { name: 'app', arguments: { action: 'list' } })) as { content: { text: string }[] }
    expect(apps.content[0]!.text).toMatch(/^- notes: /m)
    expect(apps.content[0]!.text).toMatch(/^- tasks: /m)
    const notes = (await request('tools/call', { name: 'app', arguments: { action: 'list', app: 'notes' } })) as { content: { text: string }[] }
    const text = notes.content[0]!.text
    expect(text).toContain('- peek (reads): "Reads the value without changing anything"')
    expect(text).toContain('"to":{"type":"number","description":"the new value"}')
    expect(text).not.toContain('app_only')
  })

  it("an app call travels the runtime's one path as a session caller and is recorded; the app's result comes back as the app gave it", async () => {
    await start(WORKER)
    const { request } = await connect()
    const out = await request('tools/call', appCall('notes', 'poke', { to: 7 }))
    expect(out).toMatchObject({ content: [{ type: 'text', text: 'poked 7' }], isError: false })
    const runs = w.rt.runs({ projectId: 'p1', appId: 'notes' })
    expect(runs.map((r) => [r.tool, r.callerKind, r.callerSessionId, r.status])).toEqual([['poke', 'session', 'claude-s1', 'ok']])
    // A UI-only tool is not one of the session's: refused, never run, naming the tools it has
    const refused = (await request('tools/call', appCall('notes', 'app_only'))) as { isError?: boolean; content: { text: string }[] }
    expect(refused.isError).toBe(true)
    expect(refused.content[0]!.text).toContain('notes has no tool "app_only"')
    // Refused by the runtime and kept as its row, as every refused call is
    expect(w.rt.runs({ projectId: 'p1', appId: 'notes' }).map((r) => `${r.tool} ${r.status}`)).toContain('app_only rejected')
    // The server name a session's earlier turns used reaches the same app
    expect(await request('tools/call', appCall('app-notes', 'poke', { to: 8 }))).toMatchObject({ content: [{ type: 'text', text: 'poked 8' }] })
  })
})

/**
 * The card in the conversation view (M4 B-1). Claude Code carries that tool use's id on an MCP
 * tool call (`_meta["claudecode/toolUseId"]`, confirmed in the installed CLI binary). That id is
 * the conversation's `tool_call` callId.
 */
describe('the conversation-view card id — Claude', () => {
  const heard = () => {
    const ids: Promise<string | null>[] = []
    hub.onCall((c) => ids.push(c.callId))
    return ids
  }

  it("the tool use id the CLI carries on the app call becomes that call's card id", async () => {
    const ids = heard()
    await start(WORKER)
    const { request } = await connect()
    await request('tools/call', appCall('notes', 'poke', { to: 1 }, { 'claudecode/toolUseId': 'toolu_01ABC', progressToken: 3 }))
    expect(ids).toHaveLength(1)
    expect(await ids[0]).toBe('toolu_01ABC')
  })

  it('matches against a tool_use from the stream when no id is carried along — a card that already has a result is not matched', async () => {
    const ids = heard()
    await start(WORKER)
    const { request } = await connect()
    const toolUse = (id: string, to: number) => ({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'mcp__centralu__app', input: { action: 'call', app: 'notes', tool: 'poke', args: { to } } }] },
    })
    // A call refused before it ran: its result arrives right after the tool_use.
    captured.feed.push(toolUse('toolu_denied', 2), {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_denied', is_error: true, content: 'denied' }] },
    })
    captured.feed.push(toolUse('toolu_ok', 2))
    captured.wake?.()
    // Waits until the session has shown the last tool use (#845): it notes a tool use for matching before it shows it
    await kit.until(() => toolCalls, (ids) => ids.includes('toolu_ok'))
    await request('tools/call', appCall('notes', 'poke', { to: 2 }))
    expect(await ids[0]).toBe('toolu_ok')
  })
})

// #957, #992 review: the line on repository work rides only where an app is attached as the session starts
describe("Centralu's instructions name an app's help only with an app attached", () => {
  const instructions = () => (servers()['centralu'] as unknown as { instance: { server: { _instructions?: string } } }).instance.server._instructions ?? ''
  it('an ordinary session that starts with apps gets the line; one that starts with none does not', async () => {
    await start(WORKER)
    expect(instructions()).toContain(REPO_WORK_FIRST)
    await handle?.dispose()
    // An untrusted project's apps do not attach (decision 4): this session starts with none
    w.trust.p1 = false
    w.rt.refresh()
    await start(WORKER)
    expect(Object.keys(servers())).toEqual(['centralu'])
    expect(instructions()).not.toContain(REPO_WORK_FIRST)
  })
})

/** The CLI's own call to Centralu's server, sent on the transport so the test can watch for its answer */
function sendRaw(id: number, params: Record<string, unknown>) {
  const pipe = (servers()['centralu'] as unknown as { instance: { server: { transport: { onmessage(m: unknown): void } } } }).instance.server.transport
  pipe.onmessage({ jsonrpc: '2.0', id, method: 'tools/call', params })
}

describe('a slow call — Claude waits', () => {
  it('still does not return early with "still running" even after 240 seconds — the result arrives when it finishes', async () => {
    await start(WORKER)
    const { request, sent } = await connect()
    await request('tools/list')
    const realSetTimeout = globalThis.setTimeout
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      sendRaw(900, appCall('notes', 'hold'))
      const deadline = performance.now() + 15_000
      while (!w.records('notes').some((r) => r.t === 'holding')) {
        if (performance.now() > deadline) throw new Error('the app never started holding')
        await new Promise((r) => realSetTimeout(r, 10))
      }
      // This outlasts the bridge's 240 seconds and Codex's 300 seconds. At 10 minutes, the runtime's own host-to-app boundary (callTimeoutMs) kicks in.
      await vi.advanceTimersByTimeAsync(6 * 60_000)
      expect(sent.find((m) => m.id === 900)).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
    const { writeFileSync } = await import('node:fs')
    writeFileSync(w.gate('notes'), '')
    const answer = await kit.until(() => sent.find((m) => m.id === 900), (m) => m !== undefined, 10_000)
    expect(answer!.result).toMatchObject({ content: [{ type: 'text', text: 'released' }], isError: false })
  })
})

/**
 * Stopping or closing a session stops that session's app calls (M4 A-5). The SDK makes no promise
 * about whether the CLI sends a cancellation to a tool call when it interrupts a turn — the fake
 * `query`'s `interrupt` does nothing at all, so if a call stops here, the adapter itself cut it
 * off directly.
 */
describe('stopping stops app calls too — Claude', () => {
  async function holdViaCli() {
    const { request, sent } = await connect()
    await request('tools/list')
    sendRaw(700, appCall('notes', 'hold'))
    await kit.until(() => w.records('notes').some((r) => r.t === 'holding'), Boolean)
    return sent
  }

  it('interrupt cancels an app call in progress — the app receives the cancellation, and the CLI sees a failure', async () => {
    const h = await start(WORKER)
    const sent = await holdViaCli()
    h.interrupt()
    const answer = await kit.until(() => sent.find((m) => m.id === 700), (m) => m !== undefined)
    expect(answer!.result).toMatchObject({ isError: true })
    await kit.until(() => w.records('notes').some((r) => r.t === 'aborted'), Boolean)
    expect(w.rt.runs({ projectId: 'p1', appId: 'notes' })[0]).toMatchObject({ tool: 'hold', status: 'cancelled' })
  })

  it('dispose also cancels an app call in progress', async () => {
    const h = await start(WORKER)
    await holdViaCli()
    await h.dispose()
    handle = null
    await kit.until(() => w.records('notes').some((r) => r.t === 'aborted'), Boolean)
  })
})
