import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { crossWorld, type CrossWorld } from './cross-project.test-helpers.js'
import { SessionManager } from './manager.js'

/**
 * Two windows open the Assistant at once (#839, item 6). Each `orchestrator.get` read "none yet" and created one
 * while the other was still creating its own: two assistants, and the store's marker named only the second.
 */
describe('the Assistant asked for twice at once (#839)', () => {
  let w: CrossWorld
  beforeEach(async () => {
    w = await crossWorld()
  })
  afterEach(async () => {
    await w.dispose()
  })

  it('is created once, and both callers get it', async () => {
    const [a, b] = await Promise.all([w.mgr.assistant(), w.mgr.assistant()])
    expect(a.id).toBe(b.id)
    expect(w.mgr.listSessions().filter((s) => s.kind === 'orchestrator')).toHaveLength(1)
    expect(w.adapters.get('claude')!.handles.size).toBe(1)
    // Asked again afterwards, it is the same one
    expect((await w.mgr.assistant()).id).toBe(a.id)
  })
})

/**
 * #2133: a build before the rename named the role's session "Orchestrator". The next start names it "Assistant", so the screen shows the role's
 * name and mail to the old address is not delivered to it by name; a name the person gave it stays.
 */
describe('the role session an earlier build named (#2133)', () => {
  let w: CrossWorld
  beforeEach(async () => {
    w = await crossWorld()
  })
  afterEach(async () => {
    await w.dispose()
  })

  const restarted = async () => {
    const next = new SessionManager(w.store, w.adapters, () => {})
    const name = next.listSessions().find((s) => s.kind === 'orchestrator')?.name
    await next.tenure.disposeAll()
    return name
  }

  it('is named Assistant at the next start', async () => {
    const role = await w.mgr.assistant()
    w.mgr.rename(role.id, 'Orchestrator')
    expect(await restarted()).toBe('Assistant')
  })

  it('keeps a name the person gave it', async () => {
    const role = await w.mgr.assistant()
    w.mgr.rename(role.id, 'Helper')
    expect(await restarted()).toBe('Helper')
  })
})
