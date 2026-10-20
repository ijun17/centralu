import { describe, expect, it } from 'vitest'
import { createMockPlatform } from './index.js'

// Detection returns every registered adapter, even when its CLI is not installed.
describe('mock registry defaults', () => {
  it('defaults projects and the orchestrator to the first registered tool even when a later CLI is installed', async () => {
    const mock = createMockPlatform()
    try {
      mock.detected[0] = { ...mock.detected[0]!, installed: false, loggedIn: false }
      expect(mock.detected[1]!.installed).toBe(true)
      expect((await mock.projects.add('/tmp/registry-default')).defaultTool).toBe(mock.detected[0].name)
      expect((await mock.agents.orchestrator()).tool).toBe(mock.detected[0].name)
    } finally {
      await mock.dispose()
    }
  })

  it("a session on another tool moves the project's default and tells every window, as the host does", async () => {
    const mock = createMockPlatform()
    try {
      const events: string[] = []
      mock.agents.subscribe((e) => events.push(e.type))
      const p = await mock.projects.add('/tmp/default-moves')
      const other = mock.detected.find((t) => t.name !== p.defaultTool)!.name
      const start = (tool: typeof other) => mock.agents.createSession({ projectId: p.id, cwd: p.path, tool, permissionPreset: 'normal' })
      await start(other)
      expect((await mock.projects.list()).find((x) => x.id === p.id)!.defaultTool).toBe(other)
      expect(events.filter((t) => t === 'projects_changed')).toHaveLength(1)
      // The same tool again changes nothing, and says nothing
      await start(other)
      expect(events.filter((t) => t === 'projects_changed')).toHaveLength(1)
    } finally {
      await mock.dispose()
    }
  })
})
