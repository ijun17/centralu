import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AdapterCapabilities, ToolDescriptor } from '@cc/protocol'
import { AcpAdapter } from '../acp/adapter.js'
import type { AcpProfile } from '../acp/profile.js'
import type { DetectResult } from '../contract.js'
import { presetEnv } from './config.js'
import { findOpenCode } from './install.js'
import { OPENCODE_SURFACE } from './surface.js'

const exec = promisify(execFile)

/**
 * What OpenCode through ACP can keep (docs/plans/acp-adapter.md §7), measured on 1.19.4. Its `usage_update` is the
 * context in tokens and the model's window, so the share is exact. Every preset: Safe through its inline config
 * (`config.ts`). Nothing keeps it from reading `AGENTS.md` and the project's `opencode.json` (which can add plugins and
 * servers), so trusted projects only; ACP has no field for Centralu's role text, so it cannot be the orchestrator, a
 * coordinator or an app's agent yet. A second prompt during a turn is folded into it (measured), so input waits for
 * the turn's end instead (`midTurnInput: false`, the core's queue).
 */
const CAPABILITIES: AdapterCapabilities = {
  approvals: true,
  contextUsage: 'exact',
  resume: true,
  autoTitle: true,
  attachments: [],
  verbosities: [],
  exclusiveWriter: false,
  backgroundTasks: false,
  midTurnInput: false,
  gatesSteps: false,
  toolDeferral: false,
  instructionChannel: 'server',
  processModel: 'per-session',
  builtInSubagents: false,
  peerMessaging: false,
  sleep: false,
  keepsRepoFilesOut: false,
  roleText: false,
}

const DESCRIPTOR: ToolDescriptor = {
  name: 'opencode',
  label: 'OpenCode',
  mark: 'O',
  install: 'npm i -g opencode-ai (or: curl -fsSL https://opencode.ai/install | bash)',
  login: 'opencode auth login',
}

/** `opencode --version` is a cold start of a large binary (~1 s): one answer is reused this long */
const VERSION_FOR_MS = 60_000

export function openCodeProfile(): AcpProfile {
  let known: { at: number; version: string | null } | null = null
  const version = async (): Promise<string | null> => {
    if (known && Date.now() - known.at < VERSION_FOR_MS) return known.version
    const l = findOpenCode()
    const v = l ? await exec(l.command, [...l.args, '--version'], { timeout: 20_000, windowsHide: true }).then((r) => r.stdout.trim() || null, () => null) : null
    known = { at: Date.now(), version: v }
    return v
  }
  return {
    descriptor: DESCRIPTOR,
    capabilities: CAPABILITIES,
    surface: OPENCODE_SURFACE,
    infersCompaction: true,
    async launch(opts) {
      const l = findOpenCode()
      return l ? { command: l.command, args: [...l.args, 'acp'], env: presetEnv(opts.permissionPreset, process.env.OPENCODE_CONFIG_CONTENT) } : null
    },
    installedVersion: version,
    async detect(): Promise<DetectResult> {
      if (!findOpenCode()) return { tool: DESCRIPTOR.name, installed: false, loggedIn: false, detail: 'OpenCode not found (npm i -g opencode-ai)' }
      const v = await version()
      // Its own free models need no account (measured), and a provider's key is the person's OpenCode settings: there is
      // no state in which a session cannot start for want of a login
      return { tool: DESCRIPTOR.name, installed: true, loggedIn: true, detail: v ? `opencode ${v}` : 'opencode' }
    },
  }
}

/** OpenCode through the generic ACP adapter (docs/plans/acp-adapter.md) */
export class OpenCodeAdapter extends AcpAdapter {
  readonly tool = 'opencode'

  constructor() {
    super(openCodeProfile())
  }
}
