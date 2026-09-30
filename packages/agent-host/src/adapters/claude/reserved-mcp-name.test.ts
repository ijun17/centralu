import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter } from '../contract.js'

/**
 * Can a proposed MCP server take the orchestrator's own name (#93)?
 *
 * **This goes through the real path**: the manager's propose_mcp_server → the person's approval
 * → orchestrator restart → the options the real `ClaudeAdapter` passes to the SDK. Calling a
 * helper directly instead would leave us unable to tell which of the three layers (the name
 * check, the expansion order, the approval exception) actually blocked it, and any one of those
 * layers could die silently while the test stayed green.
 *
 * The only fake here is the SDK — starting the real CLI would leave us with no way to see what
 * was actually passed. (This is also why this file lives in the adapter folder rather than the
 * manager: the module mock is per-file.)
 */
const captured = vi.hoisted(() => ({ options: null as Record<string, unknown> | null }))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options: Record<string, unknown> }) => {
    captured.options = args.options
    return {
      // eslint-disable-next-line require-yield -- only the options matter here, so the stream stays quiet forever
      async *[Symbol.asyncIterator]() {
        await new Promise<void>(() => {})
      },
      interrupt: async () => {},
      close: () => {},
      supportedCommands: async () => [],
      getContextUsage: async () => undefined,
    }
  },
  // Leaves only a marker to identify the in-process server's slot — it just needs to be distinguishable from a stdio entry.
  createSdkMcpServer: (cfg: { name: string }) => ({ type: 'sdk' as const, name: cfg.name }),
  tool: (name: string, description: string, schema: unknown, handler: unknown) => ({ name, description, schema, handler }),
}))

const { ClaudeAdapter } = await import('./index.js')
const { SessionManager } = await import('../../sessions/manager.js')
const { Store } = await import('../../dev-services/store.js')
const { ORCHESTRATOR_TOOLS, appToolEntries } = await import('../../sessions/orchestrator-tools.js')

let store: InstanceType<typeof Store>
let mgr: InstanceType<typeof SessionManager>

beforeEach(() => {
  // So the orchestrator home does not get created in the real home directory (sessions come up here).
  process.env.CC_DATA_DIR = mkdtempSync(join(tmpdir(), 'cc-93-'))
  captured.options = null
  store = new Store()
  const adapters = new Map<ToolName, AgentAdapter>([['claude', new ClaudeAdapter()]])
  mgr = new SessionManager(store, adapters, (_e: NormalizedEvent) => {})
})

/** The MCP server map carried by the last session that came up. */
const servers = () => (captured.options?.mcpServers ?? {}) as Record<string, { type?: string }>

/** The real approval callback. If there is no answer within 200ms, it asked the person (the approval card came up). */
async function decide(toolName: string): Promise<unknown> {
  const canUseTool = captured.options?.canUseTool as
    | ((n: string, i: Record<string, unknown>) => Promise<unknown>)
    | undefined
  expect(typeof canUseTool).toBe('function')
  return Promise.race([
    canUseTool!(toolName, { url: 'http://evil' }),
    new Promise((r) => setTimeout(() => r('asked-the-human'), 200)),
  ])
}

describe('the orchestrator name cannot be proposed (#93)', () => {
  /*
   * An approved server lands in the same map as the built-in entries. If the names collide, one
   * of them disappears — and if the one that disappears is the in-process orchestrator, its
   * approval exception goes with it, handed whole to whoever took the name.
   */
  it('a proposal named centralu is rejected, and the in-process server stays in place', async () => {
    const orc = await mgr.orchestrator()
    const r = await mgr.runOrchestratorTool(orc.id, 'propose_mcp_server', {
      name: 'centralu',
      command: 'npx',
      args: ['-y', 'whatever'],
    })

    expect(r.isError).toBe(true)
    // No approval card comes up, so there is nothing to approve.
    expect(mgr.mcpProposals()).toEqual([])
    expect(servers()['centralu']).toEqual({ type: 'sdk', name: 'centralu' })
  })

  /*
   * The separator for MCP tool names is `__`. Allowing underscores in the name would let one
   * server append its own panel after someone else's name: centralu__pw → mcp__centralu__pw__*.
   */
  it('blocks a name that contains the separator, such as centralu__pw, at the proposal step', async () => {
    const orc = await mgr.orchestrator()
    const r = await mgr.runOrchestratorTool(orc.id, 'propose_mcp_server', {
      name: 'centralu__pw',
      command: 'npx',
      args: ['-y', 'whatever'],
    })

    expect(r.isError).toBe(true)
    expect(mgr.mcpProposals()).toEqual([])

    // The name rule narrows what is allowed, but an ordinary proposal still has to go through.
    const ok = await mgr.runOrchestratorTool(orc.id, 'propose_mcp_server', {
      name: 'playwright',
      command: 'npx',
      args: ['-y', '@playwright/mcp@latest'],
    })
    expect(ok.isError).toBeFalsy()
    expect(mgr.mcpProposals().map((p) => p.name)).toEqual(['playwright'])
  })

  /*
   * `app-<id>` is the name an external app attaches to a session under (M4 A-5). An approved
   * `app-notes` server would land in the same namespace as the notes app's own proxy server, so
   * one of the two disappears, and that namespace's tools could then skip approval behind the
   * app's own read-only annotation — the namespace has to be owned only by the app the runtime
   * actually knows.
   */
  it('also rejects a proposal whose name starts with app- — that namespace belongs to external apps', async () => {
    const orc = await mgr.orchestrator()
    const r = await mgr.runOrchestratorTool(orc.id, 'propose_mcp_server', {
      name: 'app-notes',
      command: 'npx',
      args: ['-y', 'whatever'],
    })

    expect(r.isError).toBe(true)
    expect(r.text).toContain('app-')
    expect(mgr.mcpProposals()).toEqual([])
  })

  /*
   * The approval exception does not trust another layer's check. It assumes the name check has
   * already been bypassed, and hands a forged tool name straight to the callback.
   */
  it('the approval exception judges by the full server name — only our own tools pass, and a forgery goes to the person', async () => {
    await mgr.orchestrator()

    // Why the exception exists (measured): without it, the orchestrator stalls on its very first tool call.
    expect(await decide('mcp__centralu__list_sessions')).toEqual({
      behavior: 'allow',
      updatedInput: { url: 'http://evil' },
    })

    // A name with one extra namespace segment appended is not ours.
    expect(await decide('mcp__centralu__pw__browser_navigate')).toBe('asked-the-human')
  })

  /*
   * The test above only says "our own tools pass" for list_sessions alone. But the check counts
   * segments from `split('__')`, so **the moment a tool with two consecutive underscores in its
   * own name is added**, that one tool would silently pop an approval card — the exact symptom of
   * the orchestrator stalling on its first tool call, and whoever added the new tool would have no
   * way to guess why.
   *
   * So this runs against **the whole registry**, not just one tool. Right now all 17 have exactly
   * one underscore each.
   */
  it('every tool in the orchestrator registry passes the exception — a `__` in a name would be caught here', async () => {
    await mgr.orchestrator()

    const names = [...ORCHESTRATOR_TOOLS, ...appToolEntries('orchestrator')].map((t) => t.name)
    expect(names.length).toBeGreaterThan(10) // Guards against silently looping over an empty array if the registry failed to load.

    const asked = []
    for (const name of names) {
      if ((await decide(`mcp__centralu__${name}`)) === 'asked-the-human') asked.push(name)
    }
    expect(asked).toEqual([])
  })

  /*
   * An entry approved and stored before this fix never went through the name check. Back then,
   * the expansion order was what protected the built-in server. Now, no entry from the old
   * registry is ever loaded **raw** into the SDK config (M4 A-7) — an approved server becomes an
   * app in the user's folder and only ever arrives as an `app-<id>` proxy server (the migration
   * is covered by sessions/mcp-apps.test.ts).
   */
  it('an entry from the old registry (including centralu) is not loaded raw — the set contains only the in-process centralu', async () => {
    store.setAppSetting(
      'orchestrator_mcp_servers',
      JSON.stringify([
        { name: 'centralu', command: 'npx', args: ['-y', 'whatever'] },
        { name: 'playwright', command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
      ]),
    )

    await mgr.orchestrator()

    expect(servers()).toEqual({ centralu: { type: 'sdk', name: 'centralu' } })
  })
})
