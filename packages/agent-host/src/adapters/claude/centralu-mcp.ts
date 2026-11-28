import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type { CentraluTools } from '../contract.js'
import {
  CENTRALU_MCP_NAME,
  runCentraluTool,
  toolDefsFor,
} from '../../sessions/centralu-tools.js'
import type { ToolProfile } from '../../apps/contract.js'
import { DrainCut, drainToolResult, hostDrain } from '../../drain.js'

/**
 * Attaches the Centralu tools to Claude (FR-11).
 *
 * **An in-process MCP**: no process, port or authentication. "Only the sessions this app manages" is structural:
 * the tools see only what `CentraluTools` was handed, which holds no files, projects or other tools.
 * Names, descriptions and execution live in sessions/centralu-tools.ts, which Codex reaches through a bridge too.
 * SDK types do not leave this file (anti-corruption).
 */

/** The approval exception and the check that blocks a proposed name look at this one string (#93) */
export { CENTRALU_MCP_NAME }

/**
 * Where Claude Code carries the card id on an MCP tool call (M4 B-1). The CLI's MCP tool wrapper calls
 * `callTool({ name, arguments, _meta: { "claudecode/toolUseId": <tool_use id> } })` (measured from the binary's own strings,
 * SDK 0.3.263, on the app proxy this replaced in #2231). That id equals the adapter's `tool_call` callId, so an `app` call's
 * inline view knows its card without matching; absent, the host matches what the adapter noted (`SessionApps.noteCall`).
 */
const CLAUDE_TOOL_USE_META = 'claudecode/toolUseId'

/** What a tool of the SDK's in-process server answers */
type ToolAnswer = Awaited<ReturnType<Parameters<typeof tool>[3]>>
type ContentBlock = ToolAnswer['content'][number]

/** The kinds of content a tool's result may hold (MCP's `ContentBlock`): an app's own result passes on as the app gave it (#2231) */
const CONTENT_KINDS: ReadonlySet<unknown> = new Set(['text', 'image', 'audio', 'resource_link', 'resource'])
const isContentBlock = (c: unknown): c is ContentBlock => typeof c === 'object' && c !== null && 'type' in c && CONTENT_KINDS.has(c.type)

/** What Claude Code calls its own subagent tool: the name Centralu's instructions put `start_agent` before (#1587) */
export const CLAUDE_SUBAGENT_TOOL = 'Agent'

export function centraluMcp(
  tools: CentraluTools,
  profile: ToolProfile,
  sessionId?: string,
  /** The session's tool instructions (`agentTextOf`) */
  instructions?: string,
) {
  const defs = toolDefsFor(profile)
  return createSdkMcpServer({
    name: CENTRALU_MCP_NAME,
    version: '1',
    instructions,
    // Only expose what the profile allows (#69) — the execution side re-checks the same rule.
    tools: defs.map((t) =>
      tool(t.name, t.description, t.schema.shape, async (args: Record<string, unknown>, extra: unknown) =>
        // Served by the host itself, so a stop that drains first waits for it, within a bound (drain.ts)
        hostDrain
          .track(`tool ${CENTRALU_MCP_NAME}/${t.name}`, async () => {
            // The call's own signal (MCP's request extra): the CLI cancelling the call stops what it started (ask_project, #371)
            const { signal, _meta } = (extra ?? {}) as { signal?: AbortSignal; _meta?: Record<string, unknown> }
            // The card's id, which Claude Code sends with the call: an app call's inline view settles under it (#2231, M4 B-1)
            const toolUseId = _meta?.[CLAUDE_TOOL_USE_META]
            const r = await runCentraluTool(tools, t.name, args, { sessionId: sessionId ?? null, profile }, signal, typeof toolUseId === 'string' && toolUseId ? { callId: toolUseId } : {})
            // An app's own result goes on as the app gave it (#2231): its blocks of MCP's kinds, which the app's server spoke
            if (!r.content) return { content: [{ type: 'text' as const, text: r.text }], isError: r.isError }
            const answer: ToolAnswer = { content: r.content.filter(isContentBlock), isError: r.isError, ...(r.structuredContent ? { structuredContent: r.structuredContent } : {}) }
            return answer
          })
          .catch((e: unknown) => {
            if (e instanceof DrainCut) return drainToolResult(e)
            throw e
          }),
        /*
         * **Load what is not marked deferred.** The SDK defers MCP tools behind ToolSearch by default; measured, the
         * Assistant then called only `list_sessions`, never saw `send_to_session`, and ended the turn silently without
         * handing out the work. In the reader set (#320) deferring the others left recall unused (measured); app_guide
         * waits behind tool search, as it rides in every ordinary session and is rarely needed.
         */
        'deferred' in t && t.deferred ? undefined : { alwaysLoad: true },
      ),
    ),
  })
}
