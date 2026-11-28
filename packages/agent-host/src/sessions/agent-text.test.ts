import { describe, expect, it } from 'vitest'
import type { AdapterCapabilities, ToolName } from '@cc/protocol'
import type { ToolProfile } from '../apps/contract.js'
import type { CentraluTools, CreateSessionOpts, SessionApps } from '../adapters/contract.js'
import { cursorProfile } from '../adapters/cursor-agent/index.js'
import { openCodeProfile } from '../adapters/opencode/index.js'
import { antigravityProfile } from '../adapters/antigravity/index.js'
import { ClaudeAdapter } from '../adapters/claude/index.js'
import { claudeQueryOptions } from '../adapters/claude/sdk-query.js'
import { ClaudeServers } from '../adapters/claude/session-servers.js'
import { CodexAdapter } from '../adapters/codex/index.js'
import { startThreadParams } from '../adapters/codex/thread-open.js'
import type { AcpProfile } from '../adapters/acp/profile.js'
import { createAdapters } from '../adapters/registry.js'
import { agentTextOf, joinedAgentText, servedInstructions, TOOLS_HEADING } from './agent-text.js'
import { REPO_WORK_FIRST, RESIDENT_BUDGET_CHARS } from './centralu-tools.js'
import { residentCost, TOOL_PROFILES } from './tool-cost.js'

/**
 * Every tool is told the same text for the same session (`agentTextOf`), read here from each adapter's own transport:
 * Claude's query options and in-process server, Codex's `thread/start`, an ACP tool's `_meta`. A tool told less is
 * named below with its reason, and nothing else may differ.
 */
const TOLD_NOTHING: Partial<Record<ToolName, string>> = {
  'cursor-agent': 'its ACP server takes no system prompt; whether it shows MCP instructions is unmeasured (#2479)',
  opencode: 'its ACP server takes no system prompt; whether it shows MCP instructions is unmeasured (#2479)',
}

const acpTold = (profile: AcpProfile) => (opts: CreateSessionOpts) => {
  const meta = profile.shape?.sessionMeta?.(opts) as { antigravity?: { systemPrompt?: { append?: string } } } | undefined
  return meta?.antigravity?.systemPrompt?.append
}

/** The instructions Claude's in-process server is made with, read from the SDK's own server */
function claudeServerInstructions(opts: CreateSessionOpts): string | undefined {
  const servers = new ClaudeServers({ sessionId: opts.sessionId, opts })
  servers.load()
  return (servers.centraluToolsServer as unknown as { instance: { server: { _instructions?: string } } } | null)?.instance.server._instructions
}

/** What each tool's transport hands its agent for these options, as one string (Claude's two parts joined for comparing) */
const TOOLS: { name: ToolName; capabilities: AdapterCapabilities; told: (opts: CreateSessionOpts) => string | undefined }[] = [
  {
    name: 'claude',
    capabilities: new ClaudeAdapter().capabilities,
    told: (opts) => {
      const query = claudeQueryOptions({
        sessionId: opts.sessionId,
        opts,
        executablePath: undefined,
        servers: {},
        permissionOptions: { permissionMode: 'default' },
        codeIntelligence: {},
        spawn: () => {
          throw new Error('not started')
        },
        canUseTool: () => Promise.resolve({ behavior: 'deny' as const, message: '' }),
      }) as { systemPrompt?: { append?: string } }
      return joinedAgentText({ role: query.systemPrompt?.append, tools: claudeServerInstructions(opts) })
    },
  },
  {
    name: 'codex',
    capabilities: new CodexAdapter().capabilities,
    told: (opts) => startThreadParams(opts, {}, {}).developerInstructions as string | undefined,
  },
  ...[cursorProfile(), openCodeProfile(), antigravityProfile()].map((p) => ({ name: p.descriptor.name, capabilities: p.capabilities, told: acpTold(p) })),
]

const SEATS: { seat: string; profile: ToolProfile; role?: string; apps?: boolean }[] = [
  { seat: 'the Assistant', profile: 'assistant', role: 'The Assistant role.' },
  { seat: "an app's builder", profile: 'builder', role: 'The builder role.' },
  { seat: 'a coordinator', profile: 'scoped', role: 'The coordinator role.' },
  { seat: 'a session in a project', profile: 'reader' },
  // An app attached at the start adds the line on repository work (#957), so a tool that dropped the apps would differ
  { seat: 'a session in a project with an app', profile: 'reader', apps: true },
]

const withAnApp: SessionApps = {
  current: () => [{ name: 'board', server: 'app-board', appId: 'board', tools: null }],
  noteCall: () => {},
  callEnded: () => {},
  cancelAll: () => {},
  close: () => {},
}

const optsFor = (profile: ToolProfile, role: string | undefined, apps = false): CreateSessionOpts => ({
  sessionId: 's1',
  cwd: '/work',
  permissionPreset: 'normal',
  centraluTools: {} as CentraluTools,
  centraluBridge: { url: 'ws://127.0.0.1:0', token: 'tok' },
  toolProfile: profile,
  ...(role ? { systemPromptAppend: role } : {}),
  ...(apps ? { apps: withAnApp } : {}),
})

describe('every tool is told the same text for a seat', () => {
  it('covers every tool there is', () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual([...createAdapters().keys()].sort())
  })

  describe.each(SEATS)('$seat', ({ profile, role, apps }) => {
    it.each(TOOLS)('$name', ({ name, capabilities, told }) => {
      const opts = optsFor(profile, role, apps)
      const want = TOLD_NOTHING[name] ? undefined : joinedAgentText(agentTextOf(opts, capabilities.subagentTool))
      expect(told(opts)).toBe(want)
      if (want) expect(want.includes(REPO_WORK_FIRST)).toBe(!!apps)
    })
  })

  it('names the tool its own subagent tool, the one word that differs', () => {
    for (const { name, capabilities, told } of TOOLS) {
      if (!capabilities.subagentTool) continue
      expect(told(optsFor('reader', undefined)), name).toContain(`not your ${capabilities.subagentTool} tool`)
    }
  })

  it('heads the tools part of a single text with the one heading, and Claude with none of its own', () => {
    const opts = optsFor('reader', 'A role.')
    for (const { name, told } of TOOLS.filter((t) => t.name === 'codex' || t.name === 'antigravity')) {
      expect(told(opts), name).toContain(`A role.\n\n${TOOLS_HEADING}\n\n`)
    }
    const instructions = claudeServerInstructions(opts)
    expect(instructions).toBe(agentTextOf(opts, 'Agent').tools)
    expect(instructions).not.toContain(TOOLS_HEADING)
  })

  it('tells a session with no Centralu tools its role alone, and one with neither nothing', () => {
    for (const { name, capabilities, told } of TOOLS) {
      if (TOLD_NOTHING[name]) continue
      const bare: CreateSessionOpts = { sessionId: 's1', cwd: '/work', permissionPreset: 'normal' }
      expect(told(bare), name).toBeUndefined()
      expect(told({ ...bare, systemPromptAppend: 'Only a role.' }), name).toBe('Only a role.')
      expect(capabilities.roleText, name).not.toBe(false)
    }
  })

  it('declares no channel where it tells nothing, so a session demanding role text is refused there', () => {
    for (const { name, capabilities } of TOOLS) {
      expect(capabilities.instructionChannel === undefined, name).toBe(!!TOLD_NOTHING[name])
      expect(capabilities.roleText === false, name).toBe(!!TOLD_NOTHING[name])
    }
  })
})

describe('the cost measure counts the instructions a tool is told', () => {
  it.each(TOOLS)('$name, and each profile stays within its ceiling there', ({ name, capabilities, told }) => {
    for (const profile of TOOL_PROFILES) {
      // With no role, the single text is the tools' part alone
      const opts = optsFor(profile, undefined)
      const sent = name === 'claude' ? claudeServerInstructions(opts) : told(opts)
      expect(servedInstructions(profile, capabilities), `${name} ${profile}`).toBe(sent ?? '')
      const cost = residentCost(profile, capabilities)
      expect(cost.residentChars + cost.instructionsChars, `${name} ${profile}`).toBeLessThanOrEqual(RESIDENT_BUDGET_CHARS[profile])
    }
  })
})
