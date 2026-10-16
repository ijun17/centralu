import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { crossWorld, type CrossWorld } from './cross-project.test-helpers.js'

/**
 * Two windows open the orchestrator at once (#839, item 6). Each `orchestrator.get` read "none yet" and created one
 * while the other was still creating its own: two orchestrators, and the store's marker named only the second.
 */
describe('the orchestrator asked for twice at once (#839)', () => {
  let w: CrossWorld
  beforeEach(async () => {
    w = await crossWorld()
  })
  afterEach(async () => {
    await w.dispose()
  })

  it('is created once, and both callers get it', async () => {
    const [a, b] = await Promise.all([w.mgr.orchestrator(), w.mgr.orchestrator()])
    expect(a.id).toBe(b.id)
    expect(w.mgr.listSessions().filter((s) => s.kind === 'orchestrator')).toHaveLength(1)
    expect(w.adapters.get('claude')!.handles.size).toBe(1)
    // Asked again afterwards, it is the same one
    expect((await w.mgr.orchestrator()).id).toBe(a.id)
  })
})
