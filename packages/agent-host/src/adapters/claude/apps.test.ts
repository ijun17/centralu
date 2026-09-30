import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as kit from '../../apps/external/test-helpers.js'
import { SessionAppsHub, type AppSessionKey } from '../../sessions/session-apps.js'
import { attachWorld, type AttachWorld } from '../../sessions/session-apps.test-helpers.js'
import type { CreateSessionOpts, OrchestratorTools, SessionHandle } from '../contract.js'

/**
 * An external app attached to a Claude session (M4 A-5) — one in-process proxy server per app.
 *
 * The only fake here is `query`: it never starts the CLI, and just records the options passed to
 * the SDK and any `setMcpServers` calls. The proxy server is built with the **real**
 * `createSdkMcpServer`, and the test stands in for the CLI, sending JSON-RPC directly — on the
 * app side, everything is a real runtime and a real app process (a fixture). So this checks, end
 * to end, that "a tool the CLI calls travels the runtime's one path, tagged as a session caller,
 * and gets recorded."
 */

type Sent = { jsonrpc: '2.0'; id?: number; method?: string; result?: Record<string, unknown>; error?: unknown }

const captured = vi.hoisted(() => ({
  options: null as Record<string, unknown> | null,
  setCalls: [] as Record<string, unknown>[],
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
      setMcpServers: async (servers: Record<string, unknown>) => {
        captured.setCalls.push(servers)
        return { added: [], removed: [], errors: {} }
      },
    }
  },
}))

const { ClaudeAdapter } = await import('./index.js')

let w: AttachWorld
let hub: SessionAppsHub
let handle: SessionHandle | null = null

const WORKER: AppSessionKey = { id: 'claude-s1', kind: 'worker', projectId: 'p1' }
const servers = () => (captured.options?.mcpServers ?? {}) as Record<string, { type?: string; name?: string; instance?: unknown }>

async function start(key: AppSessionKey, over: Partial<CreateSessionOpts> = {}) {
  handle = await new ClaudeAdapter().createSession(
    // A project's apps attach only in a trusted project (decision 4) — this session belongs to a trusted project, matching what the manager passes.
    { sessionId: key.id, cwd: '/tmp', permissionPreset: 'normal', projectTrusted: key.projectId !== null, apps: hub.attach(key), ...over },
    () => {},
  )
  return handle
}

/** Attaches to the proxy server the way the CLI would — exactly the transport shape the SDK's v1 server receives. */
async function connect(server: string) {
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
  captured.setCalls = []
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

describe('one in-process proxy server per app', () => {
  it('an app-<id> server is loaded per attached app, and an ordinary worker still reads the user\'s own settings', async () => {
    await start(WORKER)
    expect(Object.keys(servers()).sort()).toEqual(['app-notes', 'app-tasks'])
    expect(servers()['app-notes']).toMatchObject({ type: 'sdk', name: 'app-notes' })
    // Only the orchestrator turns off reading settings files — an app being attached (in a trusted project) never changes a worker's own settings load.
    expect(captured.options).not.toHaveProperty('settingSources')
  })

  it('the CLI\'s tools/list receives only the agent-facing tools — with description, annotations and schema exactly as the app declared them', async () => {
    await start(WORKER)
    const { request } = await connect('app-notes')
    const { tools } = (await request('tools/list')) as { tools: Record<string, unknown>[] }
    const names = tools.map((t) => t.name)
    expect(names).not.toContain('app_only')
    expect(names).toEqual(expect.arrayContaining(['echo', 'peek', 'poke']))
    expect(tools.find((t) => t.name === 'peek')).toMatchObject({
      title: 'Peek',
      description: 'Reads the value without changing anything',
      annotations: { readOnlyHint: true, openWorldHint: false },
    })
    expect(tools.find((t) => t.name === 'poke')?.inputSchema).toMatchObject({
      type: 'object',
      properties: { to: { type: 'number', description: 'the new value' } },
      required: ['to'],
    })
  })

  it('the CLI\'s tools/call travels the runtime\'s one path, tagged as a session caller, and gets recorded', async () => {
    await start(WORKER)
    const { request } = await connect('app-notes')
    const out = await request('tools/call', { name: 'poke', arguments: { to: 7 } })
    expect(out).toMatchObject({ content: [{ type: 'text', text: 'poked 7' }], isError: false })

    const runs = w.rt.runs({ projectId: 'p1', appId: 'notes' })
    expect(runs.map((r) => [r.tool, r.callerKind, r.callerSessionId, r.status])).toEqual([['poke', 'session', 'claude-s1', 'ok']])

    // A UI-only tool is rejected even if its name is known — the rejection is still recorded as one line.
    const refused = await request('tools/call', { name: 'app_only', arguments: {} })
    expect(refused).toMatchObject({ isError: true })
    expect(w.rt.runs({ projectId: 'p1', appId: 'notes' })[0]).toMatchObject({ tool: 'app_only', status: 'rejected', callerKind: 'session' })
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

  it('the tool use id the CLI carries on tools/call becomes that call\'s card id', async () => {
    const ids = heard()
    await start(WORKER)
    const { request } = await connect('app-notes')
    await request('tools/call', { name: 'poke', arguments: { to: 1 }, _meta: { 'claudecode/toolUseId': 'toolu_01ABC', progressToken: 3 } })
    expect(ids).toHaveLength(1)
    expect(await ids[0]).toBe('toolu_01ABC')
  })

  it('matches against a tool_use from the stream when no id is carried along — a card that already has a result is not matched', async () => {
    const ids = heard()
    await start(WORKER)
    const { request } = await connect('app-notes')
    const toolUse = (id: string, to: number) => ({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'mcp__app-notes__poke', input: { to } }] },
    })
    // A call denied at approval: its result (the denial) arrives right after the tool_use.
    captured.feed.push(toolUse('toolu_denied', 2), {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_denied', is_error: true, content: 'denied' }] },
    })
    captured.feed.push(toolUse('toolu_ok', 2))
    captured.wake?.()
    await kit.until(() => captured.feed.length, (n) => n === 0)
    await new Promise((r) => setTimeout(r, 20))
    await request('tools/call', { name: 'poke', arguments: { to: 2 } })
    expect(await ids[0]).toBe('toolu_ok')
  })
})

describe('an attached app changing is followed without a restart', () => {
  const last = () => captured.setCalls.at(-1) ?? null

  it('calls setMcpServers with the new set when an app appears — an already-attached server keeps the same object', async () => {
    await start(WORKER)
    const notes = servers()['app-notes']
    // Calls the rescan that folder watching would trigger, directly (does not wait for fs-event lag — see session-apps.test.ts).
    w.plant('p1', 'fresh')
    w.rt.refresh()
    await kit.until(() => last(), (s) => s !== null && 'app-fresh' in s)
    expect(Object.keys(last()!).sort()).toEqual(['app-fresh', 'app-notes', 'app-tasks'])
    // The object has to stay the same for the SDK to keep the connection as-is — a new object either gets ignored (same name) or drops and reattaches.
    expect(last()!['app-notes']).toBe(notes)
  })

  it('calls with the server excluded from the set when an app disappears', async () => {
    await start(WORKER)
    rmSync(join(w.roots.p1, '.centralu', 'apps', 'tasks'), { recursive: true, force: true })
    w.rt.refresh()
    await kit.until(() => last(), (s) => s !== null)
    expect(Object.keys(last()!)).toEqual(['app-notes'])
  })

  it('when trust flips, every app drops, and reverting it reattaches with a fresh proxy server', async () => {
    await start(WORKER)
    const before = servers()['app-notes']
    w.trust.p1 = false
    w.rt.refresh()
    await kit.until(() => captured.setCalls.length, (n) => n === 1)
    expect(last()).toEqual({})

    w.trust.p1 = true
    w.rt.refresh()
    await kit.until(() => captured.setCalls.length, (n) => n === 2)
    expect(Object.keys(last()!).sort()).toEqual(['app-notes', 'app-tasks'])
    // A server the SDK has detached cannot be reconnected — an app that reattaches is a new object.
    expect(last()!['app-notes']).not.toBe(before)
  })

  /*
   * A server the person approved is also an app in the user's own folder (A-7) — `second` here is
   * exactly that app, right after approval. No server is ever loaded raw; the set contains only
   * centralu and app proxy servers.
   */
  it('when the orchestrator\'s set changes, centralu stays the original object, alongside the user-folder apps', async () => {
    const tools = {} as OrchestratorTools
    await start({ id: 'orch-1', kind: 'orchestrator', projectId: null }, {
      orchestratorTools: tools,
      toolProfile: 'orchestrator',
    })
    const centralu = servers()['centralu']
    expect(Object.keys(servers()).sort()).toEqual(['app-helper', 'centralu'])

    w.plant('user', 'second')
    w.rt.refresh()
    await kit.until(() => last(), (s) => s !== null && 'app-second' in s)
    expect(Object.keys(last()!).sort()).toEqual(['app-helper', 'app-second', 'centralu'])
    // Omitting it would make the SDK drop the orchestrator server — the same object has to be included every time.
    expect(last()!['centralu']).toBe(centralu)
  })

  it('sends tools/list_changed instead of swapping the server when only an attached app\'s tools change', async () => {
    const extra = join(w.root, 'extra.json')
    w.plant('p1', 'grows', ['--mode', 'attach', '--extra-from', extra])
    w.rt.refresh()
    await start(WORKER)
    const { request, sent } = await connect('app-grows')
    await request('tools/list')

    const { writeFileSync } = await import('node:fs')
    writeFileSync(extra, JSON.stringify(['added_later']))
    await w.rt.restart({ projectId: 'p1', appId: 'grows' })
    await w.rt.tools({ projectId: 'p1', appId: 'grows' }, 'model')

    await kit.until(() => sent.filter((m) => m.method === 'notifications/tools/list_changed').length, (n) => n > 0)
    expect(captured.setCalls).toEqual([])
    const { tools } = (await request('tools/list')) as { tools: { name: string }[] }
    expect(tools.map((t) => t.name)).toContain('added_later')
  })
})

/**
 * Approval for app tools (decision 5): a tool with a read-only annotation is never asked about,
 * and everything else follows the session preset. The judgment is made using the annotation the
 * attached app **actually declared** — a name simply starting with `app-` is never trusted on its
 * own.
 */
describe('approval of app tools — read-only x preset', () => {
  /** The real approval callback. If there is no answer within 200ms, it asked the person (the approval card came up). */
  async function decide(toolName: string): Promise<unknown> {
    const canUseTool = captured.options?.canUseTool as ((n: string, i: Record<string, unknown>) => Promise<unknown>) | undefined
    expect(typeof canUseTool).toBe('function')
    return Promise.race([canUseTool!(toolName, { to: 1 }), new Promise((r) => setTimeout(() => r('asked-the-human'), 200))])
  }
  const ALLOW = { behavior: 'allow', updatedInput: { to: 1 } }

  for (const preset of ['safe', 'normal'] as const) {
    it(`${preset}: a read-only tool is never asked about, and every other app tool asks the person`, async () => {
      const h = await start(WORKER, { permissionPreset: preset })
      // The situation once the model has received the list — the same as the CLI having called tools/list.
      await (h as unknown as { opts: CreateSessionOpts }).opts.apps!.tools('app-notes')

      expect(await decide('mcp__app-notes__peek')).toEqual(ALLOW)
      expect(await decide('mcp__app-notes__poke')).toBe('asked-the-human')
      // A tool with no annotation at all is also not read-only.
      expect(await decide('mcp__app-notes__echo')).toBe('asked-the-human')
    })
  }

  /*
   * Auto is bypassPermissions, so app tools never reach the callback. The callback is still
   * passed for choice questions (AskUserQuestion) (#171), and a request that reaches the callback
   * because it hit an `ask` rule in the settings file is denied the way it was before there was a
   * callback at all — never asking the person, and never approving it on their behalf either.
   */
  it('auto: asks about nothing, including app tools (bypassPermissions — a request reaching the callback is denied with no card)', async () => {
    await start(WORKER, { permissionPreset: 'auto' })
    expect(captured.options?.permissionMode).toBe('bypassPermissions')
    expect(await decide('mcp__app-notes__echo')).toMatchObject({ behavior: 'deny' })
  })

  it('a tool that only imitates an app\'s name does not pass — an unattached app, an unknown list, or a name with an extra segment', async () => {
    await start(WORKER, { permissionPreset: 'normal' })
    // The list is not known yet — this is not a tool the model picked from our own list.
    expect(await decide('mcp__app-notes__peek')).toBe('asked-the-human')
    await w.rt.tools({ projectId: 'p1', appId: 'notes' })
    // An app from a different project is not attached to this session (even with a read-only tool).
    await w.rt.tools({ projectId: 'p2', appId: 'other' }).catch(() => {})
    expect(await decide('mcp__app-other__peek')).toBe('asked-the-human')
    // A tool hiding behind someone else's server name with one extra segment appended.
    expect(await decide('mcp__app-notes__peek__x')).toBe('asked-the-human')
    // Now the list is known — the same name passes.
    expect(await decide('mcp__app-notes__peek')).toEqual(ALLOW)
  })
})

/**
 * A slow call — Claude's in-process server effectively has no call timeout (the SDK's default is
 * about 28 hours, sdk.d.ts `createSdkMcpServer`). So it waits, rather than returning early.
 * `run_status` still shows up in the list — both tools see the same list.
 */
describe('a slow call — Claude waits', () => {
  it('run_status is listed as read-only and gets called without approval', async () => {
    await start(WORKER, { permissionPreset: 'safe' })
    const { request } = await connect('app-notes')
    const { tools } = (await request('tools/list')) as { tools: { name: string; annotations?: Record<string, unknown> }[] }
    expect(tools.find((t) => t.name === 'run_status')?.annotations).toMatchObject({ readOnlyHint: true })
    const canUseTool = captured.options?.canUseTool as (n: string, i: Record<string, unknown>) => Promise<unknown>
    expect(await canUseTool('mcp__app-notes__run_status', { run_id: 'run_x' })).toEqual({ behavior: 'allow', updatedInput: { run_id: 'run_x' } })
  })

  it('still does not return early with "still running" even after 240 seconds — the result arrives when it finishes', async () => {
    await start(WORKER)
    const { request, sent } = await connect('app-notes')
    await request('tools/list')
    const realSetTimeout = globalThis.setTimeout
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      // Sends the call the way the CLI would — the answer arrives in sent.
      const pipe = (servers()['app-notes'] as unknown as { instance: { server: { transport: { onmessage(m: unknown): void } } } }).instance.server.transport
      pipe.onmessage({ jsonrpc: '2.0', id: 900, method: 'tools/call', params: { name: 'hold', arguments: {} } })
      const deadline = performance.now() + 15_000
      while (!w.records('notes').some((r) => r.t === 'holding')) {
        if (performance.now() > deadline) throw new Error('the app never started holding')
        await new Promise((r) => realSetTimeout(r, 10))
      }
      // This outlasts both Claude's 240 seconds and Codex's 300 seconds. At 10 minutes, the runtime's own host-to-app boundary (callTimeoutMs) kicks in.
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
    const { request, sent } = await connect('app-notes')
    await request('tools/list')
    const pipe = (servers()['app-notes'] as unknown as { instance: { server: { transport: { onmessage(m: unknown): void } } } }).instance.server.transport
    pipe.onmessage({ jsonrpc: '2.0', id: 700, method: 'tools/call', params: { name: 'hold', arguments: {} } })
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
