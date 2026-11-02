import { describe, expect, it } from 'vitest'
import { ToolsMock } from '../packages/platform/src/mock/tools.js'
import { createAdapters } from '../packages/agent-host/src/adapters/registry.js'

/*
 * The mock cannot read the host's adapters (the platform package sits below the host), so what it says of a tool is a
 * copy. Held here, across both, for every registered tool: a mock that grants Antigravity role text drew a first-run card
 * and a new-app dialog the real app never draws (#59, owner 2026-10-28). A tool with no mock profile fails, it is not skipped (#1689).
 */
const FIELDS = ['verbosities', 'exclusiveWriter', 'toolDeferral', 'instructionChannel', 'processModel', 'builtInSubagents', 'peerMessaging', 'roleText'] as const

describe('the mock tools say what the real adapters say', () => {
  const mock = new ToolsMock(() => {})
  for (const [tool, adapter] of createAdapters()) {
    it(`${tool}: the capabilities its mock profile declares`, async () => {
      const said = (await mock.agents.capabilities(tool)) as Record<string, unknown>
      const real = adapter.capabilities as Record<string, unknown>
      for (const f of FIELDS) expect([tool, f, said[f] ?? null]).toEqual([tool, f, real[f] ?? null])
    })
  }
})
