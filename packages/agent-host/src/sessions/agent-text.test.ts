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
import { acpMcpServers } from '../adapters/acp/session.js'
import { createAdapters } from '../adapters/registry.js'
import { agentTextOf, joinedAgentText, servedInstructions, TOOLS_HEADING } from './agent-text.js'
import { REPO_WORK_FIRST, RESIDENT_BUDGET_CHARS } from './centralu-tools.js'
import { residentCost, TOOL_PROFILES } from './tool-cost.js'

/**
 * Every tool is told the same text for the same session (`agentTextOf`), read here from each adapter's own transport:
 * Claude's query options and in-process server, Codex's `thread/start`, an ACP tool's `_meta` and the bridge it is
 * given. A part a tool is not told is named below with its reason, and nothing else may differ.
 */
const TOLD_LESS: Partial<Record<ToolName, { role?: string; tools?: string }>> = {
  'cursor-agent': {
    role: 'its ACP server takes no system prompt (#2479)',
    tools: 'it does not show an MCP server its instructions (probe-acp-mcp-instructions.mts)',
  },
  opencode: { role: 'its ACP server takes no system prompt (#2479)' },
}

/**
 * What a transport hands the agent: `text`, its parts joined for comparing (Claude's two, an ACP tool's `_meta` or its
 * bridge's); `instructions`, the part the cost measure counts
 */
/** `text`: the role and tools as one text, the form the tools are compared in (a server's instructions get the heading here only); `instructions`: a server's own, as sent */
type Told = { text: string | undefined; instructions: string | undefined }

/** The instructions Claude's in-process server is made with, read from the SDK's own server */
function claudeServerInstructions(opts: CreateSessionOpts): string | undefined {
  const servers = new ClaudeServers({ sessionId: opts.sessionId, opts })
  servers.load()
  return (servers.centraluToolsServer as unknown as { instance: { server: { _instructions?: string } } } | null)?.instance.server._instructions
}

const acpTold = (profile: AcpProfile) => (opts: CreateSessionOpts): Told => {
  const meta = (profile.shape?.sessionMeta?.(opts) as { antigravity?: { systemPrompt?: { append?: string } } } | undefined)?.antigravity?.systemPrompt?.append
  const bridge = (acpMcpServers(opts, profile.capabilities) as { env: { name: string; value: string }[] }[])[0]
  const served = bridge?.env.find((e) => e.name === 'CC_BRIDGE_INSTRUCTIONS')?.value
  return { text: meta ?? joinedAgentText({ tools: served }), instructions: served ?? meta }
}

const TOOLS: { name: ToolName; capabilities: AdapterCapabilities; told: (opts: CreateSessionOpts) => Told }[] = [
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
      const instructions = claudeServerInstructions(opts)
      return { text: joinedAgentText({ role: query.systemPrompt?.append, tools: instructions }), instructions }
    },
  },
  {
    name: 'codex',
    capabilities: new CodexAdapter().capabilities,
    told: (opts) => {
      const text = startThreadParams(opts, {}, {}).developerInstructions as string | undefined
      return { text, instructions: text }
    },
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
      const text = agentTextOf(opts, capabilities.subagentTool)
      const less = TOLD_LESS[name] ?? {}
      const want = joinedAgentText({ role: less.role ? undefined : text.role, tools: less.tools ? undefined : text.tools })
      expect(told(opts).text).toBe(want)
      if (want && !less.tools) expect(want.includes(REPO_WORK_FIRST)).toBe(!!apps)
    })
  })

  it('names the tool its own subagent tool, the one word that differs', () => {
    for (const { name, capabilities, told } of TOOLS) {
      if (!capabilities.subagentTool) continue
      expect(told(optsFor('reader', undefined)).text, name).toContain(`not your ${capabilities.subagentTool} tool`)
    }
  })

  it('heads the tools part of a single text with the one heading, and a server\'s instructions with none of its own', () => {
    const opts = optsFor('reader', 'A role.')
    for (const { name, told } of TOOLS.filter((t) => t.name === 'codex' || t.name === 'antigravity')) {
      expect(told(opts).text, name).toContain(`A role.\n\n${TOOLS_HEADING}\n\n`)
    }
    for (const { name, capabilities, told } of TOOLS.filter((t) => t.name === 'claude' || t.name === 'opencode')) {
      expect(told(opts).instructions, name).toBe(agentTextOf(opts, capabilities.subagentTool).tools)
      expect(told(opts).instructions, name).not.toContain(TOOLS_HEADING)
    }
  })

  it('tells a session with no Centralu tools its role alone, and one with neither nothing', () => {
    for (const { name, capabilities, told } of TOOLS) {
      if (TOLD_LESS[name]?.role) continue
      const bare: CreateSessionOpts = { sessionId: 's1', cwd: '/work', permissionPreset: 'normal' }
      expect(told(bare).text, name).toBeUndefined()
      expect(told({ ...bare, systemPromptAppend: 'Only a role.' }).text, name).toBe('Only a role.')
      expect(capabilities.roleText, name).not.toBe(false)
    }
  })

  it('declares no channel for a part it is not told, so a session demanding role text is refused there', () => {
    for (const { name, capabilities } of TOOLS) {
      expect(capabilities.instructionChannel === undefined, name).toBe(!!TOLD_LESS[name]?.tools)
      expect(capabilities.roleText === false, name).toBe(!!TOLD_LESS[name]?.role)
    }
  })
})

describe('the cost measure counts the instructions a tool is told', () => {
  it.each(TOOLS)('$name, and each profile stays within its ceiling there', ({ name, capabilities, told }) => {
    for (const profile of TOOL_PROFILES) {
      // With no role, a single text is the tools' part alone
      const sent = told(optsFor(profile, undefined)).instructions
      expect(servedInstructions(profile, capabilities), `${name} ${profile}`).toBe(sent ?? '')
      const cost = residentCost(profile, capabilities)
      expect(cost.residentChars + cost.instructionsChars, `${name} ${profile}`).toBeLessThanOrEqual(RESIDENT_BUDGET_CHARS[profile])
    }
  })
})
