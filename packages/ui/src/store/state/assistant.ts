import type {
  ToolName,
} from '@cc/protocol/client'

/** The Assistant screen and its proposals (MCP servers, skills). */
export type AssistantSlice = {
  /** `propose_mcp_server` suggestions awaiting one-click approval; a copy of the host's list. */
  mcpProposals: { name: string; command: string; args: string[]; why?: string; at?: number }[]
  refreshMcpProposals(): Promise<void>
  resolveMcpProposal(name: string, approve: boolean): Promise<void>
  /** Skill suggestions (#71), the same rail */
  skillProposals: { name: string; content: string; why?: string; at?: number }[]
  refreshSkillProposals(): Promise<void>
  resolveSkillProposal(name: string, approve: boolean): Promise<void>
  /** `null` until the first question creates it */
  assistantId: string | null
  /** A session is being created for the first question (#63), so the empty screen does not look dead */
  assistantWaking: boolean
  /** The first-run intro was passed (#63); in the workspace snapshot. */
  introSeen: boolean
  /** Creates no session (#63); `askAssistant` does. */
  openAssistant(): Promise<void>
  /** Creates the session if there is none (#63). `false`: it was never born, and the caller puts the text back (#180). */
  askAssistant(text: string): Promise<boolean>
  /** Chosen before a session exists; kept here because the host holds it write-only (`assistant.configure`). */
  assistantTool: ToolName | null
  completeIntro(tool: ToolName): Promise<void>
  /**
   * Switches the session in place (`switchTool`), or records the choice for the first one. A failure is toasted and
   * returns `false`. When the session cannot be looked up, nothing is recorded: the host ignores it once one exists.
   */
  chooseAssistantTool(tool: ToolName): Promise<boolean>
}
