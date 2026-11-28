import { setupOfDetection, type AdapterCapabilities, type ToolName, type ToolSetup, type ToolStatus } from '@cc/protocol/client'
import type { Emit } from './event-bus.js'
import type { AgentPort, MachineRef } from '../ports/index.js'

/** What the ACP-based tools declare on the real host: no role text, subagents or peer messaging */
const NO_ROLE_TEXT: Pick<AdapterCapabilities, 'verbosities' | 'exclusiveWriter' | 'toolDeferral' | 'processModel' | 'builtInSubagents' | 'peerMessaging' | 'roleText'> = { verbosities: [], exclusiveWriter: false, toolDeferral: false, processModel: 'per-session', builtInSubagents: false, peerMessaging: false, roleText: false }

/** The agent tools the mock knows: what is detected, their models and capabilities, and the slash command list */
export class ToolsMock {
  constructor(private readonly emit: Emit) {}
  setupCalls: { action: string; tool: ToolName; machine?: MachineRef }[] = []

  /** Open so a test can build "a tool that is not logged in" */
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
    capabilities: Pick<AdapterCapabilities, 'verbosities' | 'exclusiveWriter' | 'toolDeferral' | 'instructionChannel' | 'processModel' | 'builtInSubagents' | 'peerMessaging' | 'roleText'>
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
    // eslint-disable-next-line agent/agent-adapter-checks -- Fixture catalogue supplies this CLI's model and capability data.
    ['antigravity', { models: [], capabilities: { ...NO_ROLE_TEXT, instructionChannel: 'developer', roleText: true } }],
    // No role text on the real host (each adapter's `CAPABILITIES`); mock-capability-parity.test.ts holds them together
    // eslint-disable-next-line agent/agent-adapter-checks -- Fixture catalogue supplies these CLIs' model and capability data.
    ['cursor-agent', { models: [], capabilities: NO_ROLE_TEXT }],
    // eslint-disable-next-line agent/agent-adapter-checks -- Fixture catalogue supplies this CLI's model and capability data.
    ['opencode', { models: [], capabilities: { ...NO_ROLE_TEXT, instructionChannel: 'server' } }],
  ])

  firstRegisteredTool(): ToolName {
    const first = this.detected[0]?.name
    if (!first) throw new Error('no mock agent is registered')
    return first
  }
  /** By machine id (#82) */
  machineDetected: Record<string, ToolStatus[]> = {}

  /** `ready: false` stands for "the tool is not ready yet" */
  commandState: { ready: boolean; commands: { name: string; description: string; argumentHint: string }[] } =
    {
      ready: true,
      commands: [],
    }
  /** What a tool declares it cannot keep (`presets`, `keepsRepoFilesOut`, `roleText`) */
  capabilityLimits: Record<ToolName, Partial<AdapterCapabilities>> = {}
  commandsError: string | null = null
  /** Moves a tool to a setup and tells the app, as the host's `tool_setup` event does; detect answers it from then on */
  private setSetup(tool: ToolName, setup: ToolSetup, machine?: MachineRef): ToolSetup {
    const list = (machine && this.machineDetected[machine]) || this.detected
    const t = list.find((x) => x.name === tool)
    if (t) {
      t.setup = setup
      t.installed = setup.state !== 'not_installed' && setup.state !== 'installing'
      t.loggedIn = setup.state === 'ready' || setup.state === 'unknown'
    }
    if (!machine) this.emit({ type: 'tool_setup', tool, setup })
    return setup
  }
  private setupOf(tool: ToolName, machine?: MachineRef): ToolSetup {
    const t = ((machine && this.machineDetected[machine]) || this.detected).find((x) => x.name === tool)
    return t?.setup ?? setupOfDetection(t?.installed ?? false, t?.loggedIn ?? false)
  }
  readonly agents: Pick<AgentPort, 'models' | 'commands' | 'capabilities' | 'detect' | 'installTool' | 'cancelInstallTool' | 'signInTool' | 'cancelSignInTool'> = {
    installTool: async (tool: ToolName, machine?: MachineRef) => {
      this.setupCalls.push({ action: 'install', tool, machine })
      return this.setSetup(tool, { ...this.setupOf(tool, machine), state: 'installing', failure: undefined, appFound: undefined, progress: { received: 0, total: 100 } }, machine)
    },
    cancelInstallTool: async (tool: ToolName, machine?: MachineRef) => {
      this.setupCalls.push({ action: 'cancelInstall', tool, machine })
      return this.setSetup(tool, { ...this.setupOf(tool, machine), state: 'not_installed', progress: undefined, failure: { reason: 'cancelled', message: 'Install cancelled' } }, machine)
    },
    signInTool: async (tool: ToolName) => {
      this.setupCalls.push({ action: 'signIn', tool })
      return this.setSetup(tool, { ...this.setupOf(tool), state: 'signing_in', failure: undefined })
    },
    cancelSignInTool: async (tool: ToolName) => {
      this.setupCalls.push({ action: 'cancelSignIn', tool })
      return this.setSetup(tool, { ...this.setupOf(tool), state: 'signed_out', failure: { reason: 'cancelled', message: 'Sign-in cancelled' } })
    },
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
      ...this.capabilityLimits[tool],
    }),
    /** A linked machine answers `machineDetected[machine]` when a test set one (#82), else what this computer has */
    detect: async (machine?: MachineRef) => (machine && this.machineDetected[machine]) || this.detected,
  }
}
