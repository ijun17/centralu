import { describe, expect, it } from 'vitest'
import type { OrchestratorTools } from '../contract.js'
import { SCOPED_INSTRUCTIONS } from '../../sessions/orchestrator-tools.js'
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
  it('loads the reader set except app_guide, and ask_project with it, and sends it no instructions', () => {
    expect(registered('reader')).toEqual({
      tools: {
        read_session: 'loaded',
        recall: 'loaded',
        app_guide: 'deferred',
        ask_project: 'loaded',
        // Another project's apps, on demand (#371 part A): found through tool search, each result naming the next
        find_apps: 'deferred',
        attach_app: 'deferred',
        detach_app: 'deferred',
      },
      instructions: undefined,
    })
  })

  it('still loads every tool of the directing profiles, with their instructions', () => {
    for (const profile of ['orchestrator', 'manager', 'scoped', 'builder'] as const) {
      const { tools } = registered(profile)
      expect(Object.values(tools).length, profile).toBeGreaterThan(0)
      expect(Object.values(tools).every((t) => t === 'loaded'), profile).toBe(true)
    }
    expect(registered('scoped').instructions).toBe(SCOPED_INSTRUCTIONS)
  })
})
