import { describe, expect, it } from 'vitest'
import { ToolsMock } from '../packages/platform/src/mock/tools.js'
import { createAdapters } from '../packages/agent-host/src/adapters/registry.js'

/*
 * The mock cannot read the host's adapters (the platform package sits below the host), so what it says of a tool is a
 * copy. Held here, across both: a mock that grants Antigravity role text drew a first-run card and a new-app dialog
 * the real app never draws (#59, owner 2026-10-29).
 */
describe('the mock tools say what the real adapters say', () => {
  const mock = new ToolsMock(() => {})
  for (const [tool, adapter] of createAdapters()) {
    if (tool !== 'antigravity') continue
    it(`${tool}: role text, which decides the first-run card and the new-app dialog`, async () => {
      const said = await mock.agents.capabilities(tool)
      const real = adapter.capabilities
      expect(said.roleText ?? true).toBe(real.roleText ?? true)
    })
  }
})
