import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { toolProfileOf, type CreateSessionOpts } from '../contract.js'
import { appCallOf } from '../tool-titles.js'
import { CENTRALU_MCP_NAME, centraluMcp } from './centralu-mcp.js'

/** What the server set reads of the session it belongs to */
export type ServersHost = {
  readonly sessionId: string
  readonly opts: CreateSessionOpts
}

/**
 * A Claude session's MCP servers (FR-11): Centralu's in-process server, the one server the session is given. Apps are
 * reached through its `app` tool since #2231, so the set never changes while the session runs.
 */
export class ClaudeServers {
  /** The in-process server — the same object every query of this session is given */
  centraluToolsServer: ReturnType<typeof centraluMcp> | null = null

  constructor(private readonly host: ServersHost) {}

  /** The servers the session starts with */
  load(): void {
    if (this.host.opts.centraluTools) {
      this.centraluToolsServer = centraluMcp(this.host.opts.centraluTools, toolProfileOf(this.host.opts), this.host.opts.sessionId, (this.host.opts.apps?.current().length ?? 0) > 0)
    }
  }

  /**
   * All of this session's MCP servers. Only Centralu's (FR-11): everything its tools can see is exactly what the manager
   * handed them. A server the person approved (`propose_mcp_server`) becomes an app in the user's own folder (A-7) and is
   * reached through `app` like any other; no server is ever loaded raw, and a server named `centralu` cannot replace this
   * one (#93).
   */
  mcpServers(): Record<string, McpServerConfig> {
    return this.centraluToolsServer ? { [CENTRALU_MCP_NAME]: this.centraluToolsServer } : {}
  }

  /**
   * Records a `tool_use` of the `app` tool with the attachment layer (M4 B-1 — conversation-view card matching).
   *
   * This is not usually needed: the CLI carries the card id on the call itself (centralu-mcp.ts's
   * `CLAUDE_TOOL_USE_META`). This keeps the same matching as the bridge's as a fallback, so the UI can still find its own
   * card on a CLI where that mechanism changed. A card that has already received a result (`tool_result`) is removed from
   * matching — a call refused before it ran never reaches the app at all.
   */
  noteAppCalls(msg: unknown): void {
    const apps = this.host.opts.apps
    const m = msg as { type?: string; message?: { content?: unknown } }
    if (!apps || (m.type !== 'assistant' && m.type !== 'user') || !Array.isArray(m.message?.content)) return
    for (const b of m.message.content as { type?: string; id?: unknown; name?: unknown; input?: unknown; tool_use_id?: unknown }[]) {
      if (b?.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
        const call = appCallOf({ name: b.name }, b.input)
        if (call) apps.noteCall(b.id, call.app, call.tool, call.args)
      } else if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        apps.callEnded(b.tool_use_id)
      }
    }
  }
}
