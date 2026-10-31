import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrchestratorTools } from '../adapters/contract.js'
import type { ToolProfile } from '../apps/contract.js'
import {
  COMMANDS_INSTRUCTION,
  DEFAULT_RARE_TIER,
  ORCHESTRATOR_INSTRUCTIONS,
  ORCHESTRATOR_TOOLS,
  RARE_COMMANDS,
  commandsFor,
  instructionsFor,
  profileAllows,
  runOrchestratorTool,
  setRareTier,
  toolDefsFor,
} from './orchestrator-tools.js'
import { residentCost } from './tool-cost.js'

/**
 * The `commands` tier (#512): the orchestrator's rare commands leave its tool list and are reached through
 * centralu_commands / centralu_help / centralu_run. It changes how a seat reaches a command, never which
 * commands it may run: the tool matrix (docs/security-boundaries.md, tool-matrix.test.ts) still decides.
 */

const PROFILES: ToolProfile[] = ['orchestrator', 'scoped', 'builder', 'reader']
const RARE = RARE_COMMANDS.orchestrator ?? []
const DEFERRED_SERVER = { toolDeferral: true, instructionChannel: 'server' as const }

function fakeTools() {
  return {
    createApp: vi.fn(async () => ({ ok: true as const, appId: 'list', projectId: null, dir: '/apps/list' })),
    proposeSkill: vi.fn(async () => ({ ok: true })),
    proposeMcpServer: vi.fn(async () => ({ ok: true })),
    deleteWorktreeSession: vi.fn(async () => ({ ok: true })),
    checkApp: vi.fn(async () => ({ ok: true, text: 'checked' })),
  } as unknown as OrchestratorTools & Record<'createApp' | 'proposeSkill' | 'proposeMcpServer' | 'deleteWorktreeSession' | 'checkApp', ReturnType<typeof vi.fn>>
}

const orchestrator = { sessionId: 'orc', profile: 'orchestrator' as const }

describe('the tier', () => {
  it('is the commands tier (decision of 2026-10-12)', () => {
    expect(DEFAULT_RARE_TIER).toBe('commands')
  })

  it("changes only the orchestrator by default: every other seat is shown what the resident tier shows it", () => {
    for (const p of PROFILES) {
      if (p === 'orchestrator') continue
      expect(toolDefsFor(p).map((t) => t.name), p).toEqual(toolDefsFor(p, 'resident').map((t) => t.name))
      expect(toolDefsFor(p).some((t) => ['centralu_commands', 'centralu_help', 'centralu_run'].includes(t.name)), p).toBe(false)
      expect(instructionsFor(p), p).toBe(instructionsFor(p, 'resident'))
    }
    expect(toolDefsFor('orchestrator').map((t) => t.name)).toEqual(expect.arrayContaining(['centralu_commands', 'centralu_help', 'centralu_run']))
    expect(instructionsFor('orchestrator')).toBe(`${ORCHESTRATOR_INSTRUCTIONS}\n${COMMANDS_INSTRUCTION}`)
    expect(instructionsFor('orchestrator', 'resident')).toBe(ORCHESTRATOR_INSTRUCTIONS)
  })
})

describe('the commands tier', () => {
  beforeEach(() => setRareTier('commands'))
  afterEach(() => setRareTier(DEFAULT_RARE_TIER))

  it('takes the rare commands out of the orchestrator\'s tool list and puts the three fixed tools and one line in', () => {
    const names = toolDefsFor('orchestrator').map((t) => t.name)
    for (const c of RARE) expect(names).not.toContain(c)
    expect(names).toEqual(expect.arrayContaining(['centralu_commands', 'centralu_help', 'centralu_run', 'send_to_session', 'read_session', 'recall', 'create_session', 'app_guide']))
    expect(instructionsFor('orchestrator')).toBe(`${ORCHESTRATOR_INSTRUCTIONS}\n${COMMANDS_INSTRUCTION}`)
    // Smaller in every request: the point of the tier
    const commands = residentCost('orchestrator', DEFERRED_SERVER)
    setRareTier('resident')
    const resident = residentCost('orchestrator', DEFERRED_SERVER)
    expect(commands.residentChars + commands.instructionsChars).toBeLessThan(resident.residentChars + resident.instructionsChars - 2_000)
  })

  it('changes how, not who: a seat lists and runs exactly the commands its profile allows, and only these', async () => {
    const wrong: string[] = []
    for (const p of PROFILES) {
      const listed = new Set([...toolDefsFor(p).map((t) => t.name), ...commandsFor(p)])
      for (const t of ORCHESTRATOR_TOOLS) {
        if (listed.has(t.name) !== profileAllows(p, t.name, 'resident')) wrong.push(`${t.name} × ${p}`)
      }
    }
    expect(wrong).toEqual([])
    // The other seats are as they were: no seat but the orchestrator has the three
    for (const p of ['scoped', 'builder', 'reader'] as const) {
      expect(toolDefsFor(p).some((t) => t.name.startsWith('centralu_')), p).toBe(false)
      expect(profileAllows(p, 'centralu_run'), p).toBe(false)
    }
  })

  it('refuses a command outside the profile: not listed, not described, not run', async () => {
    const tools = fakeTools()
    const listed = await runOrchestratorTool(tools, 'centralu_commands', {}, orchestrator)
    for (const outside of ['check', 'ask_project', 'send_to_session']) {
      expect(listed.text).not.toContain(`- ${outside}:`)
      const help = await runOrchestratorTool(tools, 'centralu_help', { command: outside }, orchestrator)
      expect(help.isError).toBe(true)
      const run = await runOrchestratorTool(tools, 'centralu_run', { command: outside, args: { sessionId: 'x' } }, orchestrator)
      expect(run.isError, outside).toBe(true)
      expect(run.text).toMatch(/No command "[a-z_]+" for this session/)
    }
    expect(tools.checkApp).not.toHaveBeenCalled()
    // A seat without the tier runs none of it, even by a caller that knows the names
    const scoped = await runOrchestratorTool(tools, 'centralu_run', { command: 'create_app', args: { id: 'x', name: 'X' } }, { sessionId: 'm', profile: 'scoped' })
    expect(scoped).toMatchObject({ isError: true, text: 'Not a tool of this session: centralu_run' })
    // And the orchestrator no longer reaches the commands by their own names: what it was not shown, it cannot call
    for (const c of RARE) expect(profileAllows('orchestrator', c)).toBe(false)
  })

  // #853: the orchestrator starts children outside any project, through the commands, never as bare tools
  it('runs start_agent and agent_session for the orchestrator, whose answers name centralu_run', async () => {
    const working = { ok: true as const, state: 'working' as const, sessionId: 'c1', sessionName: 'Lookup', tool: 'claude', reported: true }
    const tools = { ...fakeTools(), startAgent: vi.fn(async () => working), agentSession: vi.fn(async () => working) } as unknown as OrchestratorTools
    const run = await runOrchestratorTool(tools, 'centralu_run', { command: 'start_agent', args: { task: 'look it up', wait: false } }, orchestrator)
    expect(run.isError).toBeFalsy()
    expect(tools.startAgent).toHaveBeenCalledWith({ task: 'look it up', wait: false }, undefined)
    expect(run.text).toContain('centralu_run(command="agent_session", args={sessionId: "c1", action: "wait"})')
    expect(run.text).not.toMatch(/(?<!")agent_session\(/)
    const bare = await runOrchestratorTool(tools, 'start_agent', { task: 'look it up' }, orchestrator)
    expect(bare).toMatchObject({ isError: true, text: expect.stringContaining('centralu_run(command="start_agent"') })
    // A reader names agent_session as it calls it
    const reader = await runOrchestratorTool(tools, 'start_agent', { task: 'look it up' }, { sessionId: 'r', profile: 'reader' })
    expect(reader.text).toContain('agent_session(sessionId="c1", action="wait")')
    // A coordinator or a builder has neither
    for (const profile of ['scoped', 'builder'] as const) {
      expect(await runOrchestratorTool(tools, 'start_agent', { task: 'x' }, { sessionId: 'm', profile })).toMatchObject({ isError: true })
      expect(await runOrchestratorTool(tools, 'centralu_run', { command: 'start_agent', args: { task: 'x' } }, { sessionId: 'm', profile })).toMatchObject({ isError: true })
    }
    expect(tools.startAgent).toHaveBeenCalledTimes(2)
  })

  // #1205: the orchestrator attaches a root app when it needs one; each answer names the next call in its own form
  it('runs find_apps, attach_app and detach_app for the orchestrator, whose answers name centralu_run', async () => {
    const tools = {
      ...fakeTools(),
      findApps: vi.fn(async () => ({ ok: true as const, apps: [{ ref: 'Board/board', name: 'Board', project: 'Board', description: 'Issues', tools: ['list'] }] })),
      attachApp: vi.fn(async () => ({ ok: true as const, server: 'app-board', tools: ['list'], when: 'now' as const })),
      detachApp: vi.fn(async () => ({ ok: true as const, server: 'app-board', when: 'now' as const })),
    } as unknown as OrchestratorTools
    // The instructions name it as a command, as they name the other rare ones: a bare call would be refused first
    expect(ORCHESTRATOR_INSTRUCTIONS).toContain('the find_apps command lists them')
    expect(ORCHESTRATOR_INSTRUCTIONS).not.toMatch(/: find_apps lists/)
    const found = await runOrchestratorTool(tools, 'centralu_run', { command: 'find_apps', args: {} }, orchestrator)
    expect(found.text).toContain('Attach one with centralu_run(command="attach_app", args={app: "<the name before ·>"})')
    const attached = await runOrchestratorTool(tools, 'centralu_run', { command: 'attach_app', args: { app: 'Board/board' } }, orchestrator)
    expect(attached.text).toContain('as the app-board server. Tools: mcp__app-board__list.')
    expect(attached.text).toContain('call centralu_run(command="detach_app", args={app: "Board/board"})')
    expect(await runOrchestratorTool(tools, 'centralu_run', { command: 'detach_app', args: { app: 'Board/board' } }, orchestrator)).toMatchObject({ text: 'Detached Board/board: the app-board tools are gone.' })
    // Not as bare tools, and a reader still calls them by name
    expect(await runOrchestratorTool(tools, 'attach_app', { app: 'Board/board' }, orchestrator)).toMatchObject({ isError: true, text: expect.stringContaining('centralu_run(command="attach_app"') })
    const reader = await runOrchestratorTool(tools, 'find_apps', {}, { sessionId: 'r', profile: 'reader' })
    expect(reader.text).toContain('Attach one with attach_app(app="<the name before ·>")')
    // A coordinator and a builder have none of them
    for (const profile of ['scoped', 'builder'] as const) {
      expect(await runOrchestratorTool(tools, 'find_apps', {}, { sessionId: 'm', profile })).toMatchObject({ isError: true })
    }
  })

  it('lists each command in one line, and narrows the list by a query', async () => {
    const tools = fakeTools()
    const all = await runOrchestratorTool(tools, 'centralu_commands', {}, orchestrator)
    expect(all.text.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2, l.indexOf(':')))).toEqual([...RARE])
    expect(all.text).not.toMatch(/\*\*|#\d+/)
    const some = await runOrchestratorTool(tools, 'centralu_commands', { query: 'skill' }, orchestrator)
    expect(some.text).toContain('- propose_skill:')
    expect(some.text).not.toContain('- create_app:')
    const none = await runOrchestratorTool(tools, 'centralu_commands', { query: 'zzz' }, orchestrator)
    expect(none.text).toMatch(/No command matches "zzz"; every command/)
  })

  it('describes a command with its schema', async () => {
    const help = await runOrchestratorTool(fakeTools(), 'centralu_help', { command: 'create_app' }, orchestrator)
    expect(help.isError).toBeFalsy()
    expect(help.text).toContain('Creates a new app')
    expect(help.text).toContain('"required":["id","name"]')
    expect(help.text).toContain('"additionalProperties":false')
  })

  it('answers a wrong run with the command\'s schema and runs nothing', async () => {
    const tools = fakeTools()
    const missing = await runOrchestratorTool(tools, 'centralu_run', { command: 'create_app', args: { name: 'Shopping list' } }, orchestrator)
    expect(missing.isError).toBe(true)
    expect(missing.text).toMatch(/^Wrong arguments for create_app: id: /)
    expect(missing.text).toContain('Its arguments (JSON schema): {')
    expect(missing.text).toContain('"required":["id","name"]')
    // A key the command does not take is wrong, not dropped: propose_mcp_server would otherwise propose a server with no arguments
    const extra = await runOrchestratorTool(tools, 'centralu_run', { command: 'propose_mcp_server', args: { name: 'pw', command: 'npx', arguments: ['-y', '@playwright/mcp'] } }, orchestrator)
    expect(extra.isError).toBe(true)
    expect(extra.text).toMatch(/Wrong arguments for propose_mcp_server: \(args\): Unrecognized key/)
    expect(tools.createApp).not.toHaveBeenCalled()
    expect(tools.proposeMcpServer).not.toHaveBeenCalled()
  })

  it('runs a valid command exactly as the tool runs it, arguments as JSON text included', async () => {
    const viaRun = fakeTools()
    const direct = fakeTools()
    const args = { name: 'pw', command: 'npx', args: ['-y', '@playwright/mcp@latest'], why: 'browser' }
    const a = await runOrchestratorTool(viaRun, 'centralu_run', { command: 'propose_mcp_server', args: JSON.stringify(args) }, orchestrator)
    const b = await runOrchestratorTool(direct, 'propose_mcp_server', args, orchestrator)
    expect(a).toEqual(b)
    expect(viaRun.proposeMcpServer.mock.calls).toEqual(direct.proposeMcpServer.mock.calls)
    // A tool the seat keeps is not a command: it is called as a tool
    const branch = await runOrchestratorTool(viaRun, 'centralu_run', { command: 'propose_worktree_session', args: { branch: 'feat/login-fix' } }, orchestrator)
    expect(branch.isError).toBe(true)
    expect(profileAllows('orchestrator', 'propose_worktree_session')).toBe(true)
  })
})

describe('usage_history (docs/agent-host.md §6.2)', () => {
  const history = { by: 'session' as const, readings: [], rows: [] }

  it('is a rare command of the orchestrator alone: listed in centralu_commands, not a tool in every request', async () => {
    expect(commandsFor('orchestrator')).toContain('usage_history')
    expect(toolDefsFor('orchestrator').map((t) => t.name)).not.toContain('usage_history')
    for (const p of ['scoped', 'builder', 'reader'] as const) expect(profileAllows(p, 'usage_history', 'resident'), p).toBe(false)
    const listed = await runOrchestratorTool(fakeTools(), 'centralu_commands', {}, orchestrator)
    expect(listed.text).toContain('- usage_history:')
  })

  it('asks the host for the last days by what was asked, within 1 to 90 days, and answers in words', async () => {
    const usageHistory = vi.fn(async (_spec: { days: number; by: string }) => history)
    const tools = { ...fakeTools(), usageHistory } as unknown as OrchestratorTools
    const run = (args: Record<string, unknown>) => runOrchestratorTool(tools, 'centralu_run', { command: 'usage_history', args }, orchestrator)
    expect((await run({})).text).toContain('Usage over the last 7 days on this computer, by session')
    await run({ days: 30, by: 'model' })
    await run({ days: 500 })
    // An unknown grouping does not match the command's schema and never reaches the host
    expect((await run({ by: 'nonsense' })).isError).toBe(true)
    await run({ days: -3 })
    expect(usageHistory.mock.calls.map((c) => c[0])).toEqual([
      { days: 7, by: 'session' },
      { days: 30, by: 'model' },
      { days: 90, by: 'session' },
      { days: 1, by: 'session' },
    ])
  })
})
