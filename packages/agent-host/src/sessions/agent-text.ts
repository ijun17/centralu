import { isAssistantKind, type AdapterCapabilities, type SessionInfo } from '@cc/protocol'
import { CENTRALU_MCP_NAME, type ToolProfile } from '../apps/contract.js'
import { toolProfileOf, type CreateSessionOpts } from '../adapters/contract.js'
import { assistantRole } from './assistant-home.js'
import { instructionsFor, type RareTier } from './tool-seats.js'

/**
 * What a session's agent is told, the same for every tool (docs/agent-host/tool-profiles.md "What every tool is told"):
 * its role and the instructions of the Centralu tools it is served. An adapter decides only how each part travels.
 */
export type AgentText = { role?: string; tools?: string }

/**
 * A session's role, read at every start and wake. The Assistant's carries the person's approved skills (#71) and, in a
 * new process only, the past conversation (`past`). A builder's is written for its app as the app is now
 * (`AppSessions.builderRoleOf`); the role pinned on the row is for a builder whose app cannot be read, and a coordinator
 * an older build made (#372).
 */
export function sessionRole(
  m: Pick<SessionInfo, 'kind' | 'roleAppend'>,
  parts: { skills: () => string; past: string; builder: () => string | null },
): string | undefined {
  if (isAssistantKind(m.kind)) return assistantRole() + parts.skills() + parts.past
  return parts.builder() ?? m.roleAppend ?? undefined
}

/**
 * `subagentTool`: what the tool calls its own subagent tool (`AdapterCapabilities.subagentTool`), the one word that
 * differs by tool. `served`: the session's Centralu tools reach the agent (a tool served through the bridge needs it too).
 */
export function agentTextOf(opts: CreateSessionOpts, subagentTool: string | undefined, served = !!opts.centraluTools): AgentText {
  const role = opts.systemPromptAppend || undefined
  // An app attached as the session starts adds the line on repository work (#957, #992)
  const tools = served ? instructionsFor(toolProfileOf(opts), undefined, (opts.apps?.current().length ?? 0) > 0, subagentTool) : undefined
  return { ...(role ? { role } : {}), ...(tools ? { tools } : {}) }
}

/**
 * Over the tool instructions where they share one text with the role. The instructions name the tools bare; the model
 * sees them as `mcp__centralu__<tool>` (Codex) or through a call tool of its own (Antigravity), so it names the server.
 */
export const TOOLS_HEADING = `# How to use the ${CENTRALU_MCP_NAME} MCP server's tools`

/** The one text a tool that takes a single string is given (Codex's developer instructions, Antigravity's append) */
export function joinedAgentText({ role, tools }: AgentText): string | undefined {
  return [role, tools && `${TOOLS_HEADING}\n\n${tools}`].filter(Boolean).join('\n\n') || undefined
}

/**
 * The tool instructions a profile's agent receives on a tool, as `instructionChannel` carries them; each way rides in
 * every request. `server`: the server's own instructions, which Claude Code heads itself in the first user message
 * (measured, CLI 2.1.289: "# MCP Server Instructions"). `developer`: joined as above. Absent: none reach the model.
 */
export function servedInstructions(
  profile: ToolProfile,
  capabilities: Pick<AdapterCapabilities, 'instructionChannel' | 'subagentTool'>,
  tier?: RareTier,
): string {
  const tools = instructionsFor(profile, tier, false, capabilities.subagentTool)
  if (capabilities.instructionChannel === 'server') return tools ?? ''
  if (capabilities.instructionChannel === 'developer') return joinedAgentText({ tools }) ?? ''
  return ''
}
