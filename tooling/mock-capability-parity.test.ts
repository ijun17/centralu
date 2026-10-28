import { describe, expect, it } from 'vitest'
import { ToolsMock } from '../packages/platform/src/mock/tools.js'
import { createAdapters } from '../packages/agent-host/src/adapters/registry.js'

/*
 * The mock cannot read the host's adapters (the platform package sits below the host), so what it says of a tool is a
 * copy. Held here, across both, for every tool the mock has a profile for: a mock that grants Antigravity role text drew
 * a first-run card and a new-app dialog the real app never draws (#59, owner 2026-10-28).
 *
 * Cursor and OpenCode have no mock profile and say the defaults (role text taken), where their adapters say it is not:
 * not held here until the mock gives them a profile.
 */
const PROFILED = ['claude', 'codex', 'antigravity']
const FIELDS = ['verbosities', 'exclusiveWriter', 'toolDeferral', 'instructionChannel', 'processModel', 'builtInSubagents', 'peerMessaging', 'roleText'] as const

describe('the mock tools say what the real adapters say', () => {
  const mock = new ToolsMock(() => {})
  for (const [tool, adapter] of createAdapters()) {
    if (!PROFILED.includes(tool)) continue
    it(`${tool}: the capabilities its mock profile declares`, async () => {
      const said = (await mock.agents.capabilities(tool)) as Record<string, unknown>
      const real = adapter.capabilities as Record<string, unknown>
      for (const f of FIELDS) expect([tool, f, said[f] ?? null]).toEqual([tool, f, real[f] ?? null])
    })
  }
})
