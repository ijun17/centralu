import type { CacheStats, ToolName, UsageHistory } from '@cc/protocol/client'
import type { AgentPort, MachineRef, UsageAnswer } from '../ports/index.js'

/** What the usage gauge reads (`agents.usage`): this computer's usage, each linked machine's, and the cache figures */
export class UsageMock {
  /** For tests: usage (supported=false also reproduces "could not fetch it") */
  usageState: UsageAnswer = {
    supported: true,
    usage: { plan: 'max', windows: [], daily: [] },
  }
  /** For tests: a linked machine's usage, by machine id (#82); a machine with none answers `usageState` */
  machineUsage: Record<string, UsageAnswer> = {}
  /**
   * For tests: one tool's own answer, keyed like the gauge's donuts (`<tool>` for this computer, `<machine>.<tool>` for a
   * linked machine); it wins over the two above. A tool that cannot report limits answers `supported: false`, as the host does
   */
  toolUsage: Record<string, UsageAnswer> = {}
  /** For tests: what a tool's answer becomes when it is asked to `settle` (the read that was in flight has finished); keyed as `toolUsage` */
  settledUsage: Record<string, UsageAnswer> = {}
  /** For tests: how long a settled ask takes to answer, as a read still going on would (ms) */
  settleDelayMs = 0
  /** For tests: every usage question, and which machine it went to (null: this computer) */
  usageCalls: { tool: ToolName; machine: string | null; settle: boolean }[] = []
  /**
   * For tests: the prompt cache figures a host would count, keyed like the gauge's donuts: `<tool>` for this computer,
   * `<machine>.<tool>` for a linked machine. None: the answer carries no `cache`, as an older host's does
   */
  cacheStats: Record<string, CacheStats> = {}
  /** For tests: what the host stored over time (`usage.history`); the same answer for every question */
  usageHistoryState: UsageHistory = { by: 'session', readings: [], rows: [] }
  /** For tests: every usage history question, and which machine it went to (null: this computer) */
  usageHistoryCalls: { by: string; groupBy: string; machine: string | null }[] = []
  readonly agents: Pick<AgentPort, 'usage' | 'usageHistory'> = {
    usageHistory: async (range, machine) => {
      this.usageHistoryCalls.push({ by: range.by, groupBy: range.groupBy, machine: machine ?? null })
      return { ...this.usageHistoryState, by: range.by }
    },
    usage: async (tool: ToolName, machine?: MachineRef, opts?: { settle?: boolean }) => {
      this.usageCalls.push({ tool, machine: machine ?? null, settle: opts?.settle === true })
      if (opts?.settle && this.settleDelayMs > 0) await new Promise((r) => setTimeout(r, this.settleDelayMs))
      const key = machine ? `${machine}.${tool}` : tool
      const cache = this.cacheStats[key]
      const answer = (opts?.settle && this.settledUsage[key]) || this.toolUsage[key] || ((machine && this.machineUsage[machine]) || this.usageState)
      return { ...answer, ...(cache ? { cache } : {}) }
    },
  }
}
