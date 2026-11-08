import { describe, expect, it } from 'vitest'
import type { ModelOption } from '@cc/protocol'
import type { AgentAdapter } from '../adapters/contract.js'
import { managerWorld, projectDirs } from './manager.test-helpers.js'

/**
 * A model set by its full id stays that id (#1989): a pin must not move to an alias (`opus`) that may later name another model.
 * Only the screen reads it as the list's entry (`listedModel`).
 * It passes on main by design: it guards the owner's decision (#1989), which is also why the issue's wish that the Assistant's
 * descriptions name the list's id is dropped (ids are stored as given).
 */
describe('a model set by its full id', () => {
  const dir = projectDirs()

  it('is stored as given when a session is created with it or its settings change, though the list names it by an alias', async () => {
    const world = managerWorld()
    const entry = (id: string): ModelOption => ({ id, label: id, efforts: ['low'], defaultEffort: null, tiers: [], resolved: 'claude-opus-5-5' })
    ;(world.adapter as AgentAdapter).listModels = async () => [entry('default'), entry('opus')]
    const projectId = ((await world.rpc('projects.add', { path: dir('listed-model-') })) as { id: string }).id
    const create = (model: string) => world.rpc('agents.createSession', { projectId, cwd: dir('listed-model-'), tool: 'claude', model }) as Promise<{ id: string; model: string }>
    const made = await create('claude-opus-5-5')
    expect(made.model).toBe('claude-opus-5-5')

    const other = await create('opus')
    await world.rpc('agents.updateSettings', { sessionId: other.id, model: 'claude-opus-5-5' })
    expect(world.mgr.listSessions().find((s) => s.id === other.id)?.model).toBe('claude-opus-5-5')
    expect(world.events.filter((e) => e.type === 'settings_changed').at(-1)).toMatchObject({ model: 'claude-opus-5-5' })
  })
})
