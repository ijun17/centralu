import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrchestratorTools } from '../adapters/contract.js'
import type { ToolProfile } from '../apps/contract.js'
import {
  COMMANDS_INSTRUCTION,
  ORCHESTRATOR_INSTRUCTIONS,
  ORCHESTRATOR_TOOLS,
  RARE_COMMANDS,
  commandsFor,
  instructionsFor,
  profileAllows,
  rareTierFrom,
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

const PROFILES: ToolProfile[] = ['orchestrator', 'manager', 'scoped', 'builder', 'reader']
const RARE = RARE_COMMANDS.orchestrator ?? []

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

describe('the switch', () => {
  it('is off unless CC_RARE_COMMANDS names a tier', () => {
    expect(rareTierFrom(undefined)).toBe('resident')
    expect(rareTierFrom('')).toBe('resident')
    expect(rareTierFrom('Commands')).toBe('resident')
    expect(rareTierFrom('commands')).toBe('commands')
    expect(rareTierFrom('deferred')).toBe('deferred')
  })

  it('leaves every profile as it was by default', () => {
    for (const p of PROFILES) {
      expect(toolDefsFor(p).map((t) => t.name)).toEqual(toolDefsFor(p, 'resident').map((t) => t.name))
      expect(toolDefsFor(p).some((t) => t.name.startsWith('centralu_'))).toBe(false)
    }
    expect(instructionsFor('orchestrator')).toBe(ORCHESTRATOR_INSTRUCTIONS)
  })
})

describe('the commands tier', () => {
  beforeEach(() => setRareTier('commands'))
  afterEach(() => setRareTier('resident'))

  it('takes the rare commands out of the orchestrator\'s tool list and puts the three fixed tools and one line in', () => {
    const names = toolDefsFor('orchestrator').map((t) => t.name)
    for (const c of RARE) expect(names).not.toContain(c)
    expect(names).toEqual(expect.arrayContaining(['centralu_commands', 'centralu_help', 'centralu_run', 'send_to_session', 'read_session', 'recall', 'create_session', 'app_guide']))
    expect(instructionsFor('orchestrator')).toBe(`${ORCHESTRATOR_INSTRUCTIONS}\n${COMMANDS_INSTRUCTION}`)
    // Smaller in every request: the point of the tier
    const commands = residentCost('orchestrator', 'claude')
    setRareTier('resident')
    const resident = residentCost('orchestrator', 'claude')
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
    // The other seats are as they were: the manager keeps its propose_worktree_session as a tool, and no seat but the orchestrator has the three
    expect(toolDefsFor('manager').map((t) => t.name)).toContain('propose_worktree_session')
    for (const p of ['manager', 'scoped', 'builder', 'reader'] as const) {
      expect(toolDefsFor(p).some((t) => t.name.startsWith('centralu_')), p).toBe(false)
      expect(profileAllows(p, 'centralu_run'), p).toBe(false)
    }
  })

  it('refuses a command outside the profile: not listed, not described, not run', async () => {
    const tools = fakeTools()
    const listed = await runOrchestratorTool(tools, 'centralu_commands', {}, orchestrator)
    for (const outside of ['delete_worktree_session', 'check', 'ask_project', 'send_to_session']) {
      expect(listed.text).not.toContain(`- ${outside}:`)
      const help = await runOrchestratorTool(tools, 'centralu_help', { command: outside }, orchestrator)
      expect(help.isError).toBe(true)
      const run = await runOrchestratorTool(tools, 'centralu_run', { command: outside, args: { sessionId: 'x' } }, orchestrator)
      expect(run.isError, outside).toBe(true)
      expect(run.text).toMatch(/No command "[a-z_]+" for this session/)
    }
    expect(tools.deleteWorktreeSession).not.toHaveBeenCalled()
    expect(tools.checkApp).not.toHaveBeenCalled()
    // A seat without the tier runs none of it, even by a caller that knows the names
    const manager = await runOrchestratorTool(tools, 'centralu_run', { command: 'propose_worktree_session', args: { branch: 'b' } }, { sessionId: 'm', profile: 'manager' })
    expect(manager).toMatchObject({ isError: true, text: 'Not a tool of this session: centralu_run' })
    // And the orchestrator no longer reaches the commands by their own names: what it was not shown, it cannot call
    for (const c of RARE) expect(profileAllows('orchestrator', c)).toBe(false)
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

describe('the deferred tier', () => {
  afterEach(() => setRareTier('resident'))

  it("defers the orchestrator's rare tools on Claude and nothing else changes", () => {
    setRareTier('deferred')
    const defs = toolDefsFor('orchestrator')
    expect(defs.filter((t) => 'deferred' in t && t.deferred).map((t) => t.name)).toEqual(ORCHESTRATOR_TOOLS.filter((t) => RARE.includes(t.name)).map((t) => t.name))
    expect(defs.map((t) => t.name)).toEqual(toolDefsFor('orchestrator', 'resident').map((t) => t.name))
    const cost = residentCost('orchestrator', 'claude')
    expect(cost.deferredChars).toBeGreaterThan(3_500)
    // Codex has no deferral of ours: all of it counts
    expect(residentCost('orchestrator', 'codex').deferredChars).toBe(0)
    for (const p of ['manager', 'scoped', 'builder'] as const) expect(residentCost(p, 'claude').deferredChars, p).toBe(0)
  })
})
