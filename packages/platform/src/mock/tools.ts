import type { AdapterCapabilities, ToolName, ToolStatus } from '@cc/protocol'
import type { AgentPort, MachineRef } from '../ports/index.js'

/** The agent tools the mock knows: what is detected, their models and capabilities, and the slash command list */
export class ToolsMock {
  /** The detected tools — kept outside so a test can build "a tool that is not logged in" */
  detected: ToolStatus[] = [
    {
      // eslint-disable-next-line agent/agent-adapter-checks -- Mock detection depicts this CLI's installed state.
      name: 'claude',
      label: 'Claude Code',
      mark: 'C',
      install: 'npm i -g @anthropic-ai/claude-code',
      login: 'claude auth login',
      installed: true,
      loggedIn: true,
      detail: 'mock 2.1.0',
    },
    {
      // eslint-disable-next-line agent/agent-adapter-checks -- Mock detection depicts this CLI's installed state.
      name: 'codex',
      label: 'Codex',
      mark: 'X',
      install: 'npm i -g @openai/codex',
      login: 'codex login',
      installed: true,
      loggedIn: true,
      detail: 'mock codex',
    },
  ]

  /** The mock's adapter catalogue follows the same data shape as the host registry, not branches in its ports. */
  private readonly mockToolProfiles = new Map<ToolName, {
    models: { id: string; label: string; efforts: string[]; defaultEffort: string | null; tiers: { id: string; name: string; description: string }[] }[]
    capabilities: Pick<AdapterCapabilities, 'verbosities' | 'exclusiveWriter' | 'toolDeferral' | 'instructionChannel' | 'processModel' | 'builtInSubagents' | 'peerMessaging'>
  }>([
    // eslint-disable-next-line agent/agent-adapter-checks -- Fixture catalogue supplies this CLI's model and capability data.
    ['claude', {
      models: [
        { id: 'sonnet', label: 'Sonnet', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: null, tiers: [] },
        { id: 'opus', label: 'Opus', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: null, tiers: [] },
        { id: 'fable', label: 'Fable', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: null, tiers: [] },
        { id: 'haiku', label: 'Haiku', efforts: [], defaultEffort: null, tiers: [] },
      ],
      capabilities: { verbosities: [], exclusiveWriter: false, toolDeferral: true, instructionChannel: 'server', processModel: 'per-session', builtInSubagents: true, peerMessaging: true },
    }],
    // eslint-disable-next-line agent/agent-adapter-checks -- Fixture catalogue supplies this CLI's model and capability data.
    ['codex', {
      models: [
        { id: 'gpt-5.6-terra', label: 'gpt-5.6-terra', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', tiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed, increased usage' }] },
        { id: 'gpt-5.6-terra-mini', label: 'gpt-5.6-terra-mini', efforts: [], defaultEffort: null, tiers: [] },
      ],
      capabilities: { verbosities: ['low', 'medium', 'high'], exclusiveWriter: true, toolDeferral: false, instructionChannel: 'developer', processModel: 'per-session', builtInSubagents: true, peerMessaging: false },
    }],
  ])

  firstRegisteredTool(): ToolName {
    const first = this.detected[0]?.name
    if (!first) throw new Error('no mock agent is registered')
    return first
  }
  /** For tests: the tools a linked machine has, by machine id (#82) */
  machineDetected: Record<string, ToolStatus[]> = {}

  /** For tests: the slash command list (ready=false also reproduces "the tool is not ready yet") */
  commandState: { ready: boolean; commands: { name: string; description: string; argumentHint: string }[] } =
    {
      ready: true,
      commands: [],
    }
  /** For tests: when set, the slash command list fails with this reason (a machine away, a call that timed out) */
  commandsError: string | null = null
  readonly agents: Pick<AgentPort, 'models' | 'commands' | 'capabilities' | 'detect'> = {
    models: async (tool: ToolName) => ({ supported: true, models: this.mockToolProfiles.get(tool)?.models ?? [] }),
    commands: async (_sessionId: string) => {
      if (this.commandsError !== null) throw new Error(this.commandsError)
      return { ...this.commandState }
    },
    capabilities: async (tool: ToolName): Promise<AdapterCapabilities> => ({
      approvals: true,
      contextUsage: 'exact',
      resume: true,
      autoTitle: true,
      attachments: ['image', 'file'],
      verbosities: [],
      exclusiveWriter: false,
      backgroundTasks: true,
      ...this.mockToolProfiles.get(tool)?.capabilities,
    }),
    /** A linked machine answers `machineDetected[machine]` when a test set one (#82), else what this computer has */
    detect: async (machine?: MachineRef) => (machine && this.machineDetected[machine]) || this.detected,
  }
}
