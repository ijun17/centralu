import type { AgentVersions, SleepPolicy } from '@cc/protocol/client'
import { atRest, runsOlderCli } from '@cc/protocol/client'
import type { AgentPort } from '../ports/index.js'
import type { MockClock } from './clock.js'
import type { SessionStore } from './session-store.js'
import type { ToolsMock } from './tools.js'
import type { BackgroundTasksMock } from './background-tasks.js'
import type { SessionsMock } from './sessions.js'
import type { Emit } from './event-bus.js'

/** The installed agent CLIs and the sleep policy (#297, #568) */
export class AgentVersionsMock {
  /** `autoApply` is the "move idle sessions" setting, on by default as on the host */
  agentVersions: AgentVersions = { installed: {}, autoApply: true, checkedAt: null }
  sleepPolicy: SleepPolicy = { afterMinutes: 15 }
  setInstalledVersions(installed: Record<string, string | null>): void {
    this.agentVersions = { ...this.agentVersions, installed: { ...installed }, checkedAt: this.clock.now() }
    this.emit({ type: 'agent_versions', status: { ...this.agentVersions, installed: { ...installed } } })
  }
  readonly agents: Pick<AgentPort, 'versions' | 'sleepPolicy' | 'setSleepPolicy' | 'setAutoApplyVersions' | 'applyVersions'> = {
    versions: async () => ({ ...this.agentVersions, installed: { ...this.agentVersions.installed } }),
    // The mock puts nothing to sleep itself
    sleepPolicy: async () => ({ ...this.sleepPolicy }),
    setSleepPolicy: async (afterMinutes: number | null) => {
      this.sleepPolicy = { afterMinutes }
      return { ...this.sleepPolicy }
    },
    setAutoApplyVersions: async (enabled: boolean) => {
      this.agentVersions = { ...this.agentVersions, autoApply: enabled }
      this.emit({ type: 'agent_versions', status: { ...this.agentVersions } })
      return { ...this.agentVersions }
    },
    /** As the host (#297): restarted when `atRest` (no turn, card or background work), else listed as busy */
    applyVersions: async () => {
      const restarted: string[] = []
      const busy: string[] = []
      for (const s of this.store.sessions.values()) {
        const to = this.agentVersions.installed[s.tool]
        const from = s.agentVersion
        if (!s.live || !to || !from || !runsOlderCli(from, to)) continue
        if (!atRest({ ...s, backgroundTasks: this.backgroundMock.backgroundOf(s.id) })) {
          busy.push(s.id)
          continue
        }
        this.sessionsMock.restarted.push(s.id)
        this.emit({ type: 'agent_version', sessionId: s.id, version: to })
        const label = this.toolsMock.detected.find((t) => t.name === s.tool)?.label ?? s.tool
        this.emit({ type: 'notice', sessionId: s.id, level: 'info', from: 'Centralu', label: 'agent update', text: `${label} restarted on ${to} (was ${from}). The conversation continues.` })
        restarted.push(s.id)
      }
      return { restarted, busy }
    },
  }

  constructor(
    private readonly clock: MockClock,
    private readonly emit: Emit,
    private readonly store: SessionStore,
    private readonly toolsMock: ToolsMock,
    private readonly backgroundMock: BackgroundTasksMock,
    private readonly sessionsMock: SessionsMock,
  ) {}
}
