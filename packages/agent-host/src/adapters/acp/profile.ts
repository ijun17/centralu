import type { AdapterCapabilities, ToolDescriptor } from '@cc/protocol'
import type { AgentSpawnSpec, DetectResult } from '../contract.js'
import type { AdapterSurface } from '../contract/surface.js'

/**
 * Everything one tool adds to the generic ACP adapter (docs/plans/acp-adapter.md §2): the only place a tool is named.
 * Data and small hooks; the turn logic is the core's.
 */
export type AcpProfile = {
  readonly descriptor: ToolDescriptor
  readonly capabilities: AdapterCapabilities
  readonly surface: AdapterSurface
  /** How to start this tool's ACP server, or null when it is not installed here */
  launch(): Promise<Pick<AgentSpawnSpec, 'command' | 'args'> & { env?: Record<string, string> } | null>
  detect(): Promise<DetectResult>
  installedVersion(): Promise<string | null>
}
