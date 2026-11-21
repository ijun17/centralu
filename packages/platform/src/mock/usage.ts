import type { CacheStats, ToolName, UsageHistory } from '@cc/protocol/client'
import type { AgentPort, MachineRef, UsageAnswer } from '../ports/index.js'

/** What the usage gauge reads (`agents.usage`): this computer's usage, each linked machine's, and the cache figures */
export class UsageMock {
  /** supported=false also reproduces "could not fetch it" */
  usageState: UsageAnswer = {
    supported: true,
    usage: { plan: 'max', windows: [], daily: [] },
  }
  /** By machine id (#82); a machine with none answers `usageState` */
  machineUsage: Record<string, UsageAnswer> = {}
  /** Keyed `<tool>` or `<machine>.<tool>`, like the gauge's donuts; wins over the two above */
  toolUsage: Record<string, UsageAnswer> = {}
  /** The answer once asked to `settle` (the read in flight finished); keyed as `toolUsage` */
  settledUsage: Record<string, UsageAnswer> = {}
  /** ms a settled ask takes, as a read still going on would */
  settleDelayMs = 0
  /** null: this computer */
  usageCalls: { tool: ToolName; machine: string | null; settle: boolean }[] = []
  /** Keyed as `toolUsage`; none: the answer carries no `cache`, as an older host's */
  cacheStats: Record<string, CacheStats> = {}
  /** The same answer for every question */
  usageHistoryState: UsageHistory = { by: 'session', readings: [], rows: [] }
  /** null: this computer */
  usageHistoryCalls: { by: string; groupBy: string; machine: string | null }[] = []
  usageHistoryError: string | null = null
  readonly agents: Pick<AgentPort, 'usage' | 'usageHistory'> = {
    usageHistory: async (range, machine) => {
      this.usageHistoryCalls.push({ by: range.by, groupBy: range.groupBy, machine: machine ?? null })
      if (this.usageHistoryError !== null) throw new Error(this.usageHistoryError)
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
