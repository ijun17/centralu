import { describe, expect, it } from 'vitest'
import type { OrchestratorTools } from '../contract.js'
import { DEFAULT_RARE_TIER, RARE_COMMANDS, SCOPED_INSTRUCTIONS, setRareTier } from '../../sessions/orchestrator-tools.js'
import { orchestratorMcp } from './orchestrator-mcp.js'

/**
 * What the in-process server registers — read from the SDK's own server, the list `tools/list`
 * answers from. `_meta['anthropic/alwaysLoad']` is how the SDK marks a tool loaded rather than
 * deferred behind tool search (sdk.d.ts, `alwaysLoad`).
 */
function registered(profile: Parameters<typeof orchestratorMcp>[1]) {
  const server = orchestratorMcp({} as OrchestratorTools, profile, 'probe') as unknown as {
    instance: { _registeredTools: Record<string, { _meta?: Record<string, unknown> }>; server: { _instructions?: string } }
  }
  const tools = Object.fromEntries(
    Object.entries(server.instance._registeredTools).map(([name, t]) => [name, t._meta?.['anthropic/alwaysLoad'] === true ? 'loaded' : 'deferred']),
  )
  return { tools, instructions: server.instance.server._instructions }
}

describe('the Claude in-process server', () => {
  /*
   * The orchestrator measured that deferral made it never find send_to_session; the reader set
   * measured that it made recall go unused. Only app_guide, the rarely needed one, waits (#320).
   */
  it('loads the reader set except app_guide, and ask_project and find_apps with it, and sends it no instructions', () => {
    expect(registered('reader')).toEqual({
      tools: {
        read_session: 'loaded',
        recall: 'loaded',
        app_guide: 'deferred',
        ask_project: 'loaded',
        // Other agents here (#561): starting one is asked for in words, so loaded; its answer names agent_session
        start_agent: 'loaded',
        agent_session: 'deferred',
        // Another project's apps (#371 part A): find_apps loaded, since deferred it lost to ask_project (#522); its result names the next
        find_apps: 'loaded',
        attach_app: 'deferred',
        detach_app: 'deferred',
      },
      instructions: undefined,
    })
  })

  it('still loads every tool of the directing profiles, with their instructions', () => {
    for (const profile of ['orchestrator', 'scoped', 'builder'] as const) {
      const { tools } = registered(profile)
      expect(Object.values(tools).length, profile).toBeGreaterThan(0)
      expect(Object.values(tools).every((t) => t === 'loaded'), profile).toBe(true)
    }
    expect(registered('scoped').instructions).toBe(SCOPED_INSTRUCTIONS)
  })

  it("defers only the orchestrator's rare tools in the deferred tier, and serves the three fixed tools in the commands tier (#512)", () => {
    try {
      setRareTier('deferred')
      const deferred = registered('orchestrator').tools
      expect(Object.entries(deferred).filter(([, v]) => v === 'deferred').map(([k]) => k).sort()).toEqual([...(RARE_COMMANDS.orchestrator ?? [])].sort())
      expect(deferred.send_to_session).toBe('loaded')
      setRareTier('commands')
      const commands = registered('orchestrator')
      expect(Object.keys(commands.tools)).toEqual(expect.arrayContaining(['centralu_commands', 'centralu_help', 'centralu_run']))
      expect(Object.keys(commands.tools)).not.toContain('create_app')
      expect(Object.values(commands.tools).every((t) => t === 'loaded')).toBe(true)
      expect(commands.instructions).toContain('centralu_commands lists them')
    } finally {
      setRareTier(DEFAULT_RARE_TIER)
    }
  })
})
