import type { UsageSnapshot, CacheStats, ToolName } from '@cc/protocol'
import type { AgentPort, MachineRef } from '../ports/index.js'

/** What the usage gauge reads (`agents.usage`): this computer's usage, each linked machine's, and the cache figures */
export class UsageMock {
  /** For tests: usage (supported=false also reproduces "could not fetch it") */
  usageState: { supported: boolean; reason?: string; usage: UsageSnapshot | null } = {
    supported: true,
    usage: { plan: 'max', windows: [], daily: [] },
  }
  /** For tests: a linked machine's usage, by machine id (#82); a machine with none answers `usageState` */
  machineUsage: Record<string, { supported: boolean; reason?: string; usage: UsageSnapshot | null; sameAccountAsHub?: boolean }> = {}
  /** For tests: every usage question, and which machine it went to (null: this computer) */
  usageCalls: { tool: ToolName; machine: string | null }[] = []
  /**
   * For tests: the prompt cache figures a host would count, keyed like the gauge's donuts: `<tool>` for this computer,
   * `<machine>.<tool>` for a linked machine. None: the answer carries no `cache`, as an older host's does
   */
  cacheStats: Record<string, CacheStats> = {}
  readonly agents: Pick<AgentPort, 'usage'> = {
    usage: async (tool: ToolName, machine?: MachineRef) => {
      this.usageCalls.push({ tool, machine: machine ?? null })
      const cache = this.cacheStats[machine ? `${machine}.${tool}` : tool]
      return { ...((machine && this.machineUsage[machine]) || this.usageState), ...(cache ? { cache } : {}) }
    },
  }
}
