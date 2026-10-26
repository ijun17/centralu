import type { AdapterCapabilities, ToolDescriptor } from '@cc/protocol'
import type { AgentSpawnSpec, CreateSessionOpts, DetectResult } from '../contract.js'
import type { AdapterSurface } from '../contract/surface.js'
import type { ToolCallFields } from './wire.js'

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
}
