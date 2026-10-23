import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as kit from '../../apps/external/test-helpers.js'
import { SessionAppsHub, type AppSessionKey } from '../../sessions/session-apps.js'
import { attachWorld, type AttachWorld } from '../../sessions/session-apps.test-helpers.js'
import type { OrchestratorTools, SessionHandle } from '../contract.js'

/**
 * The tool prefix of a Claude session does not move while the session lives (#513).
 *
 * The prompt cache reuses a request's prefix only while it is byte-identical, and the request's tool
 * list comes first: a tool definition that appears or leaves mid-session makes everything after it be
 * written to the cache again. What Claude Code puts in that list is every MCP tool marked
 * `anthropic/alwaysLoad`; the rest are names announced in the conversation and loaded through tool
 * search (measured against the real CLI with `scripts/measure-tools.mts`, dry, docs/tool-cost.md).
 * So the resident prefix this host controls is the set of alwaysLoad tools across the session's
 * servers, read here the way the CLI reads it: `tools/list` on each server.
 *
 * The only fake is `query`, as in apps.test.ts: the servers are the real ones the adapter builds,
 * and the apps are real fixture processes.
 */

const captured = vi.hoisted(() => ({
  options: null as Record<string, unknown> | null,
  setCalls: [] as Record<string, unknown>[],
}))

vi.mock('@anthropic-ai/claude-agent-sdk', async (importActual) => ({
  ...(await importActual<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: (args: { options: Record<string, unknown> }) => {
    captured.options = args.options
    return {
      // A stream that never says anything: the servers are what this test reads, not messages
      [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<unknown>>(() => {}) }),
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

type Sent = { jsonrpc: '2.0'; id?: number; result?: Record<string, unknown>; error?: unknown }
type ListedTool = { name: string; description?: string; inputSchema?: unknown; _meta?: Record<string, unknown> }
type ServerConfig = { instance: { connect(t: unknown): Promise<void> } }

let w: AttachWorld
let hub: SessionAppsHub
let handle: SessionHandle | null = null
/** One CLI-side connection per server object: a server connects once, as it does to the CLI */
let lists: WeakMap<object, () => Promise<ListedTool[]>>

const READER: AppSessionKey = { id: 'claude-reader', kind: 'worker', projectId: 'p1' }

async function start(): Promise<void> {
  handle = await new ClaudeAdapter().createSession(
    {
      sessionId: READER.id,
      cwd: '/tmp',
      permissionPreset: 'normal',
      projectTrusted: true,
      apps: hub.attach(READER),
      orchestratorTools: {} as OrchestratorTools,
      toolProfile: 'reader',
    },
    () => {},
  )
}

/** `tools/list` on a server, as the CLI asks it */
async function listTools(config: ServerConfig): Promise<ListedTool[]> {
  const known = lists.get(config)
  if (known) return known()
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
  await config.instance.connect(pipe)
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
  const list = async () => ((await request('tools/list')) as { tools: ListedTool[] }).tools
  lists.set(config, list)
  return list()
}

/** The resident prefix of a server set: every tool the CLI would keep in the request's tool list, in server order */
async function residentPrefix(servers: Record<string, unknown>): Promise<string> {
  const resident: unknown[] = []
  for (const [name, config] of Object.entries(servers).sort(([a], [b]) => a.localeCompare(b))) {
    for (const t of await listTools(config as ServerConfig)) {
      if (t._meta?.['anthropic/alwaysLoad'] === true) resident.push({ name: `mcp__${name}__${t.name}`, description: t.description, input_schema: t.inputSchema })
    }
  }
  return JSON.stringify(resident)
}

const initial = () => (captured.options?.mcpServers ?? {}) as Record<string, unknown>
const last = () => captured.setCalls.at(-1) ?? null

beforeEach(() => {
  captured.options = null
  captured.setCalls = []
  lists = new WeakMap()
  w = attachWorld(kit)
  w.plant('p1', 'notes')
  w.rt.refresh()
  hub = new SessionAppsHub(w.rt, { toolListWaitMs: 10_000, callJoinWaitMs: 300 })
})

afterEach(async () => {
  await handle?.dispose()
  handle = null
  hub.dispose()
  await w.dispose()
})

describe('the resident tool prefix of a Claude session', () => {
  it('holds the reader set\'s loaded tools and no app tool', async () => {
    await start()
    const prefix = JSON.parse(await residentPrefix(initial())) as { name: string }[]
    // find_apps joined the loaded tools in #522: deferred, it lost to ask_project
    // The guide and update tool stay behind tool search; neither belongs in this resident prefix.
    expect(prefix.map((t) => t.name)).toEqual(['mcp__centralu__read_session', 'mcp__centralu__recall', 'mcp__centralu__ask_project', 'mcp__centralu__start_agent', 'mcp__centralu__find_apps', 'mcp__centralu__compact_self'])
    const offered = await listTools(initial()['centralu'] as ServerConfig)
    for (const name of ['app_guide', 'update_centralu']) {
      expect(offered.find((t) => t.name === name), name).toBeDefined()
      expect(offered.find((t) => t.name === name)?._meta?.['anthropic/alwaysLoad'], name).not.toBe(true)
    }
  })

  it('stays byte-identical when an app is attached and detached, even an app that asks to stay loaded', async () => {
    await start()
    const before = await residentPrefix(initial())
    const centralu = initial()['centralu']

    // `--resident`: the app's `pinned` tool declares anthropic/alwaysLoad
    w.plant('p1', 'pinned-app', ['--mode', 'attach', '--resident'])
    w.rt.refresh()
    await kit.until(() => last(), (s) => s !== null && 'app-pinned-app' in s)
    const attached = last()!
    const listed = await listTools(attached['app-pinned-app'] as ServerConfig)
    expect(listed.map((t) => t.name)).toContain('pinned')
    expect(await residentPrefix(attached)).toBe(before)
    // The same server object: a new one for the same name would be ignored or reconnected by the SDK
    expect(attached['centralu']).toBe(centralu)

    // The manifest, not the folder: on Windows the running app holds its folder as its working directory
    rmSync(join(w.roots.p1, '.centralu', 'apps', 'pinned-app', 'centralu.app.json'))
    w.rt.refresh()
    await kit.until(() => last(), (s) => s !== null && !('app-pinned-app' in s))
    expect(await residentPrefix(last()!)).toBe(before)
    expect(last()!['centralu']).toBe(centralu)
  })
})
