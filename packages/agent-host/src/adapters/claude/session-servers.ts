import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import type { CreateSessionOpts } from '../contract.js'
import { appProxy, type AppProxy } from './app-proxy.js'
import { ORCHESTRATOR_MCP_NAME, orchestratorMcp } from './orchestrator-mcp.js'
import { appToolOf } from './permissions.js'

/** What the server set reads of the session it belongs to */
export type ServersHost = {
  readonly sessionId: string
  readonly opts: CreateSessionOpts
  closed(): boolean
  /** The live query, once there is one: the set is replaced through it */
  query(): { setMcpServers(servers: Record<string, McpServerConfig>): Promise<{ errors: Record<string, string> }> } | null
  /** Says something to the person in the session, as a warning notice (#841 item 8) */
  warn(text: string): void
}

/**
 * A Claude session's MCP servers (FR-11, M4 A-5): the orchestrator's in-process server and one proxy per attached
 * app, loaded at start and followed without a restart as apps come and go.
 */
export class ClaudeServers {
  /**
   * Proxy servers for attached apps (M4 A-5) — server name to proxy server, plus the last tool
   * list seen. The same object is reloaded for as long as the same app stays attached: the SDK
   * ignores a new object for a name that is already connected (sdk.mjs `setMcpServers`), so
   * swapping in a different object requires detaching and reattaching.
   */
  private appProxies = new Map<string, { proxy: AppProxy; tools: string }>()
  /** The orchestrator's in-process server — the same object passed initially is reloaded every time the server set changes. */
  orchestratorServer: ReturnType<typeof orchestratorMcp> | null = null
  /** Serializes server-set changes into one line — so a later change never interleaves with one that has not finished yet. */
  private serversSync: Promise<unknown> = Promise.resolve()

  constructor(private readonly host: ServersHost) {}

  /** The servers the session starts with */
  load(): void {
  /*
   * External apps (M4 A-5) — one proxy server per app. Loads whatever is currently attached,
   * and follows along without restarting the session when an app comes, goes, or its tools
   * change (syncApps).
   */
  for (const a of this.host.opts.apps?.current() ?? []) {
    this.appProxies.set(a.server, { proxy: appProxy(this.host.opts.apps!, a.server), tools: JSON.stringify(a.tools) })
  }
  if (this.host.opts.orchestratorTools) {
    this.orchestratorServer = orchestratorMcp(this.host.opts.orchestratorTools, this.host.opts.toolProfile, this.host.opts.sessionId)
  }
  }

  /**
   * All of this session's MCP servers — assembled in this one place, both at first launch and
   * whenever the set changes.
   *
   * There are two, and both are in-process, so there is never a separate process:
   *   1. The orchestrator's tools (FR-11) — everything these tools can see is exactly what the
   *      manager handed them.
   *   2. External apps' proxy servers (M4 A-5) — `app-<id>`. A server the person approved
   *      (`propose_mcp_server`) also becomes an app in the user's own folder and arrives here
   *      (A-7). This server used to be loaded raw, as a stdio entry — calls never went through
   *      mediation or recording, and a single server named `centralu` could replace the
   *      in-process orchestrator outright (#93). No server is ever loaded raw anymore.
   *
   * When the set changes (`setMcpServers`), leaving out #1 makes the SDK **detach it** — that
   * call replaces the entire set of dynamically attached servers with whatever was passed. So
   * this always loads everything, every time.
   */
  mcpServers(): Record<string, McpServerConfig> {
    return {
      ...(this.orchestratorServer ? { [ORCHESTRATOR_MCP_NAME]: this.orchestratorServer } : {}),
      ...Object.fromEntries([...this.appProxies].map(([name, { proxy }]) => [name, proxy.config])),
    }
  }

  /**
   * An attached app changed (M4 A-5) — followed without a restart.
   *
   *   an app comes or goes (including trust flipping)   changes the set via `setMcpServers`; new tools become visible starting the next turn
   *   an attached app's own tools changed                that proxy server sends `tools/list_changed` — the server itself stays the same
   */
  syncApps(): void {
    const apps = this.host.opts.apps
    if (!apps || this.host.closed()) return
    const now = apps.current()
    const want = new Set(now.map((a) => a.server))
    let setChanged = false
    for (const name of [...this.appProxies.keys()]) {
      if (want.has(name)) continue
      this.appProxies.delete(name)
      setChanged = true
    }
    for (const a of now) {
      const tools = JSON.stringify(a.tools)
      const held = this.appProxies.get(a.server)
      if (!held) {
        // An app that detaches and reattaches also arrives with a fresh proxy server — a server the SDK has detached cannot be reconnected.
        this.appProxies.set(a.server, { proxy: appProxy(apps, a.server), tools })
        setChanged = true
      } else if (held.tools !== tools) {
        held.tools = tools
        held.proxy.toolsChanged()
      }
    }
    if (!setChanged || !this.host.query()) return
    const q = this.host.query()!
    const servers = this.mcpServers()
    this.serversSync = this.serversSync
      .then(() => q.setMcpServers(servers))
      /*
       * Said in the session as well as logged (#841 item 8): logged only, an app that never attached looked like an app
       * with no tools, and neither the person nor the agent learned why
       */
      .then((r) => {
        const errors = Object.entries(r?.errors ?? {})
        if (!errors.length) return
        console.error(`[claude] ${this.host.sessionId.slice(0, 8)} app servers failed to attach:`, errors)
        if (!this.host.closed()) this.host.warn(`Claude Code could not attach ${errors.map(([name, why]) => `${name} (${String(why).split('\n')[0]})`).join(', ')}; its tools are missing from this session until it restarts.`)
      })
      .catch((err: Error) => {
        console.error(`[claude] ${this.host.sessionId.slice(0, 8)} could not update app servers: ${err.message}`)
        if (!this.host.closed()) this.host.warn(`Claude Code could not update this session's apps (${err.message.split('\n')[0]}); apps attached or removed since it started may not be in effect until it restarts.`)
      })
  }

  /**
   * Records a `tool_use` calling an attached app's tool with the attachment layer (M4 B-1 —
   * conversation-view card matching).
   *
   * This is not usually needed: the CLI carries the card id on the call itself
   * (app-proxy.ts's `CLAUDE_TOOL_USE_META`). This keeps the same matching logic as Codex as a
   * fallback, so the UI can still find its own card even on a CLI where that mechanism changed.
   * A card that has already received a result (`tool_result`) is removed from matching — a call
   * denied at approval never reaches the app at all.
   */
  noteAppCalls(msg: unknown): void {
    const apps = this.host.opts.apps
    const m = msg as { type?: string; message?: { content?: unknown } }
    if (!apps || (m.type !== 'assistant' && m.type !== 'user') || !Array.isArray(m.message?.content)) return
    for (const b of m.message.content as { type?: string; id?: unknown; name?: unknown; input?: unknown; tool_use_id?: unknown }[]) {
      if (b?.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
        const t = appToolOf(b.name)
        if (t && this.appProxies.has(t.server)) apps.noteCall(b.id, t.server, t.tool, b.input ?? {})
      } else if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        apps.callEnded(b.tool_use_id)
      }
    }
  }
}
