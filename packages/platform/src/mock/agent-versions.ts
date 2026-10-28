import type { AgentVersions, SleepPolicy } from '@cc/protocol/client'
import { liveBackgroundTasks, runsOlderCli } from '@cc/protocol/client'
import type { AgentPort } from '../ports/index.js'
import type { MockClock } from './clock.js'
import type { SessionStore } from './session-store.js'
import type { ToolsMock } from './tools.js'
import type { BackgroundTasksMock } from './background-tasks.js'
import type { SessionsMock } from './sessions.js'
import type { Emit } from './event-bus.js'

/** The installed agent CLIs and the sleep policy (#297, #568) */
export class AgentVersionsMock {
  /** The installed agent CLIs and the "move idle sessions" setting (#297) — on by default, like the host */
  agentVersions: AgentVersions = { installed: {}, autoApply: true, checkedAt: null }
  /** "Put idle sessions to sleep after" (#568), as the host keeps it */
  sleepPolicy: SleepPolicy = { afterMinutes: 15 }
  /** Scenario helper (#297): as if the host read these installed versions (used from Playwright) */
  setInstalledVersions(installed: Record<string, string | null>): void {
    this.agentVersions = { ...this.agentVersions, installed: { ...installed }, checkedAt: this.clock.now() }
    this.emit({ type: 'agent_versions', status: { ...this.agentVersions, installed: { ...installed } } })
  }
  readonly agents: Pick<AgentPort, 'versions' | 'sleepPolicy' | 'setSleepPolicy' | 'setAutoApplyVersions' | 'applyVersions'> = {
    // Like the host (#297): the reading is the host's; this mock never reads a real CLI
    versions: async () => ({ ...this.agentVersions, installed: { ...this.agentVersions.installed } }),
    // Like the host (#568): the setting is the host's, 15 minutes until changed; the mock puts nothing to sleep itself
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
    /**
     * Like the host (#297): a live session that runs an older CLI is restarted on the installed one when it is idle by
     * the shared rule (no turn, no approval or question, no background work), and listed as busy otherwise.
     */
    applyVersions: async () => {
      const restarted: string[] = []
      const busy: string[] = []
      for (const s of this.store.sessions.values()) {
        const to = this.agentVersions.installed[s.tool]
        const from = s.agentVersion
        if (!s.live || !to || !from || !runsOlderCli(from, to)) continue
        const holds =
          s.state === 'working' ||
          s.state === 'waiting_approval' ||
          s.pendingApproval !== null ||
          s.pendingQuestions.length > 0 ||
          liveBackgroundTasks(this.backgroundMock.backgroundOf(s.id)).length > 0
        if (holds) {
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
