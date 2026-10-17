import { describe, expect, it } from 'vitest'
import { MockPlatform } from './index.js'

/**
 * A saved default model reaches the screen through `projects_changed` and a re-list, never by changing the object the
 * screen already holds (#1011 review): the host's answers are always new objects, and setTrusted swaps one in for the
 * same reason.
 */
describe('the mock project defaults', () => {
  it('a model chosen for a session leaves the project object add returned as it was', async () => {
    const m = new MockPlatform()
    const held = await m.projects.add('/tmp/defaults')
    const s = await m.agents.createSession({ projectId: held.id, cwd: held.path, tool: 'claude', permissionPreset: 'normal' })
    await m.agents.updateSettings(s.id, { model: 'opus', effort: 'high' })
    expect(held.defaultModels).toEqual({})
    expect((await m.projects.list()).find((p) => p.id === held.id)!.defaultModels.claude).toEqual({ model: 'opus', effort: 'high' })
  })
})
