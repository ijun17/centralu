import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { SessionApps } from '../contract.js'

/**
 * An in-process proxy server that attaches one external app to a Claude session (M4 A-5).
 *
 * **The proxy server does not attach to the app process.** The tool list comes from
 * `SessionApps.tools`, and calls go through `SessionApps.call` — after that there is exactly one
 * path in the runtime (`ExternalApps.call`). So a call made by the agent passes through the same
 * exposure-scope check, execution id and record as a call made from the UI. If this were attached
 * to the app directly, we would either build a second copy of those three things or miss one.
 *
 * **Why we do not use the SDK's `tool()`.** `tool()` only accepts a zod shape (sdk.d.ts:
 * `AnyZodRawShape`). An app's input schema is JSON Schema, and if we converted it to zod and the
 * SDK converted it back to JSON Schema (which is what `McpServer`'s tools/list does), things like
 * description, default value and `additionalProperties` would drift across the round trip — the
 * model would see a different tool than the one the app declared. So instead we take only the
 * server's slot (name, SDK transport) from `createSdkMcpServer`, and attach the `tools/list` and
 * `tools/call` handlers directly to the low-level server inside it. The app's schema and
 * description reach the model without a single character changed.
 *
 * Measured (the installed sdk.mjs from 0.3.263): `createSdkMcpServer` builds a v1 `McpServer`
 * with tool capability turned on whenever `tools` is passed (even an empty array), and does not
 * attach that handler when zero tools are registered — so it never collides with our own handler.
 * The handler's schema is read only for its method name (a `method` literal is included to avoid
 * "Schema is missing a method literal").
 *
 * SDK types do not leave this folder (anti-corruption).
 */

/** Only the part of the SDK's internal v1 low-level server that we use. */
type LowLevelServer = {
  registerCapabilities(capabilities: Record<string, unknown>): void
  setRequestHandler(
    schema: unknown,
    handler: (request: { params: Record<string, unknown> }, extra: { signal?: AbortSignal }) => Promise<unknown>,
  ): void
  sendToolListChanged(): Promise<void>
}

const ListTools = z.object({ method: z.literal('tools/list'), params: z.optional(z.looseObject({})) })
const CallTool = z.object({
  method: z.literal('tools/call'),
  params: z.looseObject({ name: z.string(), arguments: z.optional(z.record(z.string(), z.unknown())), _meta: z.optional(z.looseObject({})) }),
})

/**
 * Where Claude Code carries the card id on an MCP tool call (M4 B-1). The installed CLI's MCP
 * tool wrapper (the binary bundled with agent SDK 0.3.263) calls
 * `callTool({ name, arguments, _meta: { "claudecode/toolUseId": <tool_use id> } })` (measured:
 * the binary's own strings). That id equals the adapter's `tool_call` callId (the `tool_use`
 * block's id) — so the conversation view in the UI knows its own card without any extra matching.
 * If it is absent (a different CLI), attachment matching falls back to the adapter's own
 * notification.
 */
export const CLAUDE_TOOL_USE_META = 'claudecode/toolUseId'

export type AppProxy = {
  /** The config to pass to the SDK (`mcpServers[name]`) — the same object for as long as the same app stays attached. */
  config: ReturnType<typeof createSdkMcpServer>
  /** Tells the CLI the tool list changed — the CLI then calls `tools/list` again. */
  toolsChanged(): void
}

export function appProxy(apps: SessionApps, server: string): AppProxy {
  const config = createSdkMcpServer({ name: server, version: '1', tools: [] })
  const low = (config.instance as unknown as { server: LowLevelServer }).server
  /*
   * Declares in advance that we can send a "list changed" notification (only possible before
   * connection). When an app's tools change, this single notification is enough instead of
   * swapping out the server — Claude re-reads the list when it receives `tools/list_changed`.
   */
  low.registerCapabilities({ tools: { listChanged: true } })
  low.setRequestHandler(ListTools, async () => ({
    // An empty list if the app has detached — there is a short window where the CLI still holds this server.
    tools: await apps.tools(server).catch(() => []),
  }))
  low.setRequestHandler(CallTool, async (request, extra) => {
    const { name, arguments: args, _meta } = request.params as { name: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> }
    const toolUseId = _meta?.[CLAUDE_TOOL_USE_META]
    // If the CLI cancels the call (notifications/cancelled), extra.signal fires — it propagates through to the app call.
    return apps.call(server, name, args ?? {}, { signal: extra?.signal, ...(typeof toolUseId === 'string' && toolUseId ? { callId: toolUseId } : {}) })
  })
  return {
    config,
    toolsChanged: () => {
      // Before connection there is nowhere to notify — the CLI reads the list on its own once connected anyway.
      void Promise.resolve()
        .then(() => low.sendToolListChanged())
        .catch(() => {})
    },
  }
}
