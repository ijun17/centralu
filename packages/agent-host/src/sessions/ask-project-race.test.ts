import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { crossWorld, type CrossWorld } from './cross-project.test-helpers.js'

/**
 * Two ask_project calls with a task to the same session at once (#839, item 3). Both read "no task given there" before
 * their consent was settled; the one that went second found the first's turn its own caller's, so not busy, and
 * started a delegation over the first's: the first call's wait was replaced, and the second task went in as a note.
 */
describe('two asks with a task into one session at once (#839)', () => {
  let w: CrossWorld
  beforeEach(async () => {
    w = await crossWorld()
  })
  afterEach(async () => {
    await w.dispose()
  })

  const handleOf = (id: string) => w.adapters.get('claude')!.handles.get(id)!

  it('the second is refused as the caller\'s last task still running, and the first gets its answer', async () => {
    const t = (await w.mgr.createSession({ projectId: w.target.id, cwd: w.target.path, tool: 'claude', permissionPreset: 'normal' })).id
    handleOf(t).externalId = 'ext-t'
    const s = await w.callerSession()
    w.store.permissions.setProjectConsent(w.caller.id, w.target.id, 'delegate')
    // Neither awaited before the other starts: both are past their first checks when the consent is read
    const first = w.mgr.askProject(s, { project: w.target.name, session: t, task: 'export the sprites' })
    const second = w.mgr.askProject(s, { project: w.target.name, session: t, task: 'export the sounds' })
    let secondSettled = false
    void second.then(() => (secondSettled = true))
    // Both calls are past their consent once the second has an answer or a task went in for it
    await w.until(() => secondSettled || handleOf(t).sent.length > 1)
    expect(handleOf(t).sent).toHaveLength(1)
    expect(handleOf(t).sent[0]).toContain('export the sprites')
    const r2 = await second
    expect(!r2.ok && r2.error).toContain('is still working on your last task')
    handleOf(t).answer('Sprites exported.')
    expect(await first).toMatchObject({ ok: true, state: 'done', sessionId: t, answer: 'Sprites exported.' })
  })
})
