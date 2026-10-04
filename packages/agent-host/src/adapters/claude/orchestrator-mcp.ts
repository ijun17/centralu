import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type { OrchestratorTools } from '../contract.js'
import {
  BUILDER_INSTRUCTIONS,
  MANAGER_INSTRUCTIONS,
  ORCHESTRATOR_MCP_NAME,
  ORCHESTRATOR_INSTRUCTIONS,
  SCOPED_INSTRUCTIONS,
  ORCHESTRATOR_TOOLS,
  appToolEntries,
  profileAllows,
  runOrchestratorTool,
} from '../../sessions/orchestrator-tools.js'
import type { ToolProfile } from '../../apps/contract.js'
import { DrainCut, drainToolResult, hostDrain } from '../../drain.js'

/**
 * Attaches the orchestrator's tools to Claude (FR-11).
 *
 * **This is an in-process MCP** — no separate process, no port, no authentication. A function
 * inside the host becomes the tool as-is. So "only the sessions this app manages" is not a rule
 * we enforce, it is structural: everything these tools can see is whatever `OrchestratorTools`
 * was handed, and that object contains no files, no projects, no other tools.
 *
 * **The tools' names, descriptions and execution are not decided here** (see
 * sessions/orchestrator-tools.ts). Codex reaches the same definitions through a bridge, so if
 * there were two definitions the same app would end up with different tools depending on which
 * adapter is running.
 *
 * SDK types do not leave this file (anti-corruption).
 */

/**
 * The server name comes from next to the tool definitions (sessions/orchestrator-tools.ts) —
 * both the approval exception and the check that blocks a proposed name have to look at the
 * same string (#93).
 */
export { ORCHESTRATOR_MCP_NAME }

export function orchestratorMcp(tools: OrchestratorTools, profile: ToolProfile = 'orchestrator', sessionId?: string) {
  return createSdkMcpServer({
    name: ORCHESTRATOR_MCP_NAME,
    version: '1',
    /*
     * **Do not defer.**
     *
     * By default the SDK defers MCP tools behind tool search (ToolSearch). Measured: because of
     * that, the orchestrator would look up and call only `list_sessions`, never even see
     * `send_to_session`, and end the turn silently — it read the list and never handed out the
     * work.
     *
     * For the orchestrator these tools are not a side feature; they are the reason it exists.
     */
    alwaysLoad: true,
    instructions:
      profile === 'manager' ? MANAGER_INSTRUCTIONS
      : profile === 'scoped' ? SCOPED_INSTRUCTIONS
      : profile === 'builder' ? BUILDER_INSTRUCTIONS
      : ORCHESTRATOR_INSTRUCTIONS,
    // Only expose what the profile allows (#69) — the execution side re-checks the same rule.
    // App tools (#81) join the same list: execution routes through runOrchestratorTool's registry either way.
    tools: [
      ...ORCHESTRATOR_TOOLS.filter((t) => profileAllows(profile, t.name)),
      ...appToolEntries(profile),
    ].map((t) =>
      tool(t.name, t.description, t.schema.shape, async (args: Record<string, unknown>) =>
        // Served by the host itself, so a planned swap waits for it, within a bound (#280, drain.ts)
        hostDrain
          .track(`tool ${ORCHESTRATOR_MCP_NAME}/${t.name}`, async () => {
            const r = await runOrchestratorTool(tools, t.name, args, { sessionId: sessionId ?? null, profile })
            return { content: [{ type: 'text' as const, text: r.text }], isError: r.isError }
          })
          .catch((e: unknown) => {
            if (e instanceof DrainCut) return drainToolResult(e)
            throw e
          }),
      ),
    ),
  })
}
