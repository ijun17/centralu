import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AdapterCapabilities, ToolDescriptor } from '@cc/protocol'
import { AcpAdapter } from '../acp/adapter.js'
import type { AcpProfile } from '../acp/profile.js'
import { ORCHESTRATOR_MCP_NAME } from '../../apps/contract.js'
import type { DetectResult } from '../contract.js'
import { findCursor } from './install.js'
import { CURSOR_SURFACE } from './surface.js'

const exec = promisify(execFile)

/**
 * What Cursor through ACP can keep (docs/plans/acp-adapter.md §7). Measured on agent 2026.10.22-27dcf5f, or read in its
 * bundle where said: no `usage_update` (bundle), so no context share is shown rather than a guessed one. It writes files
 * without asking, inside the folder or outside it, whatever the client advertises (`fs.writeTextFile` included: it calls no
 * `fs/*` method and sends no `session/request_permission` for a write, measured on Windows and macOS), and asks only for
 * commands and deletes: so Safe, Normal and Edits, which ask before a change, cannot be kept, and it runs under Auto only
 * (owner to decide whether Cursor stays offered so); nothing keeps it from reading `.cursor/rules` and `AGENTS.md`, so trusted
 * projects only; ACP has no field for Centralu's role text, so it cannot be the orchestrator, a coordinator or an app's
 * agent yet.
 */
const CAPABILITIES: AdapterCapabilities = {
  approvals: true,
  contextUsage: 'none',
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
  presets: ['auto'],
  keepsRepoFilesOut: false,
  roleText: false,
}

const DESCRIPTOR: ToolDescriptor = {
  name: 'cursor-agent',
  label: 'Cursor',
  mark: '▲',
  install: "curl https://cursor.com/install -fsS | bash (Windows: irm 'https://cursor.com/install?win32=true' | iex)",
  login: 'agent login',
}

/**
 * Cursor asks about an MCP call titled `<server>-<tool>: <tool>` (measured: `centralu-recall: recall`, kind `other`, no
 * `rawInput`); its `tool_call` says only `MCP: tool`
 */
export function centraluToolOfCall(call: { title?: string | null }): string | null {
  const m = /^([\w-]+): ([\w-]+)$/.exec(call.title ?? '')
  return m?.[2] && m[1] === `${ORCHESTRATOR_MCP_NAME}-${m[2]}` ? m[2] : null
}

/** `agent status` costs a Node start (~2 s), and pickers ask on every open: one answer is reused this long */
const STATUS_FOR_MS = 60_000

export function cursorProfile(): AcpProfile {
  let status: { at: number; result: DetectResult } | null = null
  return {
    descriptor: DESCRIPTOR,
    capabilities: CAPABILITIES,
    surface: CURSOR_SURFACE,
    async launch() {
      const install = findCursor()
      return install ? { command: install.command, args: [...install.args, 'acp'], env: install.env } : null
    },
    async installedVersion() {
      return findCursor()?.version ?? null
    },
    centraluToolOf: centraluToolOfCall,
    async detect() {
      if (status && Date.now() - status.at < STATUS_FOR_MS) return status.result
      const install = findCursor()
      let result: DetectResult
      if (!install) {
        result = { tool: DESCRIPTOR.name, installed: false, loggedIn: false, detail: 'Cursor CLI not found (install it from https://cursor.com/cli)' }
      } else {
        // Measured: "✓ Logged in as <account>" or "Not logged in". The account is not repeated on screen
        const out = await exec(install.command, [...install.args, 'status'], { timeout: 20_000, windowsHide: true, env: { ...process.env, ...install.env } })
          .then((r) => r.stdout, (e: { stdout?: string }) => e.stdout ?? '')
        const loggedIn = /\bLogged in\b/.test(out) && !/Not logged in/i.test(out)
        result = { tool: DESCRIPTOR.name, installed: true, loggedIn, detail: loggedIn ? `agent ${install.version}` : `agent ${install.version} · login required` }
      }
      status = { at: Date.now(), result }
      return result
    },
  }
}

/** Cursor CLI through the generic ACP adapter (docs/plans/acp-adapter.md) */
export class CursorAgentAdapter extends AcpAdapter {
  readonly tool = 'cursor-agent'

  constructor() {
    super(cursorProfile())
  }
}
