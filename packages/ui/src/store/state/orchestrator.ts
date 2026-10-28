import type {
  ToolName,
} from '@cc/protocol/client'

/** The orchestrator screen and its proposals (MCP servers, skills). */
export type OrchestratorSlice = {
  /**
   * The orchestrator's MCP server suggestion (`propose_mcp_server` → the person's one-click approval
   * → the app registers it and restarts the orchestrator). The list here is a copy; the host holds
   * the truth.
   */
  mcpProposals: { name: string; command: string; args: string[]; why?: string }[]
  refreshMcpProposals(): Promise<void>
  resolveMcpProposal(name: string, approve: boolean): Promise<void>
  /** The orchestrator's skill suggestion (#71) — the same suggest-then-one-click-approve rail */
  skillProposals: { name: string; content: string; why?: string }[]
  refreshSkillProposals(): Promise<void>
  resolveSkillProposal(name: string, approve: boolean): Promise<void>
  /** The orchestrator session id (`null` if never created — the screen shows an empty conversation plus suggested questions) */
  orchestratorId: string | null
  /** A session is being created for the first question (#63) — a flag so the empty screen does not look dead */
  orchestratorWaking: boolean
  /**
   * Whether the intro screen (orchestrator plus tool cards) has been passed (#63).
   * Kept in the workspace snapshot — this screen appears exactly once, on first run.
   */
  introSeen: boolean
  /**
   * Opens the orchestrator **screen**. Does not create a session (#63, deferred startup) — attaches
   * to one if it already exists, otherwise an empty conversation waits for the first question.
   * `askOrchestrator` is what creates it.
   */
  openOrchestrator(): Promise<void>
  /**
   * Asks the orchestrator something. **If there is no session, one is created at this moment** —
   * both the suggested-question cards and the empty screen's composer go through this door (#63).
   */
  /** Whether the first message reached the orchestrator — `false` means it was never born (the caller puts the text back, #180) */
  askOrchestrator(text: string): Promise<boolean>
  /**
   * The tool chosen for the orchestrator before it had a session (the intro's card, or Settings), kept here because the host
   * holds it write-only (`orchestrator.configure`). Once a session exists, its own tool is the truth.
   */
  orchestratorTool: ToolName | null
  /** Passes the intro screen (#63): records the tool choice with the host, and goes to the orchestrator screen */
  completeIntro(tool: ToolName): Promise<void>
  /**
   * Runs the orchestrator on `tool` (Settings). With a session, the session is switched in place (`switchTool`); without
   * one, the choice is recorded for the first question to be born with. A failure is toasted and answers `false`, so
   * the screen does not show a choice that was not made. The session is looked for on the host when this run has not
   * opened it; when that look fails, nothing is recorded (the host ignores a recorded choice once a session exists).
   */
  chooseOrchestratorTool(tool: ToolName): Promise<boolean>
}
