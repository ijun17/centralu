import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type { CentraluTools } from '../contract.js'
import {
  CENTRALU_MCP_NAME,
  instructionsFor,
  runCentraluTool,
  toolDefsFor,
} from '../../sessions/centralu-tools.js'
import type { ToolProfile } from '../../apps/contract.js'
import { DrainCut, drainToolResult, hostDrain } from '../../drain.js'

/**
 * Attaches the Centralu tools to Claude (FR-11).
 *
 * **This is an in-process MCP** — no separate process, no port, no authentication. A function
 * inside the host becomes the tool as-is. So "only the sessions this app manages" is not a rule
 * we enforce, it is structural: everything these tools can see is whatever `CentraluTools`
 * was handed, and that object contains no files, no projects, no other tools.
 *
 * **The tools' names, descriptions and execution are not decided here** (see
 * sessions/centralu-tools.ts). Codex reaches the same definitions through a bridge, so if
 * there were two definitions the same app would end up with different tools depending on which
 * adapter is running.
 *
 * SDK types do not leave this file (anti-corruption).
 */

/**
 * The server name comes from next to the tool definitions (sessions/centralu-tools.ts) —
 * both the approval exception and the check that blocks a proposed name have to look at the
 * same string (#93).
 */
export { CENTRALU_MCP_NAME }

/** What Claude Code calls its own subagent tool: the name Centralu's instructions put `start_agent` before (#1587) */
export const CLAUDE_SUBAGENT_TOOL = 'Agent'

export function centraluMcp(
  tools: CentraluTools,
  profile: ToolProfile,
  sessionId?: string,
  /** An app is attached as the session starts (#957, #992 review): the instructions then name an app's help */
  appsAttached = false,
) {
  const defs = toolDefsFor(profile)
  // A set with a deferred tool is loaded tool by tool: only the reader's has one
  const someDeferred = defs.some((t) => 'deferred' in t && t.deferred === true)
  return createSdkMcpServer({
    name: CENTRALU_MCP_NAME,
    version: '1',
    /*
     * **Do not defer.**
     *
     * By default the SDK defers MCP tools behind tool search (ToolSearch). Measured: because of
     * that, the Assistant would look up and call only `list_sessions`, never even see
     * `send_to_session`, and end the turn silently — it read the list and never handed out the
     * work.
     *
     * For the Assistant these tools are not a side feature; they are the reason it exists.
     *
     * The reader set (#320) is loaded tool by tool instead: all but app_guide (deferring them made
     * recall go unused, measured), while app_guide waits behind tool search — it rides in every
     * ordinary session, and the person rarely asks one of them about the app.
     */
    alwaysLoad: !someDeferred,
    // None for the reader set (#320): server instructions are where a role would creep in
    instructions: instructionsFor(profile, undefined, appsAttached, CLAUDE_SUBAGENT_TOOL),
    // Only expose what the profile allows (#69) — the execution side re-checks the same rule.
    tools: defs.map((t) =>
      tool(t.name, t.description, t.schema.shape, async (args: Record<string, unknown>, extra: unknown) =>
        // Served by the host itself, so a stop that drains first waits for it, within a bound (drain.ts)
        hostDrain
          .track(`tool ${CENTRALU_MCP_NAME}/${t.name}`, async () => {
            // The call's own signal (MCP's request extra): the CLI cancelling the call stops what it started (ask_project, #371)
            const signal = (extra as { signal?: AbortSignal } | undefined)?.signal
            const r = await runCentraluTool(tools, t.name, args, { sessionId: sessionId ?? null, profile }, signal)
            return { content: [{ type: 'text' as const, text: r.text }], isError: r.isError }
          })
          .catch((e: unknown) => {
            if (e instanceof DrainCut) return drainToolResult(e)
            throw e
          }),
        someDeferred && !('deferred' in t && t.deferred) ? { alwaysLoad: true } : undefined,
      ),
    ),
  })
}
