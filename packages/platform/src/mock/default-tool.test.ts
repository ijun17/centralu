import { describe, expect, it } from 'vitest'
import { createMockPlatform } from './index.js'

// Detection returns every registered adapter, even when its CLI is not installed.
describe('mock registry defaults', () => {
  it('defaults projects and the orchestrator to the first registered tool even when a later CLI is installed', async () => {
    const mock = createMockPlatform()
    try {
      mock.detected[0] = { ...mock.detected[0]!, installed: false, loggedIn: false }
      expect(mock.detected[1]!.installed).toBe(true)
      expect((await mock.projects.add('/tmp/registry-default')).defaultTool).toBe(mock.detected[0]!.name)
      expect((await mock.agents.orchestrator()).tool).toBe(mock.detected[0]!.name)
    } finally {
      await mock.dispose()
    }
  })
})
