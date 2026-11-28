import { isAssistantKind, type AdapterCapabilities, type SessionInfo } from '@cc/protocol'
import { CENTRALU_MCP_NAME, type ToolProfile } from '../apps/contract.js'
import { toolProfileOf, type CreateSessionOpts } from '../adapters/contract.js'
import { assistantRole } from './assistant-home.js'
import { instructionsFor } from './tool-seats.js'

/** What a session's agent is told, the same on every tool: docs/agent-host/tool-profiles.md "What every tool is told" */
export type AgentText = { role?: string; tools?: string }

/**
 * A session's role at every start. The Assistant's carries the approved skills (#71) and, in a new process, the past
 * conversation. A builder's is written for its app as it is now; the row's copy serves when the app cannot be read, and
 * for a coordinator an older build made (#372).
 */
export function sessionRole(
  m: Pick<SessionInfo, 'kind' | 'roleAppend'>,
  parts: { skills: () => string; past: string; builder: () => string | null },
): string | undefined {
  if (isAssistantKind(m.kind)) return assistantRole() + parts.skills() + parts.past
  return parts.builder() ?? m.roleAppend ?? undefined
}

/** `subagentTool`: the one word that differs by tool. `served`: its Centralu tools reach the agent */
export function agentTextOf(opts: CreateSessionOpts, subagentTool: string | undefined, served = !!opts.centraluTools): AgentText {
  const role = opts.systemPromptAppend || undefined
  const tools = served ? instructionsFor(toolProfileOf(opts), undefined, (opts.apps?.current().length ?? 0) > 0, subagentTool) : undefined
  return { ...(role ? { role } : {}), ...(tools ? { tools } : {}) }
}

/** Names the server: the instructions name its tools bare, which the model sees prefixed or behind a call tool */
export const TOOLS_HEADING = `# How to use the ${CENTRALU_MCP_NAME} MCP server's tools`

/** The one text a tool that takes a single string is given (Codex's developer instructions, Antigravity's append) */
export function joinedAgentText({ role, tools }: AgentText): string | undefined {
  return [role, tools && `${TOOLS_HEADING}\n\n${tools}`].filter(Boolean).join('\n\n') || undefined
}

/**
 * The tool instructions the cost measure counts for a profile on a tool: `server` as they are (Claude Code heads them
 * itself, measured on CLI 2.1.289: "# MCP Server Instructions"), `developer` joined as above, none where absent.
 */
export function servedInstructions(profile: ToolProfile, capabilities: Pick<AdapterCapabilities, 'instructionChannel' | 'subagentTool'>): string {
  const tools = instructionsFor(profile, undefined, false, capabilities.subagentTool)
  if (capabilities.instructionChannel === 'server') return tools ?? ''
  if (capabilities.instructionChannel === 'developer') return joinedAgentText({ tools }) ?? ''
  return ''
}
