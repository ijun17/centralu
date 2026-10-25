import { tmpdir } from 'node:os'
import { beforeEach, describe, expect, it } from 'vitest'
import { managerWorld } from './manager.test-helpers.js'

/** A tool that reports only its conversation's running cost (OpenCode through ACP) keeps it across its processes */
describe("a conversation's running cost, as the launch hands it to the tool", () => {
  let world: ReturnType<typeof managerWorld>
  beforeEach(() => {
    world = managerWorld()
    Object.assign(world.codexAdapter.capabilities, { backgroundTasks: true })
  })

  it('starts a new conversation from nothing kept, and hands a resumed one the total its last process kept', async () => {
    const p = (await world.rpc('projects.add', { path: tmpdir() })) as { id: string }
    const s = (await world.rpc('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'codex' })) as { id: string }
    const first = world.codexAdapter.lastOpts?.runningCost
    expect(first?.last).toBeNull()
    first?.keep(0.4)

    expect(await world.mgr.sleepSession(s.id)).toBe(true)
    await world.mgr.resumeSession(s.id)
    expect(world.codexAdapter.lastOpts?.runningCost?.last).toBe(0.4)
    expect(world.store.settings.appSetting(`running_cost:${s.id}`)).toBe('0.4')
  })
})
