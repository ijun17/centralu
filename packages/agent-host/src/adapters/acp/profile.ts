import type { AdapterCapabilities, ToolDescriptor } from '@cc/protocol'
import type { AgentSpawnSpec, CreateSessionOpts, DetectResult } from '../contract.js'
import type { AdapterSurface } from '../contract/surface.js'
import type { RequestPermission, ToolCallFields } from './wire.js'

/**
 * Everything one tool adds to the generic ACP adapter (docs/plans/acp-adapter.md §2): the only place a tool is named.
 * Data and small hooks; the turn logic is the core's.
 */
export type AcpProfile = {
  readonly descriptor: ToolDescriptor
  readonly capabilities: AdapterCapabilities
  readonly surface: AdapterSurface
  /** How to start this tool's ACP server for this session (its environment may carry the preset), or null when it is not installed here */
  launch(opts: CreateSessionOpts): Promise<Pick<AgentSpawnSpec, 'command' | 'args'> & { env?: Record<string, string> } | null>
  detect(): Promise<DetectResult>
  installedVersion(): Promise<string | null>
  /**
   * Which of Centralu's own tools a call is (the stdio bridge's, `ORCHESTRATOR_MCP_NAME`), by the way this tool names an
   * MCP call, or null. Such a call is answered without a card, as Claude and Codex take the bridge: each tool there carries
   * its own rights (#1562 review)
   */
  centraluToolOf?(call: ToolCallFields): string | null
  /** Its `/compact` leaves no protocol frame: the core reads Centralu's compact turn instead (`AcpSessionDeps.infersCompaction`) */
  readonly infersCompaction?: boolean
  /** The parts of a tool's ACP that differ from the common shape the core reads (`AcpToolShape`) */
  readonly shape?: AcpToolShape
}

/**
 * How one tool's ACP differs from the shape the core reads (#59, Antigravity's agent): hooks the core calls at fixed points,
 * each absent for a tool that speaks the common shape (Cursor, OpenCode).
 */
export type AcpToolShape = {
  /**
   * A call's fields in the shape the core reads: the command in `rawInput.command` and its folder in `rawInput.cwd`, an
   * edit's file in `rawInput.file_path`, the output in `rawOutput.output`. Applied to every `tool_call`, update and
   * permission request before the core reads it; the tool's own fields stay beside the added ones
   */
  readCall?(call: ToolCallFields): Partial<ToolCallFields>
  /** A permission request that is a question to the person (one option per answer), not an approval: asked as a question card */
  isQuestion?(req: RequestPermission): boolean
  /** A request refused under every preset and every saved rule, before any is read (Antigravity's subagents) */
  neverAllowed?(req: RequestPermission): boolean
  /**
   * A permitted edit runs as a new call (another id) and the asked one later ends `failed` though the edit ran (measured on
   * Antigravity 1.4.3): the core folds the new call into the asked one, so its card ends as the edit did
   */
  readonly editRunsAsNewCall?: boolean
  /**
   * The client reads files for the agent (`fs/read_text_file`, advertised as `fs.readTextFile`): inside the session's folder
   * only, and never under the folders this names (the agent's own home, which holds its token)
   */
  clientReads?: { refused(): readonly string[] }
  /** What `session/new`, `session/load` and `session/resume` carry as `_meta` (Antigravity's built-in tool filter) */
  sessionMeta?(): Record<string, unknown>
  /** The error for a conversation the tool refused as not signed in (`-32000`); the profile also notes the tool signed out */
  signedOut?(label: string): Error
  /** A line the tool wrote to stderr as it may reach host.log and a crash message: changed, or null to leave it out */
  stderrLine?(line: string): string | null
}
